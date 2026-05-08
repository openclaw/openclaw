import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile } from "../infra/json-file.js";
import { readStringValue } from "../shared/string-coerce.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  deleteOpenClawStateKvJson,
  listOpenClawStateKvJson,
  writeOpenClawStateKvJson,
} from "../state/openclaw-state-kv.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type PersistedSubagentRegistryV1 = {
  version: 1;
  runs: Record<string, LegacySubagentRunRecord>;
};

type PersistedSubagentRegistryV2 = {
  version: 2;
  runs: Record<string, PersistedSubagentRunRecord>;
};

type PersistedSubagentRegistry = PersistedSubagentRegistryV1 | PersistedSubagentRegistryV2;

const MAX_SUBAGENT_REGISTRY_READ_CACHE_ENTRIES = 32;
const SUBAGENT_REGISTRY_KV_SCOPE = "subagent_runs";

type PersistedSubagentRunRecord = SubagentRunRecord;

type RegistryCacheEntry = {
  signature: string;
  runs: Map<string, SubagentRunRecord>;
};

type LegacySubagentRunRecord = PersistedSubagentRunRecord & {
  announceCompletedAt?: unknown;
  announceHandled?: unknown;
  requesterChannel?: unknown;
  requesterAccountId?: unknown;
};

const registryReadCache = new Map<string, RegistryCacheEntry>();

function cloneSubagentRunRecord(entry: SubagentRunRecord): SubagentRunRecord {
  return structuredClone(entry);
}

function cloneSubagentRunMap(runs: Map<string, SubagentRunRecord>): Map<string, SubagentRunRecord> {
  return new Map([...runs].map(([runId, entry]) => [runId, cloneSubagentRunRecord(entry)]));
}

function setCachedRegistryRead(
  pathname: string,
  signature: string,
  runs: Map<string, SubagentRunRecord>,
): void {
  registryReadCache.delete(pathname);
  registryReadCache.set(pathname, { signature, runs: cloneSubagentRunMap(runs) });
  if (registryReadCache.size <= MAX_SUBAGENT_REGISTRY_READ_CACHE_ENTRIES) {
    return;
  }
  const oldestKey = registryReadCache.keys().next().value;
  if (typeof oldestKey === "string") {
    registryReadCache.delete(oldestKey);
  }
}

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

function subagentRegistryDbOptions(): OpenClawStateDatabaseOptions {
  return {
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: resolveSubagentStateDir(process.env),
    },
  };
}

function normalizePersistedRunRecords(params: {
  runsRaw: Record<string, unknown>;
  isLegacy: boolean;
}): Map<string, SubagentRunRecord> {
  const out = new Map<string, SubagentRunRecord>();
  for (const [runId, entry] of Object.entries(params.runsRaw)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const typed = entry as LegacySubagentRunRecord;
    if (!typed.runId || typeof typed.runId !== "string") {
      continue;
    }
    const legacyCompletedAt =
      params.isLegacy && typeof typed.announceCompletedAt === "number"
        ? typed.announceCompletedAt
        : undefined;
    const cleanupCompletedAt =
      typeof typed.cleanupCompletedAt === "number" ? typed.cleanupCompletedAt : legacyCompletedAt;
    const cleanupHandled =
      typeof typed.cleanupHandled === "boolean"
        ? typed.cleanupHandled
        : params.isLegacy
          ? Boolean(typed.announceHandled ?? cleanupCompletedAt)
          : undefined;
    const requesterOrigin = normalizeDeliveryContext(
      typed.requesterOrigin ?? {
        channel: readStringValue(typed.requesterChannel),
        accountId: readStringValue(typed.requesterAccountId),
      },
    );
    const childSessionKey = readStringValue(typed.childSessionKey)?.trim() ?? "";
    const requesterSessionKey = readStringValue(typed.requesterSessionKey)?.trim() ?? "";
    const controllerSessionKey =
      readStringValue(typed.controllerSessionKey)?.trim() || requesterSessionKey;
    if (!childSessionKey || !requesterSessionKey) {
      continue;
    }
    const {
      announceCompletedAt: _announceCompletedAt,
      announceHandled: _announceHandled,
      requesterChannel: _channel,
      requesterAccountId: _accountId,
      ...rest
    } = typed;
    out.set(runId, {
      ...rest,
      childSessionKey,
      requesterSessionKey,
      controllerSessionKey,
      requesterOrigin,
      cleanupCompletedAt,
      cleanupHandled,
      spawnMode: typed.spawnMode === "session" ? "session" : "run",
    });
  }
  return out;
}

