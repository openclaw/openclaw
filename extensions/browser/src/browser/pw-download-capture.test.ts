import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import * as outputFiles from "./output-files.js";
import { observeOutputWriteSettlement } from "./output-files.test-support.js";
import {
  createDownloadCaptureForPage,
  type BrowserDownloadCaptureOptions,
} from "./pw-download-capture.js";

const pendingOr = <T>(outcome: Promise<T>) => Promise.race([outcome, Promise.resolve("pending")]);

function makeCapture({
  timeout = 1_000,
  download = {},
  ...options
}: BrowserDownloadCaptureOptions & {
  timeout?: number;
  download?: {
    filename?: string;
    url?: string;
    saveAs?: (tempPath: string) => Promise<void>;
    cancel?: () => Promise<void>;
  };
} = {}) {
  const page = new EventEmitter();
  const state = { downloadWaiterDepth: 0 };
  const saveAs = vi.fn(download.saveAs ?? (async () => {}));
  const cancel = vi.fn(download.cancel ?? (async () => {}));
  const capture = createDownloadCaptureForPage(page, state, timeout, options);
  const outcome = capture.promise.catch((error: unknown) => error);
  return {
    capture,
    outcome,
    saveAs,
    cancel,
    emit: () =>
      page.emit("download", {
        url: () => download.url ?? "https://example.com/export.csv",
        suggestedFilename: () => download.filename ?? "export.csv",
        saveAs,
        cancel,
      }),
    expectReleased: () => {
      expect(state.downloadWaiterDepth).toBe(0);
      expect(page.listenerCount("download")).toBe(0);
    },
  };
}

describe("Playwright download capture cancellation", () => {
  it("awaits cancellation when owned download admission rejects", async () => {
    const rejection = new Error("download destination blocked by policy");
    const cancelGate = Promise.withResolvers<void>();
    const f = makeCapture({
      mode: "explicit",
      beforeSave: async () => {
        throw rejection;
      },
      cancelOnBeforeSaveError: () => true,
      download: {
        url: "http://169.254.169.254/latest/meta-data/",
        filename: "metadata.bin",
        cancel: async () => await cancelGate.promise,
      },
    });
    f.emit();
    await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
    await expect(pendingOr(f.outcome)).resolves.toBe("pending");
    cancelGate.resolve();

    await expect(f.outcome).resolves.toBe(rejection);
    expect(f.saveAs).not.toHaveBeenCalled();
    f.expectReleased();
  });

  it.each(["explicit", "passive", "caller cancellation"] as const)(
    "prevents saving after %s interrupts delayed validation",
    async (mode) => {
      const deadline = mode !== "caller cancellation";
      if (deadline) {
        vi.useFakeTimers();
      }
      const controller = new AbortController();
      const reason = new Error("download request aborted");
      const validation = Promise.withResolvers<void>();
      const beforeSave = vi.fn(async () => {
        await validation.promise;
      });
      const timeoutMessage =
        mode === "passive"
          ? "Timeout waiting for navigation download"
          : "Timeout waiting for download";
      const f = makeCapture({
        mode: deadline ? mode : undefined,
        signal: controller.signal,
        timeoutMessage,
        beforeSave,
        timeout: deadline ? 25 : 1_000,
      });

      try {
        f.emit();
        expect(beforeSave).toHaveBeenCalledOnce();
        if (deadline) {
          await vi.advanceTimersByTimeAsync(25);
          await expect(pendingOr(f.outcome)).resolves.toMatchObject({ message: timeoutMessage });
        } else {
          controller.abort(reason);
          await nextTurn();
          expect(await pendingOr(f.outcome)).toBe(reason);
        }
        expect(f.cancel).toHaveBeenCalledOnce();
        validation.resolve();
        await (deadline ? vi.advanceTimersByTimeAsync(0) : nextTurn());
        expect(f.saveAs).not.toHaveBeenCalled();
        f.expectReleased();
      } finally {
        controller.abort(new Error("download test cleanup"));
        validation.resolve();
        await f.outcome;
        vi.useRealTimers();
      }
    },
  );

  it.for(["caller cancellation", "download deadline"] as const)(
    "discards an in-progress staged download on %s",
    async (interruption, { signal }) => {
      const controller = new AbortController();
      const reason = new Error("download request aborted");
      const deadline = interruption === "download deadline";
      const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-download-"));
      const outputPath = path.join(outputRoot, "cancelled.bin");
      const { write, writeSettled } = observeOutputWriteSettlement(outputFiles);
      const saveGate = Promise.withResolvers<void>();
      const saveStarted = Promise.withResolvers<string>();
      if (deadline) {
        vi.useFakeTimers();
      }
      const f = makeCapture({
        mode: "explicit",
        outputPath,
        outputRoot,
        signal: controller.signal,
        timeout: deadline ? 25 : 1_000,
        download: {
          filename: "cancelled.bin",
          url: "https://example.com/cancelled.bin",
          saveAs: async (tempPath) => {
            await fs.writeFile(tempPath, "cancelled partial contents", "utf8");
            saveStarted.resolve(tempPath);
            await saveGate.promise;
          },
          cancel: async () => {
            saveGate.resolve();
          },
        },
      });
      try {
        f.emit();
        const partialPath = await withinTest(saveStarted.promise, signal);
        await expect(fs.readFile(partialPath, "utf8")).resolves.toBe("cancelled partial contents");
        if (deadline) {
          await vi.advanceTimersByTimeAsync(25);
          await expect(pendingOr(f.outcome)).resolves.toMatchObject({
            message: "Timeout waiting for download",
          });
        } else {
          controller.abort(reason);
          await nextTurn();
          await expect(f.outcome).resolves.toBe(reason);
        }
        expect(f.cancel).toHaveBeenCalledOnce();
        // Capture rejection precedes staging cleanup; join that exact writer.
        await withinTest(writeSettled.promise, signal);
        await expect(fs.access(partialPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
        f.expectReleased();
      } finally {
        saveGate.resolve();
        await f.outcome;
        // Teardown joins admitted writes even after the test signal aborts.
        if (write.mock.calls.length > 0) {
          await writeSettled.promise;
        }
        write.mockRestore();
        vi.useRealTimers();
        await fs.rm(outputRoot, { recursive: true, force: true });
      }
    },
  );

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
      const controller = new AbortController();
      const f = makeCapture({
        mode: "explicit",
        outputPath,
        outputRoot,
        signal: controller.signal,
        timeout: interruption === "caller cancellation" ? 1_000 : 25,
        download: {
          url: "https://example.com/published.bin",
          filename: "published.bin",
          saveAs: async (tempPath: string) => {
            await fs.writeFile(tempPath, "completed download", "utf8");
          },
        },
      });
      try {
        f.emit();
        await renameStarted.promise;
        if (interruption === "caller cancellation") {
          controller.abort(new Error("download aborted during publication"));
          await vi.advanceTimersByTimeAsync(0);
        } else {
          await vi.advanceTimersByTimeAsync(25);
        }

        expect(await pendingOr(f.outcome)).toBe("pending");
        expect(f.cancel).not.toHaveBeenCalled();
        releaseRename.resolve();

        await expect(f.capture.promise).resolves.toMatchObject({ path: outputPath });
        await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("completed download");
        f.expectReleased();
      } finally {
        releaseRename.resolve();
        await renameFinished.promise;
        await f.outcome;
        rename.mockRestore();
        vi.useRealTimers();
        await fs.rm(outputRoot, { recursive: true, force: true });
      }
    },
  );
});
