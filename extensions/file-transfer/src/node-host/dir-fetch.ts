import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ArchiveLimitError } from "openclaw/plugin-sdk/archive";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { asPositiveFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import { root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { inspectDirFetchArchive } from "../shared/dir-fetch-archive.js";
import {
  DIR_FETCH_DEFAULT_MAX_BYTES,
  DIR_FETCH_HARD_MAX_BYTES,
  DIR_FETCH_MAX_ENTRIES,
} from "../shared/dir-fetch-limits.js";
import {
  matchesFileIdentity,
  type FileIdentity,
  type PathBinding,
} from "../shared/path-binding.js";
import { createTarArchive } from "./dir-fetch-archive.js";
import {
  classifyFsSafeReadError,
  readAbsolutePath,
  resolveBoundReadDirectory,
  statRequiredDirectory,
} from "./path-errors.js";

type DirFetchParams = {
  path?: unknown;
  maxBytes?: unknown;
  followSymlinks?: unknown;
  preflightOnly?: unknown;
  expectedCanonicalPath?: unknown;
  expectedBinding?: unknown;
};

function classifyFsError(err: unknown) {
  const safeCode = classifyFsSafeReadError(err);
  if (safeCode) {
    return safeCode;
  }
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
  const result = await runCommandBuffered(["du", "-sk", dirPath], {
    discardOutput: { stderr: true },
    maxOutputBytes: 64 * 1024,
    timeoutMs: 10_000,
  }).catch(() => null);
  if (!result || result.termination !== "exit" || result.code !== 0) {
    // `du` is optional; the capped tar command remains authoritative.
    return true;
  }
  const match = /^(\d+)/.exec(result.stdout.toString("utf8").trim());
  return match ? Number.parseInt(match[0], 10) <= heuristicKb : true;
}

async function listTreeEntries(
  root: string,
  maxEntries: number,
  expectedIdentity: FileIdentity,
): Promise<string[] | "TOO_MANY"> {
  const results: string[] = [];
  const rootHandle = await fsRoot(root);
  const boundStats = await fs.stat(rootHandle.rootReal, { bigint: true });
  if (!matchesFileIdentity(boundStats, expectedIdentity)) {
    throw Object.assign(new Error("filesystem identity differs from the authorized target"), {
      code: "CANONICAL_PATH_CHANGED",
    });
  }
  // Root.walk is core-only; plugins enumerate through the rooted list contract.
  async function visit(relativeDir: string): Promise<boolean> {
    const entries = await rootHandle.list(relativeDir, { withFileTypes: true });
    for (const entry of entries.toSorted(
      (left, right) => left.name.localeCompare(right.name) || (left.name < right.name ? -1 : 1),
    )) {
      const relativePath = path.posix.join(relativeDir, entry.name);
      results.push(relativePath);
      if (results.length > maxEntries) {
        return false;
      }
      if (entry.isDirectory && !(await visit(relativePath))) {
        return false;
      }
    }
    return true;
  }
  return (await visit(".")) ? results : "TOO_MANY";
}

export async function handleDirFetch(params: DirFetchParams) {
  const requestedPath = readAbsolutePath(params.path);
  if (typeof requestedPath !== "string") {
    return requestedPath;
  }

  const maxBytes = Math.min(
    Math.floor(asPositiveFiniteNumber(params.maxBytes) ?? DIR_FETCH_DEFAULT_MAX_BYTES),
    DIR_FETCH_HARD_MAX_BYTES,
  );
  const followSymlinks = params.followSymlinks === true;
  const preflightOnly = params.preflightOnly === true;

  const directory = await resolveBoundReadDirectory({
    requestedPath,
    followSymlinks,
    classifyError: classifyFsError,
    notFoundMessage: "directory not found",
    expectedCanonicalPath: params.expectedCanonicalPath,
    expectedBinding: params.expectedBinding,
  });
  if (!directory.ok) {
    return directory;
  }
  const { canonicalPath: canonical, identity } = directory;

  let preflightEntries: string[] | undefined;
  if (preflightOnly) {
    let entries: string[] | "TOO_MANY";
    try {
      entries = await listTreeEntries(canonical, DIR_FETCH_MAX_ENTRIES, identity);
    } catch (err) {
      const errorCode = err && typeof err === "object" && "code" in err ? err.code : undefined;
      const code =
        errorCode === "CANONICAL_PATH_CHANGED" ? "CANONICAL_PATH_CHANGED" : classifyFsError(err);
      return {
        ok: false as const,
        code,
        message: `preflight readdir failed: ${String(err)}`,
        canonicalPath: canonical,
      };
    }
    if (entries === "TOO_MANY") {
      return {
        ok: false as const,
        code: "TREE_TOO_LARGE",
        message: "directory tree exceeds 5000 entries during preflight",
        canonicalPath: canonical,
      };
    }

    preflightEntries = entries;
  } else if (!(await preflightDu(canonical, maxBytes))) {
    return {
      ok: false as const,
      code: "TREE_TOO_LARGE",
      message: `directory tree exceeds estimated size limit (${maxBytes} bytes raw)`,
      canonicalPath: canonical,
    };
  }

  // Preflight must build the capped archive so approval cannot accept an oversized tree.
  const tarBuffer = await createTarArchive(
    canonical,
    canonical,
    identity.device,
    identity.inode,
    maxBytes,
  );

  if (tarBuffer === "TOO_LARGE") {
    return {
      ok: false as const,
      code: "TREE_TOO_LARGE",
      message: `tarball exceeded ${maxBytes} byte limit ${preflightOnly ? "during preflight" : "mid-stream"}`,
      canonicalPath: canonical,
    };
  }
  if (tarBuffer === "TIMEOUT") {
    return {
      ok: false as const,
      code: "READ_ERROR",
      message: "tar command exceeded 60s wall-clock timeout (slow filesystem or symlink loop?)",
      canonicalPath: canonical,
    };
  }
  if (tarBuffer === "CANONICAL_PATH_CHANGED") {
    return {
      ok: false as const,
      code: "CANONICAL_PATH_CHANGED",
      message: "resolved path differs from the authorized target",
      canonicalPath: canonical,
    };
  }
  if (tarBuffer === "ERROR") {
    // Preflight preserves filesystem error classification after a tar race;
    // actual fetch reports the archive failure without another path lookup.
    if (preflightOnly) {
      const currentDirectory = await statRequiredDirectory(canonical, classifyFsError);
      if (!currentDirectory.ok) {
        return currentDirectory;
      }
    }
    return {
      ok: false as const,
      code: "READ_ERROR",
      message: "tar command failed",
      canonicalPath: canonical,
    };
  }

  if (preflightEntries) {
    return {
      ok: true as const,
      path: canonical,
      tarBase64: "",
      tarBytes: 0,
      sha256: "",
      fileCount: preflightEntries.length,
      entries: preflightEntries,
      preflightOnly: true,
      binding: { kind: "existing", ...identity } satisfies PathBinding,
    };
  }

  const sha256 = crypto.createHash("sha256").update(tarBuffer).digest("hex");
  const tarBase64 = tarBuffer.toString("base64");
  const tarBytes = tarBuffer.byteLength;
  let entries: string[];
  try {
    entries = await inspectDirFetchArchive(tarBuffer, 10_000);
  } catch (error) {
    return {
      ok: false as const,
      code: error instanceof ArchiveLimitError ? "TREE_TOO_LARGE" : "READ_ERROR",
      message: `archive inspection failed: ${formatErrorMessage(error)}`,
      canonicalPath: canonical,
    };
  }

  return {
    ok: true as const,
    path: canonical,
    tarBase64,
    tarBytes,
    sha256,
    fileCount: entries.length,
    entries,
    binding: { kind: "existing", ...identity } satisfies PathBinding,
  };
}
