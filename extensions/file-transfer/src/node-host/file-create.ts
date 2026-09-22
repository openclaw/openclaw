import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import {
  canonicalPathFromExistingAncestor,
  extractErrorCode,
  FsSafeError,
  resolveAbsolutePathForWrite,
} from "openclaw/plugin-sdk/security-runtime";
import { FILE_CREATE_CHUNK_BYTES, readFileCreateMetadata } from "../shared/file-create-protocol.js";
import {
  fileIdentity,
  matchesFileIdentity,
  readPathBinding,
  type PathBinding,
} from "../shared/path-binding.js";
import {
  canonicalTargetForSymlinkError,
  captureWriteBinding,
  openBoundWriteRoot,
  symlinkRedirectError,
  writeFsSafeError,
  type FileWriteError,
} from "./file-write-path.js";
import { rejectCanonicalPathChange } from "./path-errors.js";

function failure(code: string, message: string): FileWriteError {
  return { ok: false, code, message };
}

async function receiveContent(
  io: OpenClawPluginNodeHostCommandIo,
  metadata: ReturnType<typeof readFileCreateMetadata>,
): Promise<Buffer[]> {
  const frames = io.frames;
  if (!frames) {
    throw new Error("file.create requires binary duplex transport");
  }
  io.signal.throwIfAborted();
  const chunks: Buffer[] = [];
  const hash = crypto.createHash("sha256");
  let received = 0;
  let ended = false;
  let unsubscribe: (() => void) | undefined;
  let removeAbortListener: (() => void) | undefined;
  try {
    return await new Promise<Buffer[]>((resolve, reject) => {
      const abort = () => {
        const reason: unknown = io.signal.reason;
        reject(reason instanceof Error ? reason : new Error("file.create cancelled"));
      };
      io.signal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () => io.signal.removeEventListener("abort", abort);
      const fail = (error: unknown) => {
        ended = true;
        io.signal.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      unsubscribe = frames.onMessage(async (message) => {
        try {
          io.signal.throwIfAborted();
          if (ended) {
            throw new Error("file.create input is out of sequence");
          }
          if (message.byteLength === 0) {
            ended = true;
            if (received !== metadata.sizeBytes || hash.digest("hex") !== metadata.expectedSha256) {
              throw new Error("file.create content size or digest does not match");
            }
            io.signal.removeEventListener("abort", abort);
            resolve(chunks);
            return;
          }
          if (
            message.byteLength > FILE_CREATE_CHUNK_BYTES ||
            received + message.byteLength > metadata.sizeBytes
          ) {
            throw new Error("file.create chunk exceeds the admitted byte limit");
          }
          const chunk = Buffer.from(message);
          received += chunk.byteLength;
          hash.update(chunk);
          chunks.push(chunk);
          // Duplex send waits for transport writes, not completion of the peer's listener.
          // One ACK per chunk keeps producer delivery bounded until the next chunk.
          await frames.send(Buffer.from("ack"));
        } catch (error) {
          fail(error);
        }
      });
    });
  } finally {
    unsubscribe?.();
    removeAbortListener?.();
  }
}

/** Create-only streaming counterpart of file.write; preflight never subscribes to input. */
export async function handleFileCreate(
  params: Record<string, unknown>,
  io?: OpenClawPluginNodeHostCommandIo,
) {
  let metadata: ReturnType<typeof readFileCreateMetadata>;
  try {
    metadata = readFileCreateMetadata(params);
  } catch (error) {
    return failure("INVALID_PARAMS", String(error));
  }
  const rawPath = typeof params.path === "string" ? params.path : "";
  const followSymlinks = params.followSymlinks === true;
  io?.signal.throwIfAborted();
  let target;
  try {
    target = await resolveAbsolutePathForWrite(rawPath, {
      symlinks: followSymlinks ? "follow" : "reject",
    });
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "symlink") {
      return symlinkRedirectError(
        "SYMLINK_REDIRECT",
        await canonicalTargetForSymlinkError(error, rawPath),
      );
    }
    return failure("INVALID_PATH", String(error));
  }
  if (!target.parentExists && params.createParents !== true) {
    return failure("PARENT_NOT_FOUND", "parent directory does not exist");
  }
  const canonicalPath = await canonicalPathFromExistingAncestor(target.path);
  const changed = rejectCanonicalPathChange(params.expectedCanonicalPath, canonicalPath);
  if (changed) {
    return changed;
  }
  let existing;
  try {
    existing = await fs.lstat(target.path, { bigint: true });
    if (!existing.isFile()) {
      return failure("NOT_FILE", "create target is not a regular file");
    }
  } catch (error) {
    if (extractErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }
  if (params.preflightOnly === true) {
    return {
      ok: true as const,
      path: canonicalPath,
      size: metadata.sizeBytes,
      sha256: metadata.expectedSha256,
      binding: await captureWriteBinding(canonicalPath, existing && fileIdentity(existing)),
    };
  }
  const binding = readPathBinding(params.expectedBinding);
  if (binding?.kind !== "write") {
    return failure("CANONICAL_PATH_CHANGED", "file.create requires its authorized write binding");
  }
  if (
    binding.targetDevice !== undefined &&
    (!existing ||
      !matchesFileIdentity(existing, { device: binding.targetDevice, inode: binding.targetInode! }))
  ) {
    return failure("CANONICAL_PATH_CHANGED", "create target changed after authorization");
  }
  const anchor = await openBoundWriteRoot({ binding, canonicalTargetPath: canonicalPath });
  if (!anchor.ok) {
    return anchor;
  }
  if (!io?.frames) {
    return failure("DUPLEX_REQUIRED", "file.create requires binary duplex transport");
  }
  const chunks = await receiveContent(io, metadata);
  io.signal.throwIfAborted();
  const { anchorRoot, relativeTarget } = anchor;
  let status: "created" | "exists" = "created";
  try {
    // Streamed fs-safe creation stages privately and publishes without replacing an existing
    // name, including on its JavaScript backend. The final name never contains partial bytes.
    await anchorRoot.create(
      relativeTarget,
      (async function* () {
        yield* chunks;
      })(),
      {
        mkdir: params.createParents === true,
        mode: 0o600,
        maxBytes: metadata.sizeBytes,
        signal: io.signal,
        assertBeforeMutation: () => io.signal.throwIfAborted(),
      },
    );
  } catch (error) {
    io.signal.throwIfAborted();
    if (!(error instanceof FsSafeError)) {
      throw error;
    }
    if (error.code !== "already-exists") {
      return writeFsSafeError(error, canonicalPath);
    }
    status = "exists";
  }
  const opened = await anchorRoot.open(relativeTarget, { symlinks: "reject" });
  try {
    io.signal.throwIfAborted();
    const stats = await opened.handle.stat({ bigint: true });
    if (!stats.isFile()) {
      return failure("NOT_FILE", "create target is not a regular file");
    }
    return {
      ok: true as const,
      path: opened.realPath,
      status,
      ...(status === "created"
        ? { size: metadata.sizeBytes, sha256: metadata.expectedSha256 }
        : {}),
      binding: { kind: "existing", ...fileIdentity(stats) } satisfies PathBinding,
    };
  } finally {
    await opened.handle.close();
  }
}
