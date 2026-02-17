import path from "node:path";
import type { SubagentRunRecord } from "./subagent-registry.js";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";

export type PersistedSubagentRegistryVersion = 1 | 2 | 3;

type PersistedSubagentRegistryV1 = {
  version: 1;
  runs: Record<string, LegacySubagentRunRecord>;
};

type PersistedSubagentRegistryV2 = {
  version: 2;
  runs: Record<string, PersistedSubagentRunRecord>;
};

type PersistedSubagentRegistryV3 = {
  version: 3;
  runs: Record<string, PersistedSubagentRunRecord>;
};

type PersistedSubagentRegistry =
  | PersistedSubagentRegistryV1
  | PersistedSubagentRegistryV2
  | PersistedSubagentRegistryV3;

const REGISTRY_VERSION = 3 as const;

type PersistedSubagentRunRecord = Omit<SubagentRunRecord, "childKeys"> & {
  childKeys?: string[];
  depth?: number;
};

type LegacySubagentRunRecord = PersistedSubagentRunRecord & {
  announceCompletedAt?: unknown;
  announceHandled?: unknown;
  requesterChannel?: unknown;
  requesterAccountId?: unknown;
};

export function resolveSubagentRegistryPath(): string {
  return path.join(resolveStateDir(), "subagents", "runs.json");
}

export function loadSubagentRegistryFromDisk(): Map<string, SubagentRunRecord> {
  const pathname = resolveSubagentRegistryPath();
  const raw = loadJsonFile(pathname);
  if (!raw || typeof raw !== "object") {
    return new Map();
  }
  const record = raw as Partial<PersistedSubagentRegistry>;
  if (record.version !== 1 && record.version !== 2 && record.version !== 3) {
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
          ? typeof typed.announceHandled === "boolean"
            ? typed.announceHandled
            : typeof cleanupCompletedAt === "number"
              ? true
              : undefined
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
      childKeys: childKeysRaw,
      depth: persistedDepth,
      ...rest
    } = typed as LegacySubagentRunRecord & { childKeys?: unknown; depth?: unknown };
    const depth =
      typeof persistedDepth === "number" && Number.isFinite(persistedDepth)
        ? persistedDepth
        : undefined;
    const childKeys = new Set<string>(
      Array.isArray(childKeysRaw)
        ? childKeysRaw.filter((value): value is string => typeof value === "string")
        : [],
    );
    out.set(runId, {
      ...rest,
      requesterOrigin,
      cleanupCompletedAt,
      cleanupHandled,
      depth,
      childKeys,
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

export function saveSubagentRegistryToDisk(runs: Map<string, SubagentRunRecord>) {
  const pathname = resolveSubagentRegistryPath();
  const serialized: Record<string, PersistedSubagentRunRecord> = {};
  for (const [runId, entry] of runs.entries()) {
    const { childKeys, ...rest } = entry;
    serialized[runId] = {
      ...rest,
      childKeys: childKeys ? Array.from(childKeys) : [],
    };
  }
  const out: PersistedSubagentRegistry = {
    version: REGISTRY_VERSION,
    runs: serialized,
  };
  saveJsonFile(pathname, out);
}
