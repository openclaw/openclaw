import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type CortexCaptureHistoryEntry = {
  agentId: string;
  sessionId?: string;
  channelId?: string;
  captured: boolean;
  score: number;
  reason: string;
  error?: string;
  syncedCodingContext?: boolean;
  syncPlatforms?: string[];
  timestamp: number;
};

const latestCortexCaptureHistoryByKey = new Map<string, CortexCaptureHistoryEntry>();

function matchesHistoryEntry(
  entry: CortexCaptureHistoryEntry,
  params: {
    agentId: string;
    sessionId?: string;
    channelId?: string;
  },
): boolean {
  return (
    entry.agentId === params.agentId &&
    (params.sessionId ? entry.sessionId === params.sessionId : true) &&
    (params.channelId ? entry.channelId === params.channelId : true)
  );
}

function parseLatestMatchingHistoryEntry(
  raw: string,
  params: {
    agentId: string;
    sessionId?: string;
    channelId?: string;
  },
): CortexCaptureHistoryEntry | null {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as CortexCaptureHistoryEntry;
      if (matchesHistoryEntry(entry, params)) {
        return entry;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function buildHistoryCacheKey(params: {
  agentId: string;
  sessionId?: string;
  channelId?: string;
}): string {
  return [params.agentId, params.sessionId ?? "", params.channelId ?? ""].join("\u0000");
}

function cacheHistoryEntry(entry: CortexCaptureHistoryEntry): void {
  latestCortexCaptureHistoryByKey.set(
    buildHistoryCacheKey({
      agentId: entry.agentId,
      sessionId: entry.sessionId,
      channelId: entry.channelId,
    }),
    entry,
  );
}

function resolveHistoryPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "logs", "cortex-memory-captures.jsonl");
}

export async function appendCortexCaptureHistory(
  entry: CortexCaptureHistoryEntry,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const historyPath = resolveHistoryPath(env);
  await fsp.mkdir(path.dirname(historyPath), { recursive: true });
  await fsp.appendFile(historyPath, `${JSON.stringify(entry)}\n`, "utf8");
  cacheHistoryEntry(entry);
}

export async function readRecentCortexCaptureHistory(params?: {
  limit?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<CortexCaptureHistoryEntry[]> {
  const historyPath = resolveHistoryPath(params?.env);
  let raw: string;
  try {
    raw = await fsp.readFile(historyPath, "utf8");
  } catch {
    return [];
  }
  const parsed = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as CortexCaptureHistoryEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is CortexCaptureHistoryEntry => entry != null);
  const limit = Math.max(1, params?.limit ?? 20);
  return parsed.slice(-limit).toReversed();
}

export function getLatestCortexCaptureHistoryEntrySync(params: {
  agentId: string;
  sessionId?: string;
  channelId?: string;
  env?: NodeJS.ProcessEnv;
}): CortexCaptureHistoryEntry | null {
  const historyPath = resolveHistoryPath(params.env);
  let raw: string;
  try {
    raw = fs.readFileSync(historyPath, "utf8");
  } catch {
    return null;
  }
  return parseLatestMatchingHistoryEntry(raw, params);
}

export function getCachedLatestCortexCaptureHistoryEntry(params: {
  agentId: string;
  sessionId?: string;
  channelId?: string;
}): CortexCaptureHistoryEntry | null {
  return (
    latestCortexCaptureHistoryByKey.get(
      buildHistoryCacheKey({
        agentId: params.agentId,
        sessionId: params.sessionId,
        channelId: params.channelId,
      }),
    ) ?? null
  );
}

export async function getLatestCortexCaptureHistoryEntry(params: {
  agentId: string;
  sessionId?: string;
  channelId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CortexCaptureHistoryEntry | null> {
  const historyPath = resolveHistoryPath(params.env);
  let raw: string;
  try {
    raw = await fsp.readFile(historyPath, "utf8");
  } catch {
    return null;
  }
  const match = parseLatestMatchingHistoryEntry(raw, params);
  if (match) {
    cacheHistoryEntry(match);
  }
  return match;
}
