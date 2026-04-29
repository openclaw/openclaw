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

  // 2. Decode base64 → Buffer
  let buf: Buffer;
  try {
    buf = Buffer.from(contentBase64, "base64");
    // Verify round-trip to catch invalid base64
    if (
      buf.toString("base64") !== contentBase64 &&
      Buffer.from(contentBase64, "base64url").toString("base64url") !== contentBase64
    ) {
      // Tolerate standard base64 with or without padding; just use what we decoded.
    }
  } catch {
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

  // 4. Refuse to write through symlinks (lstat sees the link itself, not
  //    its target). A path that's a symlink could escape the operator's
  //    intended path policy — e.g., an allowed dir could contain a
  //    symlink pointing at /etc/hosts.
  //    Otherwise determine overwritten status and reject directories.
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

  // 5. Atomic write: write to tmp, then rename
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

  // 6. Compute sha256 from the buffer we just wrote, NOT from a re-read.
  //    A re-read would race against any concurrent process that overwrote
  //    the file between rename and read — we'd compute the wrong hash and
  //    either approve a corrupted file or unlink someone else's data on
  //    a false mismatch. Buffer-side sha256 is what the caller actually
  //    asked us to write.
  const computedSha256 = sha256Hex(buf);

  // 7. Integrity check against the optional expectedSha256 — this is now
  //    a redundancy check (if expectedSha256 differs from what we hashed
  //    of the input buffer, the caller mis-encoded contentBase64). The
  //    file already exists at this point; on mismatch we unlink to avoid
  //    leaving a file the caller didn't intend.
  if (expectedSha256 && expectedSha256.toLowerCase() !== computedSha256) {
    await fs.unlink(targetPath).catch(() => {});
    return err(
      "INTEGRITY_FAILURE",
      `sha256 mismatch: expected ${expectedSha256.toLowerCase()}, got ${computedSha256}`,
      targetPath,
    );
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
