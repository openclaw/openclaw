import { constants } from "node:fs";
import fs from "node:fs/promises";

export function object(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  // SAFETY: Only plain property values remain unknown after the object guard.
  return value as Record<string, unknown>;
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function records(value: unknown): Record<string, unknown>[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => !object(entry))) {
    throw new Error("Grok returned an invalid source list.");
  }
  return value.map((entry) => object(entry)!);
}

export async function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(
    () => true,
    (error: unknown) => {
      if (object(error)?.code === "ENOENT") {
        return false;
      }
      throw error;
    },
  );
}

/** External source artifacts only; never open the source app's state writers. */
export async function readJson(
  file: string,
  limit = 25 * 1024 * 1024,
): Promise<Record<string, unknown>> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) {
      throw new Error("Grok source must be a bounded regular JSON file.");
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) {
        break;
      }
      length += read.bytesRead;
    }
    if (length > stat.size) {
      throw new Error("Grok source changed during its read. Retry the migration.");
    }
    try {
      const value = object(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))),
      );
      if (value) {
        return value;
      }
    } catch {
      // JSON errors can quote secret source content. Keep only a fixed diagnostic.
    }
    throw new Error("Grok source contains invalid JSON data.");
  } finally {
    await handle.close();
  }
}
