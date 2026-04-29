import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const DIR_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
export const DIR_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export type DirFetchParams = {
  path?: unknown;
  maxBytes?: unknown;
  includeDotfiles?: unknown;
};

export type DirFetchOk = {
  ok: true;
  path: string;
  tarBase64: string;
  tarBytes: number;
  sha256: string;
  fileCount: number;
};

export type DirFetchErrCode =
  | "INVALID_PATH"
  | "NOT_FOUND"
  | "IS_FILE"
  | "TREE_TOO_LARGE"
  | "READ_ERROR";

export type DirFetchErr = {
  ok: false;
  code: DirFetchErrCode;
  message: string;
  canonicalPath?: string;
};

export type DirFetchResult = DirFetchOk | DirFetchErr;

function clampMaxBytes(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return DIR_FETCH_DEFAULT_MAX_BYTES;
  }
  return Math.min(Math.floor(input), DIR_FETCH_HARD_MAX_BYTES);
}

function classifyFsError(err: unknown): DirFetchErrCode {
  const code = (err as { code?: string } | null)?.code;
  if (code === "ENOENT") {
    return "NOT_FOUND";
  }
  return "READ_ERROR";
}

async function preflightDu(dirPath: string, maxBytes: number): Promise<boolean> {
  // du -sk gives size in 1KB blocks (512-byte blocks on macOS with -k)
  // We use maxBytes * 4 as the rough heuristic ceiling (generous, gzip compresses)
  const heuristicKb = Math.ceil((maxBytes * 4) / 1024);
  return new Promise((resolve) => {
    const du = spawn("du", ["-sk", dirPath], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    du.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    du.on("close", (code) => {
      if (code !== 0) {
        // du failed; be permissive and let tar catch the overflow
        resolve(true);
        return;
      }
      const match = /^(\d+)/.exec(output.trim());
      if (!match) {
        resolve(true);
        return;
      }
      const sizeKb = Number.parseInt(match[1], 10);
      resolve(sizeKb <= heuristicKb);
    });
    du.on("error", () => {
      // du not available; skip preflight
      resolve(true);
    });
  });
}

async function countTarEntries(tarBuffer: Buffer): Promise<number> {
  // Async spawn so a slow `tar -tzf` doesn't park the node-host event
  // loop for up to 10s. Other in-flight requests continue to be served.
  return new Promise((resolve) => {
    const child = spawn("tar", ["-tzf", "-"], { stdio: ["pipe", "pipe", "ignore"] });
    let stdoutBuf = "";
    let aborted = false;
    const watchdog = setTimeout(() => {
      aborted = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      resolve(0);
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      // Bound buffer growth — pathological archives shouldn't OOM us.
      if (stdoutBuf.length > 32 * 1024 * 1024) {
        aborted = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone */
        }
        clearTimeout(watchdog);
        resolve(0);
      }
    });
    child.on("close", (code) => {
      clearTimeout(watchdog);
      if (aborted) {
        return;
      }
      if (code !== 0) {
        resolve(0);
        return;
      }
      const lines = stdoutBuf.split("\n").filter((l) => l.trim().length > 0 && l !== "./");
      resolve(lines.length);
    });
    child.on("error", () => {
      clearTimeout(watchdog);
      if (!aborted) {
        resolve(0);
      }
    });
    child.stdin.end(tarBuffer);
  });
}

