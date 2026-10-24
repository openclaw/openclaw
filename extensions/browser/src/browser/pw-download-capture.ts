import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { sanitizeUntrustedFileName } from "openclaw/plugin-sdk/security-runtime";
import { readNonBlankString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Download } from "playwright-core";
import { BROWSER_PROXY_MAX_FILE_BYTES } from "../browser-proxy-envelope.js";
import type { BrowserDownloadCandidate, BrowserDownloadResult } from "./download-types.js";
import { writeExternalFileWithinOutputRoot } from "./output-files.js";
import { DEFAULT_DOWNLOAD_DIR } from "./paths.js";

type BrowserDownloadCaptureState = {
  downloadWaiterDepth: number;
};

type BrowserDownloadPage = {
  on(event: "download", handler: (download: Download) => void): unknown;
  off(event: "download", handler: (download: Download) => void): unknown;
};

export type BrowserDownloadCaptureOptions = {
  beforeSave?: (download: BrowserDownloadCandidate) => Promise<void> | void;
  cancelOnBeforeSaveError?: (error: unknown) => boolean;
  mode?: "passive" | "explicit";
  maxBytes?: number;
  outputPath?: string;
  outputRoot?: string;
  signal?: AbortSignal;
  timeoutMessage?: string;
};

function browserDownloadByteBudget(opts: BrowserDownloadCaptureOptions): number {
  const maxBytes = opts.maxBytes ?? BROWSER_PROXY_MAX_FILE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Browser download byte budget must be a positive integer");
  }
  return maxBytes;
}

function browserDownloadTooLargeError(maxBytes: number): Error {
  return new Error(`Browser download exceeds ${maxBytes} bytes`);
}

async function cancelOverBudgetDownload(download: Download): Promise<void> {
  await download.cancel().catch(() => {});
  if (typeof download.delete === "function") {
    await download.delete().catch(() => {});
  }
}

async function writeEntireChunk(handle: fs.FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (bytesWritten <= 0) {
      throw new Error("Browser download write made no progress");
    }
    offset += bytesWritten;
  }
}

async function writeDownloadStreamWithinBudget(
  stream: Readable,
  tempPath: string,
  maxBytes: number,
  download: Download,
  signal: AbortSignal | undefined,
): Promise<void> {
  const handle = await fs.open(tempPath, "w");
  const onAbort = () => {
    stream.destroy();
  };
  signal?.addEventListener("abort", onAbort);
  let written = 0;
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (written + bytes.length > maxBytes) {
        stream.destroy();
        await cancelOverBudgetDownload(download);
        throw browserDownloadTooLargeError(maxBytes);
      }
      await writeEntireChunk(handle, bytes);
      written += bytes.length;
    }
    signal?.throwIfAborted();
  } catch (error) {
    if (signal?.aborted) {
      signal.throwIfAborted();
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await handle.close();
  }
}

async function writeDownloadWithinBudget(
  download: Download,
  tempPath: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  signal?.throwIfAborted();
  const stream = await download.createReadStream();
  await writeDownloadStreamWithinBudget(stream, tempPath, maxBytes, download, signal);
}

function buildManagedDownloadPath(rootDir: string, fileName: string): string {
  const id = crypto.randomUUID();
  const safeName = sanitizeUntrustedFileName(fileName, "download.bin");
  return path.join(rootDir, `${id}-${safeName}`);
}

