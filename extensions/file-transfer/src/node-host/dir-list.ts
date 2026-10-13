import path from "node:path";
import {
  asPositiveFiniteNumber,
  parseStrictNonNegativeInteger,
} from "openclaw/plugin-sdk/number-runtime";
import { mimeFromExtension } from "../shared/mime.js";
import type { PathBinding } from "../shared/path-binding.js";
import { listCanonicalDirectory } from "./dir-list-worker.js";
import {
  classifyFsSafeReadError,
  readAbsolutePath,
  resolveBoundReadDirectory,
  statRequiredDirectory,
} from "./path-errors.js";

const DIR_LIST_DEFAULT_MAX_ENTRIES = 200;
const DIR_LIST_HARD_MAX_ENTRIES = 5000;

type DirListParams = {
  path?: unknown;
  pageToken?: unknown;
  maxEntries?: unknown;
  followSymlinks?: unknown;
  preflightOnly?: unknown;
  expectedCanonicalPath?: unknown;
  expectedBinding?: unknown;
};

function parsePageOffset(input: unknown): number {
  if (typeof input !== "string") {
    return 0;
  }
  return parseStrictNonNegativeInteger(input) ?? 0;
}

function classifyFsError(err: unknown) {
  const safeCode = classifyFsSafeReadError(err);
  if (safeCode) {
    return safeCode;
  }
  const code = (err as { code?: string } | null)?.code;
  if (code === "ENOENT") {
    return "NOT_FOUND";
  }
  if (code === "EACCES" || code === "EPERM") {
    return "PERMISSION_DENIED";
  }
  return "READ_ERROR";
}

export async function handleDirList(params: DirListParams) {
  const requestedPath = readAbsolutePath(params.path);
  if (typeof requestedPath !== "string") {
    return requestedPath;
  }

  const maxEntries = Math.min(
    Math.floor(asPositiveFiniteNumber(params.maxEntries) ?? DIR_LIST_DEFAULT_MAX_ENTRIES),
    DIR_LIST_HARD_MAX_ENTRIES,
  );
  const offset = parsePageOffset(params.pageToken);

  const followSymlinks = params.followSymlinks === true;

  const directory = await resolveBoundReadDirectory({
    requestedPath,
    followSymlinks,
    classifyError: classifyFsError,
    notFoundMessage: "path not found",
    expectedCanonicalPath: params.expectedCanonicalPath,
    expectedBinding: params.expectedBinding,
  });
  if (!directory.ok) {
    return directory;
  }
  const { canonicalPath: canonical, identity } = directory;
  if (params.preflightOnly === true) {
    return {
      ok: true as const,
      path: canonical,
      entries: [],
      truncated: false,
      preflight: true,
      binding: { kind: "existing", ...identity } satisfies PathBinding,
    };
  }

  const listing = await listCanonicalDirectory({
    directoryPath: canonical,
    expectedCanonicalPath: canonical,
    expectedDevice: identity.device,
    expectedInode: identity.inode,
    maxEntries,
    offset,
  });
  if (!listing.ok) {
    if (listing.code === "CANONICAL_PATH_CHANGED") {
      return {
        ok: false as const,
        code: "CANONICAL_PATH_CHANGED",
        message: "canonical path differs from the authorized target",
        canonicalPath: canonical,
      };
    }
    const currentDirectory = await statRequiredDirectory(canonical, classifyFsError);
    if (!currentDirectory.ok) {
      return currentDirectory;
    }
    return {
      ok: false as const,
      code: "READ_ERROR",
      message: "list failed",
      canonicalPath: canonical,
    };
  }
  const truncated = offset + maxEntries < listing.total;
  const nextPageToken = truncated ? String(offset + maxEntries) : undefined;
  return {
    ok: true as const,
    path: canonical,
    entries: listing.entries.map((entry) => ({
      name: entry.name,
      path: path.join(canonical, entry.name),
      size: entry.isDirectory ? 0 : entry.size,
      mimeType: entry.isDirectory ? "inode/directory" : mimeFromExtension(entry.name),
      isDir: entry.isDirectory,
      isFile: entry.isFile,
      mtime: entry.mtimeMs,
    })),
    nextPageToken,
    truncated,
    binding: { kind: "existing", ...identity } satisfies PathBinding,
  };
}