export async function handleDirFetch(params: DirFetchParams): Promise<DirFetchResult> {
  const requestedPath = params.path;
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    return { ok: false, code: "INVALID_PATH", message: "path required" };
  }
  if (requestedPath.includes("\0")) {
    return { ok: false, code: "INVALID_PATH", message: "path contains NUL byte" };
  }
  if (!path.isAbsolute(requestedPath)) {
    return { ok: false, code: "INVALID_PATH", message: "path must be absolute" };
  }

  const maxBytes = clampMaxBytes(params.maxBytes);
  const includeDotfiles = params.includeDotfiles === true;

  let canonical: string;
  try {
    canonical = await fs.realpath(requestedPath);
  } catch (err) {
    const code = classifyFsError(err);
    return {
      ok: false,
      code,
      message: code === "NOT_FOUND" ? "directory not found" : `realpath failed: ${String(err)}`,
    };
  }

  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(canonical);
  } catch (err) {
    const code = classifyFsError(err);
    return { ok: false, code, message: `stat failed: ${String(err)}`, canonicalPath: canonical };
  }

  if (!stats.isDirectory()) {
    return {
      ok: false,
      code: "IS_FILE",
      message: "path is not a directory",
      canonicalPath: canonical,
    };
  }

  // Preflight size check using du
  const withinBudget = await preflightDu(canonical, maxBytes);
  if (!withinBudget) {
    return {
      ok: false,
      code: "TREE_TOO_LARGE",
      message: `directory tree exceeds estimated size limit (${maxBytes} bytes raw)`,
      canonicalPath: canonical,
    };
  }

  // Build tar args. Shell out to /usr/bin/tar for portability.
  // -cz: create + gzip
  // -C <dir>: change to directory so paths in archive are relative
  // .: include everything from that directory
  // v1: includeDotfiles is accepted in the API but not enforced. BSD tar's
  // --exclude pattern matching is unreliable for dotfiles (every plausible
  // pattern except "*/.*" collapses the archive on macOS). Reliable filtering
  // requires a `find ! -name '.*' | tar -T -` pipeline; deferred to v2.
  // For now we always archive everything in the directory.
  void includeDotfiles;
  const tarArgs: string[] = ["-czf", "-", "-C", canonical, "."];

  // Capture tar output with a hard byte cap and a wall-clock timeout.
  // SIGTERM if the byte cap is exceeded; SIGKILL if the timeout fires
  // (covers tar hanging on a slow filesystem or symlink loop).
  const TAR_HARD_TIMEOUT_MS = 60_000;
  const tarBuffer = await new Promise<Buffer | "TOO_LARGE" | "TIMEOUT" | "ERROR">((resolve) => {
    const tarBin = process.platform !== "win32" ? "/usr/bin/tar" : "tar";
    const child = spawn(tarBin, tarArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let aborted = false;

    const watchdog = setTimeout(() => {
      if (aborted) {
        return;
      }
      aborted = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve("TIMEOUT");
    }, TAR_HARD_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      if (aborted) {
        return;
      }
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        aborted = true;
        clearTimeout(watchdog);
        child.kill("SIGTERM");
        resolve("TOO_LARGE");
        return;
      }
      chunks.push(chunk);
    });

    child.on("close", (code) => {
      clearTimeout(watchdog);
      if (aborted) {
        return;
      }
      if (code !== 0) {
        resolve("ERROR");
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    child.on("error", () => {
      clearTimeout(watchdog);
      if (!aborted) {
        resolve("ERROR");
      }
    });
  });

  if (tarBuffer === "TOO_LARGE") {
    return {
      ok: false,
      code: "TREE_TOO_LARGE",
      message: `tarball exceeded ${maxBytes} byte limit mid-stream`,
      canonicalPath: canonical,
    };
  }
  if (tarBuffer === "TIMEOUT") {
    return {
      ok: false,
      code: "READ_ERROR",
      message: "tar command exceeded 60s wall-clock timeout (slow filesystem or symlink loop?)",
      canonicalPath: canonical,
    };
  }
  if (tarBuffer === "ERROR") {
    return {
      ok: false,
      code: "READ_ERROR",
      message: "tar command failed",
      canonicalPath: canonical,
    };
  }

  const sha256 = crypto.createHash("sha256").update(tarBuffer).digest("hex");
  const tarBase64 = tarBuffer.toString("base64");
  const tarBytes = tarBuffer.byteLength;
  const fileCount = await countTarEntries(tarBuffer);

  return {
    ok: true,
    path: canonical,
    tarBase64,
    tarBytes,
    sha256,
    fileCount,
  };
}
