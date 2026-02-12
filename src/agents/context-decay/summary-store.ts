import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export interface SummaryEntry {
  /** The summarized text replacing the original tool result. */
  summary: string;
  /** Estimated token count of the original content. */
  originalTokenEstimate: number;
  /** Estimated token count of the summary. */
  summaryTokenEstimate: number;
  /** ISO timestamp of when the summary was created. */
  summarizedAt: string;
  /** Model used for summarization. */
  model: string;
}

/** Maps message index (position in transcript) to its summary. */
export type SummaryStore = Record<number, SummaryEntry>;

export interface GroupSummaryEntry {
  /** The coherent summary for the entire window. */
  summary: string;
  /** Index of the anchor message (first user message in window). */
  anchorIndex: number;
  /** All message indices in this window. */
  indices: number[];
  /** [oldest turn age, newest turn age] at summarization time. */
  turnRange: [number, number];
  /** Estimated token count of original window content. */
  originalTokenEstimate: number;
  /** Estimated token count of the summary. */
  summaryTokenEstimate: number;
  /** ISO timestamp of when the summary was created. */
  summarizedAt: string;
  /** Model used for summarization. */
  model: string;
}

export type GroupSummaryStore = GroupSummaryEntry[];

function summaryStorePath(sessionFilePath: string): string {
  const dir = path.dirname(sessionFilePath);
  const base = path.basename(sessionFilePath, path.extname(sessionFilePath));
  return path.join(dir, `${base}.summaries.json`);
}

/**
 * Load the summary store for a session (async). Returns empty store on missing/invalid file.
 * Note: individual entries are not validated beyond `typeof === "object"` — callers trust
 * the local file as a persistence boundary. Zod validation happens at config load time.
 */
export async function loadSummaryStore(sessionFilePath: string): Promise<SummaryStore> {
  const filePath = summaryStorePath(sessionFilePath);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as SummaryStore;
    }
    return {};
  } catch {
    return {};
  }
}

/** Load the summary store for a session (synchronous). Returns empty store on missing/invalid file. */
export function loadSummaryStoreSync(sessionFilePath: string): SummaryStore {
  const filePath = summaryStorePath(sessionFilePath);
  try {
    const raw = fsSync.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as SummaryStore;
    }
    return {};
  } catch {
    return {};
  }
}

/** Remove the summary store file for a session. No-op if the file doesn't exist. */
export async function clearSummaryStore(sessionFilePath: string): Promise<void> {
  const filePath = summaryStorePath(sessionFilePath);
  try {
    await fs.unlink(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Group Summary Store
// ---------------------------------------------------------------------------

function groupSummaryStorePath(sessionFilePath: string): string {
  const dir = path.dirname(sessionFilePath);
  const base = path.basename(sessionFilePath, path.extname(sessionFilePath));
  return path.join(dir, `${base}.group-summaries.json`);
}

/** Load the group summary store for a session (async). Returns empty array on missing/invalid file. */
export async function loadGroupSummaryStore(sessionFilePath: string): Promise<GroupSummaryStore> {
  const filePath = groupSummaryStorePath(sessionFilePath);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as GroupSummaryStore;
    }
    return [];
  } catch {
    return [];
  }
}

/** Load the group summary store for a session (synchronous). Returns empty array on missing/invalid file. */
export function loadGroupSummaryStoreSync(sessionFilePath: string): GroupSummaryStore {
  const filePath = groupSummaryStorePath(sessionFilePath);
  try {
    const raw = fsSync.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as GroupSummaryStore;
    }
    return [];
  } catch {
    return [];
  }
}

/** Remove the group summary store file for a session. No-op if the file doesn't exist. */
export async function clearGroupSummaryStore(sessionFilePath: string): Promise<void> {
  const filePath = groupSummaryStorePath(sessionFilePath);
  try {
    await fs.unlink(filePath);
  } catch {
    // File doesn't exist — nothing to clear.
  }
}

/** Atomically persist the group summary store (tmp + rename). Creates directories as needed. */
export async function saveGroupSummaryStore(
  sessionFilePath: string,
  store: GroupSummaryStore,
): Promise<void> {
  const filePath = groupSummaryStorePath(sessionFilePath);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(store, null, 2), "utf-8");
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    // Clean up tmp file on failure
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Individual Summary Store (persistence)
// ---------------------------------------------------------------------------

/** Atomically persist the summary store (tmp + rename). Creates directories as needed. */
export async function saveSummaryStore(
  sessionFilePath: string,
  store: SummaryStore,
): Promise<void> {
  const filePath = summaryStorePath(sessionFilePath);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(store, null, 2), "utf-8");
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    // Clean up tmp file on failure
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}
