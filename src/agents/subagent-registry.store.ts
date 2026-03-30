import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type PersistedSubagentRegistryVersion = 1 | 2;

type PersistedSubagentRegistryV1 = {
  version: 1;
  runs: Record<string, LegacySubagentRunRecord>;
};

type PersistedSubagentRegistryV2 = {
  version: 2;
  runs: Record<string, PersistedSubagentRunRecord>;
};

type PersistedSubagentRegistry = PersistedSubagentRegistryV1 | PersistedSubagentRegistryV2;

const REGISTRY_VERSION = 2 as const;

type PersistedSubagentRunRecord = SubagentRunRecord;

type LegacySubagentRunRecord = PersistedSubagentRunRecord & {
  announceCompletedAt?: unknown;
  announceHandled?: unknown;
  requesterChannel?: unknown;
  requesterAccountId?: unknown;
};

function resolveSubagentStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) {
    return resolveStateDir(env);
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), "openclaw-test-state", String(process.pid));
  }
  return resolveStateDir(env);
}

export function resolveSubagentRegistryPath(): string {
  return path.join(resolveSubagentStateDir(process.env), "subagents", "runs.json");
}

// Per-process mtime cache: avoids re-parsing runs.json on every RPC call when unchanged.
// Invalidated on write and when the file's mtime changes (detects writes from other processes).
let _diskCache: { mtimeMs: number; data: Map<string, SubagentRunRecord> } | null = null;

function parseSubagentRegistryFromFile(pathname: string): Map<string, SubagentRunRecord> {
  const raw = loadJsonFile(pathname);
  if (!raw || typeof raw !== "object") {
    return new Map();
  }
  const record = raw as Partial<PersistedSubagentRegistry>;
  if (record.version !== 1 && record.version !== 2) {
    return new Map();
  }
  const runsRaw = record.runs;
  if (!runsRaw || typeof runsRaw !== "object") {
    return new Map();
  }
  const out = new Map<string, SubagentRunRecord>();
  const isLegacy = record.version === 1;
  let migrated = false;
  for (const [runId, entry] of Object.entries(runsRaw)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const typed = entry as LegacySubagentRunRecord;
    if (!typed.runId || typeof typed.runId !== "string") {
      continue;
    }
    const legacyCompletedAt =
      isLegacy && typeof typed.announceCompletedAt === "number"
        ? typed.announceCompletedAt
        : undefined;
    const cleanupCompletedAt =
      typeof typed.cleanupCompletedAt === "number" ? typed.cleanupCompletedAt : legacyCompletedAt;
    const cleanupHandled =
      typeof typed.cleanupHandled === "boolean"
        ? typed.cleanupHandled
        : isLegacy
          ? Boolean(typed.announceHandled ?? cleanupCompletedAt)
          : undefined;
    const requesterOrigin = normalizeDeliveryContext(
      typed.requesterOrigin ?? {
        channel: typeof typed.requesterChannel === "string" ? typed.requesterChannel : undefined,
        accountId:
          typeof typed.requesterAccountId === "string" ? typed.requesterAccountId : undefined,
      },
    );
    const {
      announceCompletedAt: _announceCompletedAt,
      announceHandled: _announceHandled,
      requesterChannel: _channel,
      requesterAccountId: _accountId,
      ...rest
    } = typed;
    out.set(runId, {
      ...rest,
      requesterOrigin,
      cleanupCompletedAt,
      cleanupHandled,
      spawnMode: typed.spawnMode === "session" ? "session" : "run",
    });
    if (isLegacy) {
      migrated = true;
    }
  }
  if (migrated) {
    try {
      saveSubagentRegistryToDisk(out);
    } catch {
      // ignore migration write failures
    }
  }
  return out;
}

export function loadSubagentRegistryFromDisk(): Map<string, SubagentRunRecord> {
  const pathname = resolveSubagentRegistryPath();
  let currentMtime: number;
  try {
    currentMtime = fs.statSync(pathname).mtimeMs;
  } catch {
    // File doesn't exist; clear any stale cache entry and return empty.
    _diskCache = null;
    return new Map();
  }
  if (_diskCache && _diskCache.mtimeMs === currentMtime) {
    return _diskCache.data;
  }
  const data = parseSubagentRegistryFromFile(pathname);
  // Re-stat after parse: migration inside parseSubagentRegistryFromFile may have written the file,
  // changing the mtime. Use the post-parse mtime so we don't immediately miss on the next read.
  try {
    _diskCache = { mtimeMs: fs.statSync(pathname).mtimeMs, data };
  } catch {
    _diskCache = null;
  }
  return data;
}

export function saveSubagentRegistryToDisk(runs: Map<string, SubagentRunRecord>) {
  const pathname = resolveSubagentRegistryPath();
  const serialized: Record<string, PersistedSubagentRunRecord> = {};
  for (const [runId, entry] of runs.entries()) {
    serialized[runId] = entry;
  }
  const out: PersistedSubagentRegistry = {
    version: REGISTRY_VERSION,
    runs: serialized,
  };
  saveJsonFile(pathname, out);
  // Invalidate the in-process cache so the next read reflects this write.
  _diskCache = null;
}
