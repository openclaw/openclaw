import crypto from "node:crypto";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { readFileHandleBounded } from "openclaw/plugin-sdk/file-access-runtime";
import { detectMime } from "openclaw/plugin-sdk/media-mime";
import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import { asPositiveFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import { FsSafeError, root } from "openclaw/plugin-sdk/security-runtime";
import {
  FILE_FETCH_CHUNK_BYTES,
  FILE_FETCH_DEFAULT_MAX_BYTES,
  FILE_FETCH_HARD_MAX_BYTES,
  readFileFetchBinaryMaxBytes,
} from "../shared/file-fetch-protocol.js";
import {
  fileIdentity,
  matchesFileIdentity,
  readPathBinding,
  type PathBinding,
} from "../shared/path-binding.js";
import {
  createReadErrorClassifier,
  readAbsolutePath,
  rejectCanonicalPathChange,
  resolveCanonicalReadPath,
} from "./path-errors.js";

const TEXT_SNIFF_MAX_BYTES = 8192;

type FileFetchParams = {
  path?: unknown;
  /** Optional canonical root: follow parent aliases within it, never the final file. */
  rootPath?: unknown;
  maxBytes?: unknown;
  transport?: unknown;
  followSymlinks?: unknown;
  preflightOnly?: unknown;
  expectedCanonicalPath?: unknown;
  expectedBinding?: unknown;
};

const classifyReadError = createReadErrorClassifier({
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  "not-file": "IS_DIRECTORY",
  ENOENT: "NOT_FOUND",
  EACCES: "PERMISSION_DENIED",
  EPERM: "PERMISSION_DENIED",
  EISDIR: "IS_DIRECTORY",
} as const);

function classifyFsError(error: unknown) {
  return error instanceof FsSafeError && error.code === "too-large"
    ? "FILE_TOO_LARGE"
    : classifyReadError(error);
}

function isLikelyPlainText(buffer: Buffer): boolean {
  if (buffer.byteLength === 0) {
    return true;
  }
  const sample = buffer.subarray(0, TEXT_SNIFF_MAX_BYTES);
  if (sample.includes(0)) {
    return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
  } catch {
    return false;
  }
  let controlBytes = 0;
  for (const byte of sample) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      controlBytes += 1;
    }
  }
  return controlBytes / sample.byteLength < 0.01;
}

