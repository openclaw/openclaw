import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import * as outputFiles from "./output-files.js";
import { createDownloadCaptureForPage } from "./pw-download-capture.js";

describe("Playwright download capture cancellation", () => {
  it("awaits cancellation when owned download admission rejects", async () => {
    const page = new EventEmitter();
    const state = { downloadWaiterDepth: 0 };
    const rejection = new Error("download destination blocked by policy");
    const cancelGate = Promise.withResolvers<void>();
    const cancel = vi.fn(async () => await cancelGate.promise);
    const saveAs = vi.fn(async () => {});
    const capture = createDownloadCaptureForPage(page, state, 1_000, {
      mode: "explicit",
      beforeSave: async () => {
        throw rejection;
      },
      cancelOnBeforeSaveError: () => true,
    });
    const outcome = capture.promise.then(
      () => "resolved" as const,
      (error: unknown) => error,
    );

    page.emit("download", {
      url: () => "http://169.254.169.254/latest/meta-data/",
      suggestedFilename: () => "metadata.bin",
      saveAs,
      cancel,
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await expect(Promise.race([outcome, Promise.resolve("pending")])).resolves.toBe("pending");
    cancelGate.resolve();

    await expect(outcome).resolves.toBe(rejection);
    expect(saveAs).not.toHaveBeenCalled();
    expect(state.downloadWaiterDepth).toBe(0);
    expect(page.listenerCount("download")).toBe(0);
  });

  it.each(["explicit", "passive"] as const)(
    "enforces the %s download deadline after its event arrives",
    async (mode) => {
      vi.useFakeTimers();
      const page = new EventEmitter();
      const state = { downloadWaiterDepth: 0 };
      const controller = new AbortController();
      const validation = Promise.withResolvers<void>();
      const saveAs = vi.fn(async () => {});
      const cancel = vi.fn(async () => {});
      const timeoutMessage =
        mode === "passive"
          ? "Timeout waiting for navigation download"
          : "Timeout waiting for download";
      const capture = createDownloadCaptureForPage(page, state, 25, {
        mode,
        signal: controller.signal,
        timeoutMessage,
        beforeSave: async () => {
          await validation.promise;
        },
      });
      const outcome = capture.promise.then(
        () => "resolved" as const,
        (error: unknown) => error,
      );

      try {
        page.emit("download", {
          url: () => "https://example.com/export.csv",
          suggestedFilename: () => "export.csv",
          saveAs,
          cancel,
        });
        await vi.advanceTimersByTimeAsync(25);

        await expect(Promise.race([outcome, Promise.resolve("pending")])).resolves.toMatchObject({
          message: timeoutMessage,
        });
        expect(cancel).toHaveBeenCalledOnce();
        validation.resolve();
        await vi.advanceTimersByTimeAsync(0);

        expect(saveAs).not.toHaveBeenCalled();
        expect(state.downloadWaiterDepth).toBe(0);
        expect(page.listenerCount("download")).toBe(0);
      } finally {
        controller.abort(new Error("download test cleanup"));
        validation.resolve();
        await outcome;
        vi.useRealTimers();
      }
    },
  );

  it("cancels a captured download before delayed validation can save bytes", async () => {
    const page = new EventEmitter();
    const state = { downloadWaiterDepth: 0 };
    const controller = new AbortController();
    const reason = new Error("download request aborted");
    const validation = Promise.withResolvers<void>();
    const beforeSave = vi.fn(async () => {
      await validation.promise;
    });
    const saveAs = vi.fn(async () => {});
    const cancel = vi.fn(async () => {});
    const capture = createDownloadCaptureForPage(page, state, 1_000, {
      beforeSave,
      signal: controller.signal,
    });
    const outcome = capture.promise.then(
      () => "resolved" as const,
      (error: unknown) => error,
    );

    try {
      page.emit("download", {
        url: () => "https://example.com/export.csv",
        suggestedFilename: () => "export.csv",
        saveAs,
        cancel,
      });
      expect(beforeSave).toHaveBeenCalledOnce();
      controller.abort(reason);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(cancel).toHaveBeenCalledOnce();
      expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe(reason);
      validation.resolve();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(saveAs).not.toHaveBeenCalled();
      expect(state.downloadWaiterDepth).toBe(0);
      expect(page.listenerCount("download")).toBe(0);
    } finally {
      validation.resolve();
      await outcome;
    }
  });

  it("cancels an in-progress download without publishing staged output", async ({ signal }) => {
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-download-cancel-"));
    const outputPath = path.join(outputRoot, "cancelled.bin");
    const writeSettled = Promise.withResolvers<void>();
    const writeOutput = outputFiles.writeExternalFileWithinOutputRoot;
    const write = vi
      .spyOn(outputFiles, "writeExternalFileWithinOutputRoot")
      .mockImplementation((params) => {
        const pending = writeOutput(params);
        void pending.then(
          () => writeSettled.resolve(),
          () => writeSettled.resolve(),
        );
        return pending;
      });
    const page = new EventEmitter();
    const state = { downloadWaiterDepth: 0 };
    const controller = new AbortController();
    const reason = new Error("download request aborted");
    const saveGate = Promise.withResolvers<void>();
    const saveStarted = Promise.withResolvers<string>();
    const saveAs = vi.fn(async (tempPath: string) => {
      await fs.writeFile(tempPath, "cancelled partial contents", "utf8");
      saveStarted.resolve(tempPath);
      await saveGate.promise;
    });
    const cancel = vi.fn(async () => {
      saveGate.resolve();
    });
    const capture = createDownloadCaptureForPage(page, state, 1_000, {
      mode: "explicit",
      outputPath,
      outputRoot,
      signal: controller.signal,
    });
    const outcome = capture.promise.then(
      () => "resolved" as const,
      (error: unknown) => error,
    );

    try {
      page.emit("download", {
        url: () => "https://example.com/cancelled.bin",
        suggestedFilename: () => "cancelled.bin",
        saveAs,
        cancel,
      });
      const partialPath = await withinTest(saveStarted.promise, signal);
      await expect(fs.readFile(partialPath, "utf8")).resolves.toBe("cancelled partial contents");

      controller.abort(reason);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(cancel).toHaveBeenCalledOnce();
      await expect(outcome).resolves.toBe(reason);
      // Capture rejection precedes the writer's staging cleanup; join that exact writer.
      await withinTest(writeSettled.promise, signal);
      await expect(fs.access(partialPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(state.downloadWaiterDepth).toBe(0);
      expect(page.listenerCount("download")).toBe(0);
    } finally {
      saveGate.resolve();
      await outcome;
      // Teardown joins admitted writes even after the test signal has aborted.
      if (write.mock.calls.length > 0) {
        await writeSettled.promise;
      }
      write.mockRestore();
      await fs.rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("cancels a timed-out in-progress download without publishing staged output", async ({
    signal,
  }) => {
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-download-timeout-"));
    const outputPath = path.join(outputRoot, "timed-out.bin");
    const writeSettled = Promise.withResolvers<void>();
    const writeOutput = outputFiles.writeExternalFileWithinOutputRoot;
    const write = vi
      .spyOn(outputFiles, "writeExternalFileWithinOutputRoot")
      .mockImplementation((params) => {
        const pending = writeOutput(params);
        void pending.then(
          () => writeSettled.resolve(),
          () => writeSettled.resolve(),
        );
        return pending;
      });
    vi.useFakeTimers();
    const page = new EventEmitter();
    const state = { downloadWaiterDepth: 0 };
    const saveGate = Promise.withResolvers<void>();
    const saveStarted = Promise.withResolvers<string>();
    const saveAs = vi.fn(async (tempPath: string) => {
      await fs.writeFile(tempPath, "timed-out partial contents", "utf8");
      saveStarted.resolve(tempPath);
      await saveGate.promise;
    });
    const cancel = vi.fn(async () => {
      saveGate.resolve();
    });
    const capture = createDownloadCaptureForPage(page, state, 25, {
      mode: "explicit",
      outputPath,
      outputRoot,
    });
    const outcome = capture.promise.then(
      () => "resolved" as const,
      (error: unknown) => error,
    );

    try {
      page.emit("download", {
        url: () => "https://example.com/timed-out.bin",
        suggestedFilename: () => "timed-out.bin",
        saveAs,
        cancel,
      });
      const partialPath = await withinTest(saveStarted.promise, signal);
      await vi.advanceTimersByTimeAsync(25);

      await expect(Promise.race([outcome, Promise.resolve("pending")])).resolves.toMatchObject({
        message: "Timeout waiting for download",
      });
      expect(cancel).toHaveBeenCalledOnce();
      // Capture rejection precedes the writer's staging cleanup; join that exact writer.
      await withinTest(writeSettled.promise, signal);
      await expect(fs.access(partialPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      saveGate.resolve();
      await outcome;
      // Teardown joins admitted writes even after the test signal has aborted.
      if (write.mock.calls.length > 0) {
        await writeSettled.promise;
      }
      write.mockRestore();
      vi.useRealTimers();
      await fs.rm(outputRoot, { recursive: true, force: true });
    }
  });

  it.each(["caller cancellation", "download deadline"] as const)(
    "finishes atomic publication when %s arrives after its commit boundary",
    async (interruption) => {
      const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-download-publish-"));
      const outputPath = path.join(outputRoot, "published.bin");
      const renameStarted = Promise.withResolvers<void>();
      const releaseRename = Promise.withResolvers<void>();
      const renameFinished = Promise.withResolvers<void>();
      const originalRename = fs.rename.bind(fs);
      const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        if (String(destination).endsWith(`${path.sep}published.bin`)) {
          renameStarted.resolve();
          await releaseRename.promise;
        }
        try {
          await originalRename(source, destination);
        } finally {
          renameFinished.resolve();
        }
      });
      vi.useFakeTimers();
      const page = new EventEmitter();
      const state = { downloadWaiterDepth: 0 };
      const controller = new AbortController();
      const cancel = vi.fn(async () => {});
      const capture = createDownloadCaptureForPage(
        page,
        state,
        interruption === "caller cancellation" ? 1_000 : 25,
        {
          mode: "explicit",
          outputPath,
          outputRoot,
          signal: controller.signal,
        },
      );
      const outcome = capture.promise.then(
        (result) => result,
        (error: unknown) => error,
      );

      try {
        page.emit("download", {
          url: () => "https://example.com/published.bin",
          suggestedFilename: () => "published.bin",
          saveAs: async (tempPath: string) => {
            await fs.writeFile(tempPath, "completed download", "utf8");
          },
          cancel,
        });
        await renameStarted.promise;
        if (interruption === "caller cancellation") {
          controller.abort(new Error("download aborted during publication"));
          await vi.advanceTimersByTimeAsync(0);
        } else {
          await vi.advanceTimersByTimeAsync(25);
        }

        expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe("pending");
        expect(cancel).not.toHaveBeenCalled();
        releaseRename.resolve();

        await expect(capture.promise).resolves.toMatchObject({ path: outputPath });
        await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("completed download");
        expect(state.downloadWaiterDepth).toBe(0);
      } finally {
        releaseRename.resolve();
        await renameFinished.promise;
        await outcome;
        rename.mockRestore();
        vi.useRealTimers();
        await fs.rm(outputRoot, { recursive: true, force: true });
      }
    },
  );
});
