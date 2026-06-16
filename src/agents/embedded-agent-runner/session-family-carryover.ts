import path from "node:path";
import type { SessionEntry as StoreSessionEntry } from "../../config/sessions.js";
import { resolveSessionFamilyTranscriptReadTargets } from "../../gateway/session-history-family.js";
import type { AgentMessage, CompactionSummaryMessage } from "../runtime/index.js";
import type { SessionEntry as TranscriptSessionEntry } from "../sessions/index.js";
import { readTranscriptFileState } from "./transcript-file-state.js";

type CarryoverCompactionEntry = {
  type: "compaction";
  summary: string;
  tokensBefore: number;
  timestamp: string;
  firstKeptEntryId?: string;
  details?: unknown;
};

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

async function readLatestCompactionEntry(
  sessionFile: string | undefined,
): Promise<CarryoverCompactionEntry | undefined> {
  if (!sessionFile) {
    return undefined;
  }
  const state = await readTranscriptFileState(sessionFile).catch(() => undefined);
  if (!state) {
    return undefined;
  }
  return state.getBranch().findLast(isCompactionEntry);
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
