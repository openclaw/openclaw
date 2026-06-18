import fs from "node:fs/promises";
import path from "node:path";
import type { SessionEntry as StoreSessionEntry } from "../../config/sessions.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "../../config/sessions/transcript-tree.js";
import { resolveSessionFamilyTranscriptReadTargets } from "../../gateway/session-history-family.js";
import type { AgentMessage, CompactionSummaryMessage } from "../runtime/index.js";
import type { SessionEntry as TranscriptSessionEntry } from "../sessions/index.js";

type CarryoverCompactionEntry = {
  type: "compaction";
  summary: string;
  tokensBefore: number;
  timestamp: string;
  firstKeptEntryId?: string;
  details?: unknown;
};

const CARRYOVER_SUMMARY_TAIL_BYTES = 512 * 1024;

function isCompactionEntry(
  entry: TranscriptSessionEntry,
): entry is TranscriptSessionEntry & CarryoverCompactionEntry {
  return (
    entry.type === "compaction" &&
    typeof (entry as { summary?: unknown }).summary === "string" &&
    (entry as { summary: string }).summary.trim() !== "" &&
    typeof (entry as { timestamp?: unknown }).timestamp === "string"
  );
}

function hasCompactionSummary(messages: AgentMessage[]): boolean {
  return messages.some((message) => message.role === "compactionSummary");
}

function compactionTimestampMs(entry: CarryoverCompactionEntry): number {
  const parsed = Date.parse(entry.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function readTranscriptTailEntries(
  sessionFile: string,
  maxBytes = CARRYOVER_SUMMARY_TAIL_BYTES,
): Promise<TranscriptSessionEntry[]> {
  const file = await fs.open(sessionFile, "r");
  try {
    const stat = await file.stat();
    const length = Math.min(stat.size, maxBytes);
    if (length <= 0) {
      return [];
    }
    const start = stat.size - length;
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, start);
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    if (start > 0) {
      lines.shift();
    }
    return lines.flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return [];
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return [];
        }
        if ((parsed as { type?: unknown }).type === "session") {
          return [];
        }
        return [parsed as TranscriptSessionEntry];
      } catch {
        return [];
      }
    });
  } finally {
    await file.close().catch(() => undefined);
  }
}

function selectActiveTailEntries(entries: TranscriptSessionEntry[]): TranscriptSessionEntry[] {
  const tree = scanSessionTranscriptTree(entries);
  if (!tree.leafId) {
    return entries;
  }
  const activeBranch = selectSessionTranscriptTreePathNodes(tree, tree.leafId).map(
    (node) => node.entry,
  );
  return activeBranch.length ? activeBranch : entries;
}

async function readLatestCompactionEntry(
  sessionFile: string | undefined,
): Promise<CarryoverCompactionEntry | undefined> {
  if (!sessionFile) {
    return undefined;
  }
  const entries = await readTranscriptTailEntries(sessionFile).catch(() => []);
  if (!entries.length) {
    return undefined;
  }
  return selectActiveTailEntries(entries).findLast(isCompactionEntry);
}

export async function resolveSessionFamilyCarryoverSummary(params: {
  sessionId: string | undefined;
  sessionFile: string | undefined;
  storePath: string | undefined;
  agentId?: string;
  entry?: StoreSessionEntry;
}): Promise<CompactionSummaryMessage | undefined> {
  if (!params.sessionId || !params.storePath || !params.entry?.usageFamilySessionIds?.length) {
    return undefined;
  }

  const activeSessionFile = params.sessionFile ? path.resolve(params.sessionFile) : undefined;
  const targets = await resolveSessionFamilyTranscriptReadTargets({
    entry: params.entry,
    sessionId: params.sessionId,
    storePath: params.storePath,
    agentId: params.agentId,
    includeFamily: true,
  });

  let latest: CarryoverCompactionEntry | undefined;
  for (const target of targets) {
    if (!target.sessionFile) {
      continue;
    }
    if (activeSessionFile && path.resolve(target.sessionFile) === activeSessionFile) {
      continue;
    }
    const candidate = await readLatestCompactionEntry(target.sessionFile);
    if (!candidate) {
      continue;
    }
    if (!latest || compactionTimestampMs(candidate) >= compactionTimestampMs(latest)) {
      latest = candidate;
    }
  }
  if (!latest) {
    return undefined;
  }

  return {
    role: "compactionSummary",
    summary: latest.summary.trim(),
    tokensBefore:
      typeof latest.tokensBefore === "number" && Number.isFinite(latest.tokensBefore)
        ? latest.tokensBefore
        : 0,
    timestamp: latest.timestamp,
    ...(latest.firstKeptEntryId ? { firstKeptEntryId: latest.firstKeptEntryId } : {}),
    ...(latest.details !== undefined ? { details: latest.details } : {}),
  };
}

export function installSessionFamilyCarryoverContextTransform(params: {
  messages: AgentMessage[];
  setTransformContext: (
    transform: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>,
  ) => void;
  getTransformContext: () =>
    | ((messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>)
    | undefined;
  resolveCarryover: () => Promise<CompactionSummaryMessage | undefined>;
}): void {
  if (hasCompactionSummary(params.messages)) {
    return;
  }
  const previousTransform = params.getTransformContext();
  let carryoverPromise: Promise<CompactionSummaryMessage | undefined> | undefined;
  params.setTransformContext(async (messages, signal) => {
    const transformed = previousTransform ? await previousTransform(messages, signal) : messages;
    if (hasCompactionSummary(transformed)) {
      return transformed;
    }
    if (signal?.aborted) {
      return transformed;
    }
    carryoverPromise ??= params.resolveCarryover();
    const carryover = await carryoverPromise;
    if (!carryover || hasCompactionSummary(transformed)) {
      return transformed;
    }
    return [carryover, ...transformed];
  });
}

export function shouldInstallSessionFamilyCarryoverContextTransform(params: {
  isRawModelRun: boolean;
}): boolean {
  return !params.isRawModelRun;
}
