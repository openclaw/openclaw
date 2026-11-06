import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { BROWSER_PROXY_MAX_FILE_BYTES } from "../browser-proxy-envelope.js";
import * as outputFiles from "./output-files.js";
import { observeOutputWriteSettlement } from "./output-files.test-support.js";
import {
  createDownloadCaptureForPage,
  type BrowserDownloadCaptureOptions,
} from "./pw-download-capture.js";
import { downloadReadStream } from "./pw-download-test-doubles.js";

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
    createReadStream?: () => Promise<Readable>;
    cancel?: () => Promise<void>;
    delete?: () => Promise<void>;
  };
} = {}) {
  const page = new EventEmitter();
  const state = { downloadWaiterDepth: 0 };
  const createReadStream = vi.fn(download.createReadStream ?? (async () => Readable.from([])));
  const cancel = vi.fn(download.cancel ?? (async () => {}));
  const deleteDownload = vi.fn(download.delete ?? (async () => {}));
  const capture = createDownloadCaptureForPage(page, state, timeout, options);
  onTestFinished(capture.cancel);
  const outcome = capture.promise.catch((error: unknown) => error);
  return {
    capture,
    outcome,
    createReadStream,
    cancel,
    deleteDownload,
    emit: () =>
      page.emit("download", {
        url: () => download.url ?? "https://example.com/export.csv",
        suggestedFilename: () => download.filename ?? "export.csv",
        createReadStream,
        cancel,
        delete: deleteDownload,
      }),
    close: () => page.emit("close"),
    expectReleased: () => {
      expect(state.downloadWaiterDepth).toBe(0);
      expect(page.listenerCount("download")).toBe(0);
      expect(page.listenerCount("close")).toBe(0);
    },
  };
}

