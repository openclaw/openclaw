import {
  canonicalizeBase64,
  estimateBase64DecodedBytes,
  saveMediaBuffer,
  unlinkIfExists,
} from "openclaw/plugin-sdk/media-runtime";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  assertBrowserProxyFileCountWithinLimit,
  assertBrowserProxyFileBytesWithinLimits,
  BROWSER_PROXY_MAX_FILE_BYTES,
  collectBrowserProxyFilePaths,
  type BrowserProxyFile,
  visitBrowserProxyFilePaths,
} from "../browser-proxy-envelope.js";

const INVALID_BROWSER_PROXY_FILE_ENVELOPE = "browser proxy returned an invalid file envelope";

function invalidBrowserProxyFileEnvelope(): never {
  throw new Error(INVALID_BROWSER_PROXY_FILE_ENVELOPE);
}

function validateBrowserProxyFiles(result: unknown, files: unknown): BrowserProxyFile[] {
  const referencedPaths = collectBrowserProxyFilePaths(result);
  const candidates = files === undefined ? [] : files;
  if (!Array.isArray(candidates)) {
    return invalidBrowserProxyFileEnvelope();
  }
  assertBrowserProxyFileCountWithinLimit(candidates.length);
  const validated: BrowserProxyFile[] = [];
  for (const value of candidates) {
    const file = asNullableRecord(value);
    if (
      !file ||
      typeof file.path !== "string" ||
      !file.path.trim() ||
      typeof file.base64 !== "string" ||
      (file.mimeType !== undefined && typeof file.mimeType !== "string") ||
      !referencedPaths.delete(file.path)
    ) {
      return invalidBrowserProxyFileEnvelope();
    }
    validated.push({
      path: file.path,
      base64: file.base64,
      ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
    });
  }
  if (referencedPaths.size > 0) {
    return invalidBrowserProxyFileEnvelope();
  }
  return validated;
}

function decodeBrowserProxyFileBase64(file: BrowserProxyFile, totalBytes: number): Buffer {
  const estimatedBytes = estimateBase64DecodedBytes(file.base64);
  assertBrowserProxyFileBytesWithinLimits(estimatedBytes, totalBytes + estimatedBytes);
  // The shared validator rejects empty input, but zero-byte downloads are valid files.
  const canonicalBase64 = file.base64 === "" ? "" : canonicalizeBase64(file.base64);
  if (canonicalBase64 === undefined) {
    throw new Error("browser proxy file contains malformed base64 data");
  }
  return Buffer.from(canonicalBase64, "base64");
}

/** Validate, persist, and rewrite every route-owned file in a node result. */
export async function persistBrowserProxyResultFiles(
  result: unknown,
  files: unknown,
  options?: { assertCurrent: () => Promise<void> | void },
) {
  const validatedFiles = validateBrowserProxyFiles(result, files);
  const decoded: Array<{ file: BrowserProxyFile; buffer: Buffer }> = [];
  const created: string[] = [];
  let totalBytes = 0;
  try {
    for (const file of validatedFiles) {
      const buffer = decodeBrowserProxyFileBase64(file, totalBytes);
      totalBytes += buffer.byteLength;
      decoded.push({ file, buffer });
    }
    const mapping = new Map<string, string>();
    for (const { file, buffer } of decoded) {
      await options?.assertCurrent();
      // saveMediaBuffer creates an exclusive, UUID-named file; existing references are not adopted.
      const saved = await saveMediaBuffer(
        buffer,
        file.mimeType,
        "browser",
        BROWSER_PROXY_MAX_FILE_BYTES,
        file.path,
      );
      created.push(saved.path);
      mapping.set(file.path, saved.path);
    }
    await options?.assertCurrent();
    visitBrowserProxyFilePaths(result, (filePath) => mapping.get(filePath));
    return result;
  } catch (error) {
    const settled = await Promise.allSettled(created.map((file) => unlinkIfExists(file)));
    const cleanupFailures = settled.flatMap((item) =>
      item.status === "rejected" ? [item.reason] : [],
    );
    if (cleanupFailures.length) {
      throw new AggregateError([error, ...cleanupFailures], "Browser export rollback failed", {
        cause: error,
      });
    }
    throw error;
  } finally {
    for (const { buffer } of decoded) {
      buffer.fill(0);
    }
  }
}
