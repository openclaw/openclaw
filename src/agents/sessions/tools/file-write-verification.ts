import { stat as fsStat } from "node:fs/promises";

export type PersistedFileStat = {
  type: "file" | "directory" | "other";
  size: number;
  mtimeMs?: number;
};

export async function readPersistedFileStat(
  absolutePath: string,
  isMissing: (error: unknown) => boolean,
): Promise<PersistedFileStat | null> {
  try {
    const stat = await fsStat(absolutePath);
    return {
      type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

type PersistedUtf8FileOperations = {
  readFile: (absolutePath: string) => Promise<Buffer | string>;
  statFile: (absolutePath: string) => Promise<PersistedFileStat | null>;
};

export async function verifyPersistedUtf8File(
  absolutePath: string,
  content: string,
  operations: PersistedUtf8FileOperations,
): Promise<boolean> {
  // Success receipts must prove the same regular-file bytes across local and delegated writes.
  // Compare encoded bytes because UTF-8 writes normalize invalid surrogate code units.
  const expectedContent = Buffer.from(content, "utf8");
  const stat = await operations.statFile(absolutePath).catch(() => null);
  if (!stat || stat.type !== "file" || stat.size !== expectedContent.byteLength) {
    return false;
  }
  const readback = await operations.readFile(absolutePath).catch(() => undefined);
  if (readback === undefined) {
    return false;
  }
  const persistedContent = Buffer.isBuffer(readback) ? readback : Buffer.from(readback, "utf8");
  return persistedContent.equals(expectedContent);
}
