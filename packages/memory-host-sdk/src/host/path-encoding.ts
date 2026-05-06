import crypto from "node:crypto";
import path from "node:path";

export type MemoryPathEncodingMode = "hash" | "whitelist";

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HASH_LEN = 32;

export class PathEncodingError extends Error {}

export function encodeUserSegment(userId: string, mode: MemoryPathEncodingMode = "hash"): string {
  if (mode === "whitelist") {
    if (typeof userId !== "string" || userId.length === 0) {
      throw new PathEncodingError("userId must be a non-empty string in whitelist mode");
    }
    if (userId === "." || userId === "..") {
      throw new PathEncodingError("userId may not be . or ..");
    }
    if (!SAFE_ID_RE.test(userId)) {
      throw new PathEncodingError(
        "userId contains characters outside [A-Za-z0-9_-] or exceeds 64 chars",
      );
    }
    return userId;
  }
  return crypto.createHash("sha256").update(userId, "utf8").digest("hex").slice(0, HASH_LEN);
}

export function resolveUserMemoryDir(
  memoryRoot: string,
  userId: string,
  mode: MemoryPathEncodingMode = "hash",
): string {
  const segment = encodeUserSegment(userId, mode);
  const baseAbs = path.resolve(memoryRoot);
  const resolved = path.resolve(baseAbs, segment);
  const baseWithSep = baseAbs.endsWith(path.sep) ? baseAbs : baseAbs + path.sep;
  if (!resolved.startsWith(baseWithSep)) {
    throw new PathEncodingError("resolved user memory dir escapes memory root");
  }
  return resolved;
}
