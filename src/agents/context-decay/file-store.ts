import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export interface SwappedFileEntry {
  /** Absolute path to the file containing the original tool result. */
  filePath: string;
  /** Name of the tool that produced the result. */
  toolName: string;
  /** Heuristic hint summarizing the content (no LLM). */
  hint: string;
  /** Character count of the original content. */
  originalChars: number;
  /** ISO timestamp of when the swap occurred. */
  swappedAt: string;
}

/** Maps message index (position in transcript) to its swapped file entry. */
export type SwappedFileStore = Record<number, SwappedFileEntry>;

function swappedFileStorePath(sessionFilePath: string): string {
  const dir = path.dirname(sessionFilePath);
  const base = path.basename(sessionFilePath, path.extname(sessionFilePath));
  return path.join(dir, `${base}.swapped-results.json`);
}

/** Directory for individual tool result files, alongside the session file. */
export function resultsDir(sessionFilePath: string): string {
  const dir = path.dirname(sessionFilePath);
  const base = path.basename(sessionFilePath, path.extname(sessionFilePath));
  return path.join(dir, `${base}.results`);
}

/** Load the swapped file store for a session (async). Returns empty store on missing/invalid file. */
export async function loadSwappedFileStore(sessionFilePath: string): Promise<SwappedFileStore> {
  const filePath = swappedFileStorePath(sessionFilePath);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as SwappedFileStore;
    }
    return {};
  } catch {
    return {};
  }
}

/** Load the swapped file store for a session (synchronous). Returns empty store on missing/invalid file. */
export function loadSwappedFileStoreSync(sessionFilePath: string): SwappedFileStore {
  const filePath = swappedFileStorePath(sessionFilePath);
  try {
    const raw = fsSync.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as SwappedFileStore;
    }
    return {};
  } catch {
    return {};
  }
}

/** Atomically persist the swapped file store (tmp + rename). Creates directories as needed. */
export async function saveSwappedFileStore(
  sessionFilePath: string,
  store: SwappedFileStore,
): Promise<void> {
  const filePath = swappedFileStorePath(sessionFilePath);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(store, null, 2), "utf-8");
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/** Remove the swapped file store and results directory for a session. No-op if they don't exist. */
export async function clearSwappedFileStore(sessionFilePath: string): Promise<void> {
  const storePath = swappedFileStorePath(sessionFilePath);
  try {
    await fs.unlink(storePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const resDir = resultsDir(sessionFilePath);
  try {
    await fs.rm(resDir, { recursive: true, force: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}
