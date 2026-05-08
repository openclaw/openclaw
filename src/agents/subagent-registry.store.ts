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

const SUBAGENT_REGISTRY_KV_SCOPE = "subagent_runs";

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

export function resolveLegacySubagentRegistryPath(): string {
  return path.join(resolveSubagentStateDir(process.env), "subagents", "runs.json");
}

function resolveLegacySubagentRegistryPathForEnv(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSubagentStateDir(env), "subagents", "runs.json");
}

function subagentRegistryDbOptions(
  env: NodeJS.ProcessEnv = process.env,
): OpenClawStateDatabaseOptions {
  return {
    env: {
      ...env,
      OPENCLAW_STATE_DIR: resolveSubagentStateDir(env),
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

export function loadSubagentRegistryFromSqlite(
  env: NodeJS.ProcessEnv = process.env,
): Map<string, SubagentRunRecord> | null {
  const entries = listOpenClawStateKvJson<PersistedSubagentRunRecord>(
    SUBAGENT_REGISTRY_KV_SCOPE,
    subagentRegistryDbOptions(env),
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

export function loadSubagentRegistryFromState(): Map<string, SubagentRunRecord> {
  return loadSubagentRegistryFromSqlite() ?? new Map();
}

function writeSubagentRegistryRunsToSqlite(
  runs: Map<string, SubagentRunRecord>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dbOptions = subagentRegistryDbOptions(env);
  for (const [runId, entry] of runs.entries()) {
    writeOpenClawStateKvJson(SUBAGENT_REGISTRY_KV_SCOPE, runId, entry, dbOptions);
  }
}

function loadLegacySubagentRegistryFile(pathname: string): Map<string, SubagentRunRecord> {
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
  return normalizePersistedRunRecords({
    runsRaw: runsRaw as Record<string, unknown>,
    isLegacy: record.version === 1,
  });
}

export function legacySubagentRegistryFileExists(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return fs.statSync(resolveLegacySubagentRegistryPathForEnv(env)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function importLegacySubagentRegistryFileToSqlite(env: NodeJS.ProcessEnv = process.env): {
  imported: boolean;
  runs: number;
} {
  const pathname = resolveLegacySubagentRegistryPathForEnv(env);
  if (!legacySubagentRegistryFileExists(env)) {
    return { imported: false, runs: 0 };
  }
  const runs = loadLegacySubagentRegistryFile(pathname);
  writeSubagentRegistryRunsToSqlite(runs, env);
  try {
    fs.unlinkSync(pathname);
  } catch {
    // Import succeeded; a later doctor pass can remove the stale file.
  }
  return { imported: true, runs: runs.size };
}

export function saveSubagentRegistryToState(runs: Map<string, SubagentRunRecord>) {
  const dbOptions = subagentRegistryDbOptions();
  const existing = listOpenClawStateKvJson<PersistedSubagentRunRecord>(
    SUBAGENT_REGISTRY_KV_SCOPE,
    dbOptions,
  );
  for (const entry of existing) {
    if (!runs.has(entry.key)) {
      deleteOpenClawStateKvJson(SUBAGENT_REGISTRY_KV_SCOPE, entry.key, dbOptions);
    }
  }
  writeSubagentRegistryRunsToSqlite(runs);
}
