import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  type CompactionEntry,
  type SessionEntry,
  type SessionHeader,
} from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type ReadonlySessionManagerForRotation = Pick<
  SessionManager,
  "buildSessionContext" | "getBranch" | "getCwd" | "getHeader"
>;

export type CompactionTranscriptRotation = {
  rotated: boolean;
  reason?: string;
  sessionId?: string;
  sessionFile?: string;
  compactionEntryId?: string;
  leafId?: string;
  entriesWritten?: number;
};

export function shouldRotateCompactionTranscript(config?: OpenClawConfig): boolean {
  return config?.agents?.defaults?.compaction?.truncateAfterCompaction === true;
}

export async function rotateTranscriptAfterCompaction(params: {
  sessionManager: ReadonlySessionManagerForRotation;
  sessionFile: string;
  now?: () => Date;
}): Promise<CompactionTranscriptRotation> {
  const sessionFile = params.sessionFile.trim();
  if (!sessionFile) {
    return { rotated: false, reason: "missing session file" };
  }

  const branch = params.sessionManager.getBranch();
  const latestCompactionIndex = findLatestCompactionIndex(branch);
  if (latestCompactionIndex < 0) {
    return { rotated: false, reason: "no compaction entry" };
  }

  const compaction = branch[latestCompactionIndex] as CompactionEntry;
  const timestamp = (params.now?.() ?? new Date()).toISOString();
  const sessionId = randomUUID();
  const successorFile = resolveSuccessorSessionFile({
    sessionFile,
    sessionId,
    timestamp,
  });
  const successorEntries = buildSuccessorEntries({
    branch,
    latestCompactionIndex,
  });
  if (successorEntries.length === 0) {
    return { rotated: false, reason: "empty successor transcript" };
  }

  const header = buildSuccessorHeader({
    previousHeader: params.sessionManager.getHeader(),
    sessionId,
    timestamp,
    cwd: params.sessionManager.getCwd(),
    parentSession: sessionFile,
  });
  await writeSessionFileAtomic(successorFile, [header, ...successorEntries]);

  try {
    SessionManager.open(successorFile).buildSessionContext();
  } catch (err) {
    await fs.unlink(successorFile).catch(() => undefined);
    throw err;
  }

  return {
    rotated: true,
    sessionId,
    sessionFile: successorFile,
    compactionEntryId: compaction.id,
    leafId: successorEntries[successorEntries.length - 1]?.id,
    entriesWritten: successorEntries.length,
  };
}

function findLatestCompactionIndex(entries: SessionEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "compaction") {
      return index;
    }
  }
  return -1;
}

function buildSuccessorEntries(params: {
  branch: SessionEntry[];
  latestCompactionIndex: number;
}): SessionEntry[] {
  const { branch, latestCompactionIndex } = params;
  const compaction = branch[latestCompactionIndex] as CompactionEntry;
  const firstKeptIndex = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  const keptBeforeCompaction =
    firstKeptIndex >= 0 && firstKeptIndex < latestCompactionIndex
      ? branch.slice(firstKeptIndex, latestCompactionIndex)
      : [];
  const afterCompaction = branch.slice(latestCompactionIndex + 1);
  const statePrefix = collectLatestStatePrefix(branch.slice(0, latestCompactionIndex));
  const successorEntries: SessionEntry[] = [];
  const seenIds = new Set<string>();
  let parentId: string | null = null;

  const append = (entry: SessionEntry) => {
    if (seenIds.has(entry.id)) {
      return;
    }
    const nextEntry = { ...entry, parentId } as SessionEntry;
    successorEntries.push(nextEntry);
    seenIds.add(nextEntry.id);
    parentId = nextEntry.id;
  };

  for (const entry of statePrefix) {
    append(entry);
  }
  append(compaction);
  for (const entry of [...keptBeforeCompaction, ...afterCompaction]) {
    if (entry.type === "compaction" || entry.type === "label") {
      continue;
    }
    append(entry);
  }
  const retainedIds = new Set(successorEntries.map((entry) => entry.id));
  for (const entry of branch) {
    if (entry.type !== "label" || !retainedIds.has(entry.targetId)) {
      continue;
    }
    append(entry);
  }
  return successorEntries;
}

function collectLatestStatePrefix(entries: SessionEntry[]): SessionEntry[] {
  const customEntries: Array<{ index: number; entry: SessionEntry }> = [];
  const latestByType = new Map<string, { index: number; entry: SessionEntry }>();
  for (const [index, entry] of entries.entries()) {
    if (entry.type === "custom") {
      customEntries.push({ index, entry });
    } else if (
      entry.type === "thinking_level_change" ||
      entry.type === "model_change" ||
      entry.type === "session_info"
    ) {
      latestByType.set(entry.type, { index, entry });
    }
  }
  return [...customEntries, ...latestByType.values()]
    .toSorted((left, right) => left.index - right.index)
    .map(({ entry }) => entry);
}

function buildSuccessorHeader(params: {
  previousHeader: SessionHeader | null;
  sessionId: string;
  timestamp: string;
  cwd: string;
  parentSession: string;
}): SessionHeader {
  return {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId,
    timestamp: params.timestamp,
    cwd: params.previousHeader?.cwd || params.cwd,
    parentSession: params.parentSession,
  };
}

function resolveSuccessorSessionFile(params: {
  sessionFile: string;
  sessionId: string;
  timestamp: string;
}): string {
  const fileTimestamp = params.timestamp.replace(/[:.]/g, "-");
  return path.join(path.dirname(params.sessionFile), `${fileTimestamp}_${params.sessionId}.jsonl`);
}

async function writeSessionFileAtomic(
  filePath: string,
  entries: Array<SessionHeader | SessionEntry>,
) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpFile = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const content = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  try {
    await fs.writeFile(tmpFile, content, { encoding: "utf8", flag: "wx" });
    await fs.rename(tmpFile, filePath);
  } catch (err) {
    await fs.unlink(tmpFile).catch(() => undefined);
    throw err;
  }
}