function loadSubagentRegistryFromSqlite(): Map<string, SubagentRunRecord> | null {
  const entries = listOpenClawStateKvJson<PersistedSubagentRunRecord>(
    SUBAGENT_REGISTRY_KV_SCOPE,
    subagentRegistryDbOptions(),
  );
  if (entries.length === 0) {
    return null;
  }
  const runsRaw: Record<string, unknown> = {};
  for (const entry of entries) {
    runsRaw[entry.key] = entry.value;
  }
  return normalizePersistedRunRecords({ runsRaw, isLegacy: false });
}

export function loadSubagentRegistryFromDisk(): Map<string, SubagentRunRecord> {
  const sqliteRuns = loadSubagentRegistryFromSqlite();
  if (sqliteRuns) {
    return sqliteRuns;
  }
  const pathname = resolveSubagentRegistryPath();
  const signature = statRegistryFileSignature(pathname);
  if (signature === null) {
    registryReadCache.delete(pathname);
    return new Map();
  }
  const cached = registryReadCache.get(pathname);
  if (cached?.signature === signature) {
    registryReadCache.delete(pathname);
    registryReadCache.set(pathname, cached);
    return cloneSubagentRunMap(cached.runs);
  }
  const raw = loadJsonFile(pathname);
  if (!raw || typeof raw !== "object") {
    setCachedRegistryRead(pathname, signature, new Map());
    return new Map();
  }
  const record = raw as Partial<PersistedSubagentRegistry>;
  if (record.version !== 1 && record.version !== 2) {
    setCachedRegistryRead(pathname, signature, new Map());
    return new Map();
  }
  const runsRaw = record.runs;
  if (!runsRaw || typeof runsRaw !== "object") {
    setCachedRegistryRead(pathname, signature, new Map());
    return new Map();
  }
  const out = normalizePersistedRunRecords({
    runsRaw: runsRaw as Record<string, unknown>,
    isLegacy: record.version === 1,
  });
  try {
    saveSubagentRegistryToDisk(out);
  } catch {
    setCachedRegistryRead(pathname, signature, out);
  }
  return out;
}

export function saveSubagentRegistryToDisk(runs: Map<string, SubagentRunRecord>) {
  const pathname = resolveSubagentRegistryPath();
  const serialized: Record<string, PersistedSubagentRunRecord> = {};
  for (const [runId, entry] of runs.entries()) {
    serialized[runId] = entry;
  }
  const existing = listOpenClawStateKvJson<PersistedSubagentRunRecord>(
    SUBAGENT_REGISTRY_KV_SCOPE,
    subagentRegistryDbOptions(),
  );
  for (const entry of existing) {
    if (!runs.has(entry.key)) {
      deleteOpenClawStateKvJson(SUBAGENT_REGISTRY_KV_SCOPE, entry.key, subagentRegistryDbOptions());
    }
  }
  for (const [runId, entry] of runs.entries()) {
    writeOpenClawStateKvJson(SUBAGENT_REGISTRY_KV_SCOPE, runId, entry, subagentRegistryDbOptions());
  }
  try {
    fs.unlinkSync(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }
  registryReadCache.delete(pathname);
}

function statRegistryFileSignature(pathname: string): string | null {
  try {
    const stat = fs.statSync(pathname, { bigint: true });
    if (!stat.isFile()) {
      return null;
    }
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
