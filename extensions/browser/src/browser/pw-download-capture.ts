/** Shared Playwright download capture and output handling. */
import crypto from "node:crypto";
import path from "node:path";
import type { Page } from "playwright-core";
import type { BrowserDownloadCandidate, BrowserDownloadResult } from "./download-types.js";
import { writeExternalFileWithinOutputRoot } from "./output-files.js";
import { DEFAULT_DOWNLOAD_DIR } from "./paths.js";
import { sanitizeUntrustedFileName } from "./safe-filename.js";

type BrowserDownloadCaptureState = {
  downloadWaiterDepth: number;
};

export type BrowserDownloadCaptureOptions = {
  beforeSave?: (download: BrowserDownloadCandidate) => Promise<void> | void;
  mode?: "passive" | "explicit";
  outputPath?: string;
  outputRoot?: string;
  signal?: AbortSignal;
  timeoutMessage?: string;
};

export type PlaywrightDownload = {
  url?: () => string;
  suggestedFilename?: () => string;
  saveAs?: (outPath: string) => Promise<void>;
};

function buildManagedDownloadPath(rootDir: string, fileName: string): string {
  const id = crypto.randomUUID();
  const safeName = sanitizeUntrustedFileName(fileName, "download.bin");
  return path.join(rootDir, `${id}-${safeName}`);
}

/** Validate metadata and atomically save one Playwright download. */
export async function saveBrowserDownload(
  download: PlaywrightDownload,
  opts: BrowserDownloadCaptureOptions = {},
): Promise<BrowserDownloadResult> {
  const suggestedFilename = download.suggestedFilename?.() || "download.bin";
  const candidate: BrowserDownloadCandidate = {
    url: download.url?.() || "",
    suggestedFilename,
  };
  opts.signal?.throwIfAborted();
  await opts.beforeSave?.(candidate);
  opts.signal?.throwIfAborted();
  const saveAs = download.saveAs?.bind(download);
  if (!saveAs) {
    throw new Error("Download cannot be saved");
  }
  opts.signal?.throwIfAborted();
  const requestedPath = opts.outputPath?.trim();
  const implicitRoot = opts.outputRoot ?? DEFAULT_DOWNLOAD_DIR;
  const managedPath = requestedPath || buildManagedDownloadPath(implicitRoot, suggestedFilename);
  const savedPath = await writeExternalFileWithinOutputRoot({
    rootDir: requestedPath ? opts.outputRoot : implicitRoot,
    path: managedPath,
    write: async (tempPath) => {
      opts.signal?.throwIfAborted();
      await saveAs(tempPath);
      // Playwright saveAs cannot always be interrupted; fence the atomic
      // finalize step so timed-out saves cannot publish late output.
      opts.signal?.throwIfAborted();
    },
  });
  return { ...candidate, path: savedPath };
}

/** Arm one page download while maintaining explicit/passive ownership depth. */
export function createDownloadCaptureForPage(
  page: Page,
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
  let done = false;
  let settled = false;
  let depthReleased = false;
  let timer: NodeJS.Timeout | undefined;
  let handler: ((download: unknown) => void) | undefined;
  const saveAbortController = new AbortController();

  const cleanup = () => {
    if (!depthReleased) {
      depthReleased = true;
      state.downloadWaiterDepth = Math.max(0, state.downloadWaiterDepth - 1);
    }
    if (handler) {
      page.off("download", handler as never);
      handler = undefined;
    }
  };

  const finish = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const promise = new Promise<BrowserDownloadResult>((resolve, reject) => {
    handler = (download: unknown) => {
      if (done) {
        return;
      }
      done = true;
      cleanup();
      void saveBrowserDownload(download as PlaywrightDownload, {
        ...opts,
        signal: saveAbortController.signal,
      }).then(
        (result) => {
          if (settled) {
            return;
          }
          settled = true;
          finish();
          resolve(result);
        },
        (error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          finish();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    };
    page.on("download", handler as never);
    timer = setTimeout(
      () => {
        if (settled) {
          return;
        }
        settled = true;
        done = true;
        const timeoutError = new Error(opts.timeoutMessage ?? "Timeout waiting for download");
        saveAbortController.abort(timeoutError);
        cleanup();
        finish();
        reject(timeoutError);
      },
      Math.max(1, timeoutMs),
    );
    timer.unref?.();
  });

  return {
    armed: true,
    promise,
    cancel: () => {
      if (settled) {
        return;
      }
      settled = true;
      done = true;
      saveAbortController.abort(new Error("Download capture cancelled"));
      cleanup();
      finish();
    },
  };
}