/** Validate metadata and atomically save one Playwright download. */
export async function saveBrowserDownload(
  download: Download,
  opts: BrowserDownloadCaptureOptions = {},
  onReadyToPublish?: () => void,
): Promise<BrowserDownloadResult> {
  const suggestedFilename = download.suggestedFilename() || "download.bin";
  const candidate: BrowserDownloadCandidate = {
    url: download.url() || "",
    suggestedFilename,
  };
  try {
    await opts.beforeSave?.(candidate);
  } catch (error) {
    if (!opts.signal?.aborted && opts.cancelOnBeforeSaveError?.(error)) {
      await download.cancel().catch(() => {});
    }
    throw error;
  }
  opts.signal?.throwIfAborted();
  const requestedPath = readNonBlankString(opts.outputPath);
  const implicitRoot = opts.outputRoot ?? DEFAULT_DOWNLOAD_DIR;
  const managedPath = requestedPath || buildManagedDownloadPath(implicitRoot, suggestedFilename);
  const savedPath = await writeExternalFileWithinOutputRoot({
    rootDir: requestedPath ? opts.outputRoot : implicitRoot,
    path: managedPath,
    write: async (tempPath) => {
      await writeDownloadWithinBudget(
        download,
        tempPath,
        browserDownloadByteBudget(opts),
        opts.signal,
      );
      opts.signal?.throwIfAborted();
      onReadyToPublish?.();
    },
  }).catch((error: unknown) => {
    // Admission failures can belong to a superseded waiter. Only failed saves
    // cancel here; an aborted capture already owns its cancellation.
    if (!opts.signal?.aborted) {
      void download.cancel().catch(() => {});
    }
    throw error;
  });
  return { ...candidate, path: savedPath };
}

/** Arm one page download while maintaining explicit/passive ownership depth. */
export function createDownloadCaptureForPage(
  page: BrowserDownloadPage,
  state: BrowserDownloadCaptureState,
  timeoutMs: number,
  opts: BrowserDownloadCaptureOptions = {},
): {
  armed: boolean;
  promise: Promise<BrowserDownloadResult>;
  cancel: () => void;
} {
  // Passive action capture yields to an explicit wait/download owner. Explicit
  // waiters may overlap; their arm id decides which one is allowed to save.
  if (opts.mode !== "explicit" && state.downloadWaiterDepth > 0) {
    return {
      armed: false,
      promise: new Promise<BrowserDownloadResult>(() => {}),
      cancel: () => {},
    };
  }

  state.downloadWaiterDepth += 1;
  const operation = new AbortController();
  let done = false;
  let timer: NodeJS.Timeout | undefined;
  let handler: ((download: Download) => void) | undefined;
  let activeDownload: Download | undefined;
  let abort = () => {};

  const releaseWaiter = () => {
    if (handler) {
      state.downloadWaiterDepth = Math.max(0, state.downloadWaiterDepth - 1);
      page.off("download", handler);
      handler = undefined;
    }
  };

  const retireDeadline = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  const cleanup = () => {
    done = true;
    releaseWaiter();
    retireDeadline();
    opts.signal?.removeEventListener("abort", abort);
  };

  const promise = new Promise<BrowserDownloadResult>((resolve, reject) => {
    const rejectCapture = (reason: Error) => {
      if (done) {
        return;
      }
      operation.abort(reason);
      cleanup();
      void activeDownload?.cancel().catch(() => {});
      reject(reason);
    };
    handler = (download) => {
      if (done) {
        return;
      }
      activeDownload = download;
      releaseWaiter();
      void saveBrowserDownload(activeDownload, { ...opts, signal: operation.signal }, () => {
        // Atomic publication cannot be revoked, so a later abort must not
        // report cancellation while its completed file is being published.
        opts.signal?.removeEventListener("abort", abort);
        retireDeadline();
      })
        .finally(cleanup)
        .then(resolve, reject);
    };
    page.on("download", handler);
    timer = setTimeout(
      () => {
        rejectCapture(new Error(opts.timeoutMessage ?? "Timeout waiting for download"));
      },
      Math.max(1, timeoutMs),
    );
    timer.unref?.();
    abort = () => {
      const reason = opts.signal?.reason;
      rejectCapture(reason instanceof Error ? reason : new Error("Download wait was cancelled"));
    };
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) {
      abort();
    }
  });

  return {
    armed: true,
    promise,
    cancel: () => {
      if (done || activeDownload) {
        return;
      }
      cleanup();
    },
  };
}