export async function handleFileFetch(
  params: FileFetchParams,
  io?: OpenClawPluginNodeHostCommandIo,
) {
  const requestedPath = readAbsolutePath(params.path);
  if (typeof requestedPath !== "string") {
    return requestedPath;
  }

  let binaryMax: number | undefined;
  try {
    binaryMax = readFileFetchBinaryMaxBytes(params);
  } catch (error) {
    return { ok: false as const, code: "INVALID_PARAMS", message: String(error) };
  }
  const maxBytes =
    binaryMax ??
    Math.min(
      Math.floor(asPositiveFiniteNumber(params.maxBytes) ?? FILE_FETCH_DEFAULT_MAX_BYTES),
      FILE_FETCH_HARD_MAX_BYTES,
    );
  const followSymlinks = params.followSymlinks === true;
  const preflightOnly = params.preflightOnly === true;

  const requestedRoot =
    params.rootPath === undefined ? undefined : readAbsolutePath(params.rootPath);
  if (requestedRoot !== undefined && typeof requestedRoot !== "string") {
    return requestedRoot;
  }

  const canonical = await resolveCanonicalReadPath({
    requestedPath: requestedRoot ?? requestedPath,
    followSymlinks: requestedRoot === undefined && followSymlinks,
    classifyError: classifyFsError,
    notFoundMessage: "file not found",
  });
  if (typeof canonical !== "string") {
    return canonical;
  }

  let opened: Awaited<ReturnType<Awaited<ReturnType<typeof root>>["open"]>>;
  try {
    if (requestedRoot !== undefined) {
      const readRoot = await root(canonical);
      opened = await readRoot.open(path.relative(canonical, requestedPath), {
        symlinks: followSymlinks ? "follow-parents-within-root" : "reject",
      });
    } else {
      const parentRoot = await root(path.dirname(canonical));
      opened = await parentRoot.open(path.basename(canonical));
    }
  } catch (err) {
    const code = classifyFsError(err);
    return {
      ok: false as const,
      code,
      message: code === "IS_DIRECTORY" ? "path is a directory" : `open failed: ${String(err)}`,
      canonicalPath: canonical,
    };
  }

  try {
    const canonicalPathChange = rejectCanonicalPathChange(
      params.expectedCanonicalPath,
      opened.realPath,
    );
    if (canonicalPathChange) {
      return canonicalPathChange;
    }
    const stats = opened.stat;
    const identityStats = await opened.handle.stat({ bigint: true });
    const identity = fileIdentity(identityStats);
    const expectedBinding = readPathBinding(params.expectedBinding);
    if (
      (params.expectedBinding !== undefined && expectedBinding?.kind !== "existing") ||
      (expectedBinding?.kind === "existing" && !matchesFileIdentity(identityStats, expectedBinding))
    ) {
      return {
        ok: false as const,
        code: "CANONICAL_PATH_CHANGED",
        message: "filesystem identity differs from the authorized target",
        canonicalPath: opened.realPath,
      };
    }
    if (stats.size > maxBytes) {
      return {
        ok: false as const,
        code: "FILE_TOO_LARGE",
        message: `file size ${stats.size} exceeds limit ${maxBytes}`,
        canonicalPath: opened.realPath,
      };
    }

    if (preflightOnly) {
      return {
        ok: true as const,
        path: opened.realPath,
        size: stats.size,
        mimeType: "",
        base64: "",
        sha256: "",
        preflightOnly: true,
        binding: { kind: "existing", ...identity } satisfies PathBinding,
      };
    }

    if (binaryMax !== undefined) {
      if (!io?.frames || expectedBinding?.kind !== "existing") {
        return {
          ok: false as const,
          code: "INVALID_PARAMS",
          message: "binary file.fetch requires duplex IO and an authorized filesystem binding",
        };
      }
      const frames = io.frames;
      if (!frames) {
        throw new Error("binary file.fetch requires framed duplex IO");
      }
      io.signal.throwIfAborted();
      let expected: "start" | "ack" | undefined = "start";
      let receipt = createDeferred<void>();
      void receipt.promise.catch(() => {});
      const onAbort = () => receipt.reject(io.signal.reason);
      io.signal.addEventListener("abort", onAbort, { once: true });
      let unsubscribe: (() => void) | undefined;
      try {
        unsubscribe = frames.onMessage((message) => {
          if (!expected || Buffer.from(message).toString("utf8") !== expected) {
            const error = new Error("Unexpected file.fetch stream control");
            receipt.reject(error);
            throw error;
          }
          expected = undefined;
          receipt.resolve();
        });
        // Readiness is sent by onMessage. Do not send bytes until the caller subscribes.
        io.signal.throwIfAborted();
        await receipt.promise;
        const chunk = Buffer.allocUnsafe(FILE_FETCH_CHUNK_BYTES);
        const hash = crypto.createHash("sha256");
        let size = 0;
        while (true) {
          io.signal.throwIfAborted();
          const { bytesRead } = await opened.handle.read(
            chunk,
            0,
            Math.min(chunk.length, maxBytes - size + 1),
          );
          io.signal.throwIfAborted();
          if (!bytesRead) {
            return {
              ok: true as const,
              path: opened.realPath,
              size,
              sha256: hash.digest("hex"),
              transport: "binary" as const,
              mimeType: "",
              base64: "",
              binding: { kind: "existing", ...identity } satisfies PathBinding,
            };
          }
          size += bytesRead;
          if (size > maxBytes) {
            throw Object.assign(new Error("file grew beyond the authorized byte limit"), {
              code: "FILE_TOO_LARGE",
            });
          }
          const bytes = chunk.subarray(0, bytesRead);
          hash.update(bytes);
          receipt = createDeferred<void>();
          // Observe rejection if abort happens while send is still pending.
          void receipt.promise.catch(() => {});
          expected = "ack";
          await frames.send(bytes);
          await receipt.promise;
        }
      } finally {
        unsubscribe?.();
        io.signal.removeEventListener("abort", onAbort);
      }
    }

    const buffer = await readFileHandleBounded(opened.handle, maxBytes);

    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const base64 = buffer.toString("base64");
    const detectedMime = await detectMime({ buffer, filePath: opened.realPath });
    const mimeType =
      detectedMime || (isLikelyPlainText(buffer) ? "text/plain" : "application/octet-stream");

    return {
      ok: true as const,
      path: opened.realPath,
      size: buffer.byteLength,
      mimeType,
      base64,
      sha256,
      binding: { kind: "existing", ...identity } satisfies PathBinding,
    };
  } catch (err) {
    const code = classifyFsError(err);
    return {
      ok: false as const,
      code,
      message: `read failed: ${String(err)}`,
      canonicalPath: opened.realPath,
    };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}
