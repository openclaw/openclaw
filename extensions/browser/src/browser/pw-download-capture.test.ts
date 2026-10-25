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

  it.for([
    { kind: "caller cancellation", publishing: false },
    { kind: "download deadline", publishing: false },
    { kind: "caller cancellation", publishing: true },
    { kind: "download deadline", publishing: true },
  ])(
    "settles $kind at the download commit boundary (publishing=$publishing)",
    async ({ kind, publishing }, { signal }) => {
      const controller = new AbortController();
      const reason = new Error("download request aborted");
      const deadline = kind === "download deadline";
      const fakeClock = deadline || publishing;
      const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-download-"));
      const outputPath = path.join(outputRoot, "download.bin");
      const { write, writeSettled } = observeOutputWriteSettlement(outputFiles);
      const release = Promise.withResolvers<void>();
      const started = Promise.withResolvers<string>();
      const originalRename = fs.rename.bind(fs);
      const rename = publishing
        ? vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
            if (String(destination).endsWith(`${path.sep}download.bin`)) {
              started.resolve("");
              await release.promise;
            }
            await originalRename(source, destination);
          })
        : undefined;
      if (fakeClock) {
        vi.useFakeTimers();
      }
      const f = makeCapture({
        mode: "explicit",
        outputPath,
        outputRoot,
        signal: controller.signal,
        timeout: deadline ? 25 : 1_000,
        download: {
          filename: "download.bin",
          url: "https://example.com/download.bin",
          saveAs: async (tempPath) => {
            await fs.writeFile(tempPath, "download contents", "utf8");
            if (!publishing) {
              started.resolve(tempPath);
              await release.promise;
            }
          },
          cancel: async () => {
            release.resolve();
          },
        },
      });
      try {
        f.emit();
        const partialPath = await withinTest(started.promise, signal);
        if (!publishing) {
          await expect(fs.readFile(partialPath, "utf8")).resolves.toBe("download contents");
        }
        if (deadline) {
          await vi.advanceTimersByTimeAsync(25);
        } else {
          controller.abort(reason);
          await (fakeClock ? vi.advanceTimersByTimeAsync(0) : nextTurn());
        }
        if (publishing) {
          expect(await pendingOr(f.outcome)).toBe("pending");
          expect(f.cancel).not.toHaveBeenCalled();
          release.resolve();
          await expect(f.capture.promise).resolves.toMatchObject({ path: outputPath });
          await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("download contents");
        } else {
          if (deadline) {
            await expect(pendingOr(f.outcome)).resolves.toMatchObject({
              message: "Timeout waiting for download",
            });
          } else {
            await expect(f.outcome).resolves.toBe(reason);
          }
          expect(f.cancel).toHaveBeenCalledOnce();
          // Capture rejection precedes staging cleanup; join that exact writer.
          await withinTest(writeSettled.promise, signal);
          await expect(fs.access(partialPath)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(fs.access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
        f.expectReleased();
      } finally {
        release.resolve();
        await f.outcome;
        // Teardown joins admitted writes even after the test signal aborts.
        if (write.mock.calls.length > 0) {
          await writeSettled.promise;
        }
        write.mockRestore();
        rename?.mockRestore();
        vi.useRealTimers();
        await fs.rm(outputRoot, { recursive: true, force: true });
      }
    },
  );
});