describe("Playwright download capture cancellation", () => {
  it.each([false, true])("joins policy rejection or pending page close=%s", async (closed) => {
    const rejection = new Error("download destination blocked by policy");
    const cancelGate = Promise.withResolvers<void>();
    const f = makeCapture({
      beforeSave: () => Promise.reject(rejection),
      cancelOnBeforeSaveError: () => true,
      download: {
        cancel: async () => await cancelGate.promise,
      },
    });
    if (closed) {
      f.close();
      await Promise.resolve();
      await expect(pendingOr(f.outcome)).resolves.toMatchObject({
        message: "Page closed before download started.",
      });
      expect(f.cancel).not.toHaveBeenCalled();
    } else {
      f.emit();
      await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
      await expect(pendingOr(f.outcome)).resolves.toBe("pending");
      cancelGate.resolve();
      await expect(f.outcome).resolves.toBe(rejection);
    }
    expect(f.createReadStream).not.toHaveBeenCalled();
    f.expectReleased();
  });

  it.for([
    { stage: "validation", mode: "explicit", deadline: true },
    { stage: "validation", mode: "passive", deadline: true },
    { stage: "validation", mode: undefined, deadline: false },
    { stage: "saving", mode: "explicit", deadline: false },
    { stage: "saving", mode: "explicit", deadline: true },
    { stage: "publishing", mode: "explicit", deadline: false },
    { stage: "publishing", mode: "explicit", deadline: true },
  ] as const)(
    "settles interruption during $stage (mode=$mode, deadline=$deadline)",
    async ({ stage, mode, deadline }, { signal }) => {
      const controller = new AbortController();
      const reason = new Error("download request aborted");
      const validating = stage === "validation";
      const publishing = stage === "publishing";
      const fakeClock = deadline || publishing;
      const timeoutMessage = mode === "passive" ? "passive download timeout" : "download timeout";
      const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-download-"));
      const outputPath = path.join(outputRoot, "download.bin");
      const { write, writeSettled } = observeOutputWriteSettlement(outputFiles);
      const release = Promise.withResolvers<void>();
      const started = Promise.withResolvers<string>();
      const beforeSave = vi.fn(async () => {
        started.resolve("");
        await release.promise;
      });
      const originalRename = fs.rename.bind(fs);
      const rename = publishing
        ? vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
            started.resolve("");
            await release.promise;
            await originalRename(source, destination);
          })
        : undefined;
      if (fakeClock) {
        vi.useFakeTimers();
      }
      const saving = stage === "saving";
      const openFile = fs.open.bind(fs);
      const openSpy = saving
        ? vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
            const handle = await openFile(file, flags, mode);
            if (flags !== "w" || !String(file).endsWith(".part")) {
              return handle;
            }
            const writeChunk = handle.write.bind(handle);
            handle.write = (async (
              buffer: Buffer,
              offset?: number,
              length?: number,
              position?: number | null,
            ) => {
              const result = await writeChunk(buffer, offset, length, position);
              started.resolve(String(file));
              await release.promise;
              return result;
            }) as typeof handle.write;
            return handle;
          })
        : undefined;
      const f = makeCapture({
        mode,
        outputPath,
        outputRoot,
        timeoutMessage,
        beforeSave: validating ? beforeSave : undefined,
        signal: controller.signal,
        timeout: deadline ? 25 : 1_000,
        download: {
          createReadStream: downloadReadStream("download contents"),
          cancel: async () => {
            if (!validating) {
              release.resolve();
            }
          },
        },
      });
      try {
        f.emit();
        if (validating) {
          expect(beforeSave).toHaveBeenCalledOnce();
        }
        const partialPath = await withinTest(started.promise, signal);
        f.close();
        if (stage === "saving") {
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
            await expect(pendingOr(f.outcome)).resolves.toMatchObject({ message: timeoutMessage });
          } else {
            await expect(pendingOr(f.outcome)).resolves.toBe(reason);
          }
          expect(f.cancel).toHaveBeenCalledOnce();
          if (validating) {
            release.resolve();
            await (deadline ? vi.advanceTimersByTimeAsync(0) : nextTurn());
            expect(f.createReadStream).not.toHaveBeenCalled();
          } else {
            // Capture rejection precedes staging cleanup; join that exact writer.
            await withinTest(writeSettled.promise, signal);
            await expect(fs.access(partialPath)).rejects.toMatchObject({ code: "ENOENT" });
            await expect(fs.access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
          }
        }
        f.expectReleased();
      } finally {
        if (validating) {
          controller.abort(new Error("download test cleanup"));
        }
        release.resolve();
        await f.outcome;
        // Teardown joins admitted writes even after the test signal aborts.
        if (write.mock.calls.length > 0) {
          await writeSettled.promise;
        }
        write.mockRestore();
        openSpy?.mockRestore();
        rename?.mockRestore();
        vi.useRealTimers();
        await fs.rm(outputRoot, { recursive: true, force: true });
      }
    },
  );

  it("publishes a download that stays within its byte budget", async () => {
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-download-budget-ok-"));
    const outputPath = path.join(outputRoot, "kept.bin");
    const contents = Buffer.alloc(BROWSER_PROXY_MAX_FILE_BYTES, 0x61);
    const f = makeCapture({
      mode: "explicit",
      outputPath,
      outputRoot,
      download: {
        filename: "kept.bin",
        url: "https://example.com/kept.bin",
        createReadStream: async () => Readable.from([contents]),
      },
    });
    try {
      f.emit();
      await expect(f.capture.promise).resolves.toMatchObject({ path: outputPath });
      await expect(fs.stat(outputPath)).resolves.toMatchObject({
        size: BROWSER_PROXY_MAX_FILE_BYTES,
      });
      expect(f.cancel).not.toHaveBeenCalled();
      expect(f.deleteDownload).not.toHaveBeenCalled();
    } finally {
      await f.outcome;
      await fs.rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("cancels a streamed download that crosses its byte budget", async () => {
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-download-budget-"));
    const outputPath = path.join(outputRoot, "oversized.bin");
    const f = makeCapture({
      mode: "explicit",
      outputPath,
      outputRoot,
      download: {
        filename: "oversized.bin",
        url: "https://example.com/oversized.bin",
        createReadStream: async () =>
          Readable.from([Buffer.alloc(BROWSER_PROXY_MAX_FILE_BYTES, 0x61), Buffer.from([0x62])]),
      },
    });
    try {
      f.emit();
      await expect(f.outcome).resolves.toMatchObject({
        message: `Browser download exceeds ${BROWSER_PROXY_MAX_FILE_BYTES} bytes`,
      });
      expect(f.cancel).toHaveBeenCalled();
      expect(f.deleteDownload).toHaveBeenCalled();
      await expect(fs.access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await f.outcome;
      await fs.rm(outputRoot, { recursive: true, force: true });
    }
  });
});
