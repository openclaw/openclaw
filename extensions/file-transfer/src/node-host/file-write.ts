import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_CONTENT_BYTES = 16 * 1024 * 1024; // 16 MB

type FileWriteParams = {
  path: string;
  contentBase64: string;
  overwrite: boolean;
  createParents: boolean;
  expectedSha256?: string;
  followSymlinks?: boolean;
};

type FileWriteSuccess = {
  ok: true;
  path: string;
  size: number;
  sha256: string;
  overwritten: boolean;
};

type FileWriteError = {
  ok: false;
  code: string;
  message: string;
  canonicalPath?: string;
};

type FileWriteResult = FileWriteSuccess | FileWriteError;

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function err(code: string, message: string, canonicalPath?: string): FileWriteError {
  return { ok: false, code, message, ...(canonicalPath ? { canonicalPath } : {}) };
}

export async function handleFileWrite(
  params: Partial<FileWriteParams> & Record<string, unknown>,
): Promise<FileWriteResult> {
  const rawPath = typeof params?.path === "string" ? params.path : "";
  const contentBase64 = typeof params?.contentBase64 === "string" ? params.contentBase64 : "";
  const overwrite = params?.overwrite === true;
  const createParents = params?.createParents === true;
  const expectedSha256 =
    typeof params?.expectedSha256 === "string" ? params.expectedSha256 : undefined;
  const followSymlinks = params?.followSymlinks === true;

  // 1. Validate path: must be absolute, non-empty, no NUL byte
  if (!rawPath) {
    return err("INVALID_PATH", "path is required");
  }
  if (rawPath.includes("\0")) {
    return err("INVALID_PATH", "path must not contain NUL bytes");
  }
  if (!path.isAbsolute(rawPath)) {
    return err("INVALID_PATH", "path must be absolute");
  }

  // 2. Decode base64 → Buffer.
  //    Buffer.from(s, "base64") in Node never throws — it silently drops
  //    non-base64 characters and returns whatever it could decode. That
  //    means a typo or truncated input would land garbage on disk if we
  //    accepted whatever decoded. Defense: round-trip the decoded buffer
  //    back to base64 and compare against the input modulo padding/url
  //    variants. A mismatch means characters were silently dropped.
  const buf = Buffer.from(contentBase64, "base64");
  const reEncoded = buf.toString("base64");
  // Normalize: drop padding and convert base64url chars to standard so the
  // comparison tolerates both "=" / no-"=" inputs and "-_" base64url.
  const normalize = (s: string): string =>
    s.replace(/=+$/u, "").replace(/-/gu, "+").replace(/_/gu, "/");
  if (normalize(reEncoded) !== normalize(contentBase64)) {
    return err("INVALID_BASE64", "contentBase64 is not valid base64");
  }

  if (buf.length > MAX_CONTENT_BYTES) {
    return err(
      "FILE_TOO_LARGE",
      `decoded content is ${buf.length} bytes; maximum is ${MAX_CONTENT_BYTES} bytes (16 MB)`,
    );
  }

  // 3. Resolve parent dir
  const targetPath = path.normalize(rawPath);
  const parentDir = path.dirname(targetPath);

  let parentExists = false;
  try {
    await fs.access(parentDir);
    parentExists = true;
  } catch {
    parentExists = false;
  }

  if (!parentExists) {
    if (!createParents) {
      return err("PARENT_NOT_FOUND", `parent directory does not exist: ${parentDir}`);
    }
    try {
      await fs.mkdir(parentDir, { recursive: true });
    } catch (mkdirErr) {
      const message = mkdirErr instanceof Error ? mkdirErr.message : String(mkdirErr);
      return err("WRITE_ERROR", `failed to create parent directories: ${message}`);
    }
  }

  // 4. Refuse symlink traversal in the parent path. The file may not
  //    exist yet, so realpath the PARENT and check it matches the
  //    lexical parent. This catches the case where ~/Downloads/evil is
  //    a symlink to /etc and the agent asks to write
  //    ~/Downloads/evil/passwd — the lexical parent doesn't match the
  //    canonical parent, so we refuse before any write happens.
  //    The lstat-on-final check below still runs to catch the case
  //    where the target file itself exists as a symlink.
  if (!followSymlinks) {
    let canonicalParent: string;
    try {
      canonicalParent = await fs.realpath(parentDir);
    } catch (e) {
      // realpath shouldn't fail if we just confirmed parentExists or
      // mkdir'd it; if it does, the subsequent write will produce a
      // clearer error.
      canonicalParent = parentDir;
      void e;
    }
    if (canonicalParent !== parentDir) {
      return err(
        "SYMLINK_REDIRECT",
        `parent ${parentDir} resolves through a symlink to ${canonicalParent}; refusing because followSymlinks=false (set gateway.nodes.fileTransfer.<node>.followSymlinks=true to allow, or update allowWritePaths to the canonical path)`,
        path.join(canonicalParent, path.basename(targetPath)),
      );
    }
  }
  let overwritten = false;
  try {
    const existingLStat = await fs.lstat(targetPath);
    if (existingLStat.isSymbolicLink()) {
      return err(
        "SYMLINK_TARGET_DENIED",
        `path is a symlink; refusing to write through it: ${targetPath}`,
      );
    }
    if (existingLStat.isDirectory()) {
      return err("IS_DIRECTORY", `path resolves to a directory: ${targetPath}`);
    }
    if (!overwrite) {
      return err(
        "EXISTS_NO_OVERWRITE",
        `file already exists and overwrite is false: ${targetPath}`,
      );
    }
    overwritten = true;
  } catch (statErr: unknown) {
    // ENOENT is fine — file does not exist yet
    if ((statErr as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = statErr instanceof Error ? statErr.message : String(statErr);
      if (message.toLowerCase().includes("permission")) {
        return err("PERMISSION_DENIED", `permission denied: ${targetPath}`);
      }
      return err("WRITE_ERROR", `unexpected stat error: ${message}`);
    }
  }

  // 5. Hash the decoded buffer BEFORE touching disk. If the caller
  //    supplied expectedSha256 and it doesn't match, refuse outright so
  //    a bad caller hash with overwrite=true can't replace + delete the
  //    original. Computing from the buffer (not a re-read) is the right
  //    source of truth — the caller asked us to write THESE bytes.
  const computedSha256 = sha256Hex(buf);
  if (expectedSha256 && expectedSha256.toLowerCase() !== computedSha256) {
    return err(
      "INTEGRITY_FAILURE",
      `sha256 mismatch: expected ${expectedSha256.toLowerCase()}, got ${computedSha256}`,
      targetPath,
    );
  }

  // 6. Atomic write: write to tmp, then rename
  const tmpSuffix = crypto.randomBytes(8).toString("hex");
  const tmpPath = `${targetPath}.${tmpSuffix}.tmp`;

  try {
    await fs.writeFile(tmpPath, buf);
  } catch (writeErr) {
    const message = writeErr instanceof Error ? writeErr.message : String(writeErr);
    // Clean up tmp if possible
    await fs.unlink(tmpPath).catch(() => {});
    if (message.toLowerCase().includes("permission") || message.toLowerCase().includes("access")) {
      return err("PERMISSION_DENIED", `permission denied writing to: ${parentDir}`);
    }
    return err("WRITE_ERROR", `failed to write file: ${message}`);
  }

  try {
    await fs.rename(tmpPath, targetPath);
  } catch (renameErr) {
    const message = renameErr instanceof Error ? renameErr.message : String(renameErr);
    await fs.unlink(tmpPath).catch(() => {});
    if (message.toLowerCase().includes("permission") || message.toLowerCase().includes("access")) {
      return err("PERMISSION_DENIED", `permission denied renaming to: ${targetPath}`);
    }
    return err("WRITE_ERROR", `failed to rename tmp to target: ${message}`);
  }

  const writtenBuf = buf;

  // 8. Re-realpath to resolve any symlinks in the final path
  let canonicalPath = targetPath;
  try {
    canonicalPath = await fs.realpath(targetPath);
  } catch {
    // Best effort; use normalized path as fallback
    canonicalPath = targetPath;
  }

  return {
    ok: true,
    path: canonicalPath,
    size: writtenBuf.length,
    sha256: computedSha256,
    overwritten,
  };
}
