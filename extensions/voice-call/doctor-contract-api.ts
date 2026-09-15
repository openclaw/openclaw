// Voice Call API module exposes the plugin public contract.
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// Doctor enumeration cold-loads this closure; the state-DB helpers stay behind a
// lazy doctor-repair-runtime import so enumeration never pulls the kysely/state-db graph.
import type { OpenClawStateDatabaseSchemaMigration } from "openclaw/plugin-sdk/doctor-repair-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  archiveLegacyStateSource,
  type PluginDoctorStateMigration,
  type PluginStateKeyedStore,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildChunkKey,
  buildVoiceCallLegacyJsonlEventKey,
  encodeCallRecordEvent,
  hasCompleteCallRecordEvent,
  isInterruptedCallRecordEvent,
  type CallRecordEventChunk,
  type CallRecordEventMeta,
  CALL_RECORD_CHUNK_MAX_ENTRIES,
  CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
  CALL_RECORD_EVENT_META_MAX_ENTRIES,
  CALL_RECORD_EVENTS_NAMESPACE,
  MAX_CALL_RECORD_EVENTS,
  parseVoiceCallRecordLine,
  resolveVoiceCallLegacyCallLogPath,
} from "./src/manager/store.js";
import { resolveDefaultVoiceCallStoreDir } from "./src/store-path.js";

// Doctor state migration for Voice Call legacy JSONL call logs.

/** Prepared legacy JSONL call record ready for plugin state import. */
type PreparedLegacyCallRecord = {
  eventKey: string;
  lineNumber: number;
  chunks: CallRecordEventChunk[];
  meta: CallRecordEventMeta;
};

/** Resolve home from doctor env with OS fallback. */
function resolveHome(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || os.homedir();
}

/** Resolve config paths, including "~", against the doctor env home. */
function resolveUserPath(input: string, env: NodeJS.ProcessEnv): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    return path.resolve(trimmed.replace(/^~(?=$|[\\/])/, () => resolveHome(env)));
  }
  return path.resolve(trimmed);
}

/** Read the configured voice-call store path from either package id. */
function getVoiceCallConfigStore(config: PluginDoctorStateMigrationParams["config"]): string {
  for (const pluginId of ["voice-call", "@openclaw/voice-call"]) {
    const rawConfig = config.plugins?.entries?.[pluginId]?.config;
    if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
      continue;
    }
    const store = (rawConfig as { store?: unknown }).store;
    if (typeof store === "string" && store.trim()) {
      return store.trim();
    }
  }
  return "";
}

type PluginDoctorStateMigrationParams = Parameters<
  PluginDoctorStateMigration["detectLegacyState"]
>[0];

/** Return Voice Call agents whose templated core session stores need migration. */
export function resolveSessionStoreAgentIds(params: { cfg: OpenClawConfig }): string[] {
  const agentIds = new Set<string>();
  for (const pluginId of ["voice-call", "@openclaw/voice-call"]) {
    const entry = params.cfg.plugins?.entries?.[pluginId];
    if (!entry) {
      continue;
    }
    const config = entry.config === undefined ? {} : asOptionalRecord(entry.config);
    if (!config) {
      continue;
    }
    agentIds.add(normalizeAgentId(typeof config.agentId === "string" ? config.agentId : undefined));
    const numbers = asOptionalRecord(config.numbers);
    for (const route of Object.values(numbers ?? {})) {
      const agentId = asOptionalRecord(route)?.agentId;
      if (typeof agentId === "string") {
        agentIds.add(normalizeAgentId(agentId));
      }
    }
  }
  return [...agentIds].toSorted();
}

/** Resolve the voice-call store path used by legacy and plugin-state call records. */
function resolveVoiceCallStorePath(params: {
  config: PluginDoctorStateMigrationParams["config"];
  env: NodeJS.ProcessEnv;
}): string {
  const configuredStore = getVoiceCallConfigStore(params.config);
  if (configuredStore) {
    return resolveUserPath(configuredStore, params.env);
  }
  return resolveDefaultVoiceCallStoreDir(params.env);
}

function resolveVoiceCallStateDatabaseEnv(
  params: PluginDoctorStateMigrationParams,
): NodeJS.ProcessEnv {
  return {
    ...params.env,
    OPENCLAW_STATE_DIR: resolveVoiceCallStorePath(params),
  };
}

function describeVoiceCallSchemaMigration(migration: OpenClawStateDatabaseSchemaMigration): string {
  switch (migration.kind) {
    case "agent-databases-composite-primary-key":
      return "agent database registry primary key -> agent_id,path";
    case "agent-databases-relative-paths-v9":
      return "agent database registry paths -> state-relative paths";
    case "audit-events-v2":
      return "audit event ledger -> versioned message lifecycle schema";
    case "commitments-retirement-v7":
      return "retired commitments storage -> discarded rows, table, and indexes";
    case "state-table-retirement-v10":
      return "retired shared-state tables -> removed tables and indexes";
    case "state-table-retirement-v11":
      return "retired skill curator tables -> removed tables and indexes";
    case "singleton-state-foldin-v12":
      return "singleton state tables -> shared configuration state";
    case "state-consolidation-v13":
      return "cron jobs and subagent runs -> canonical JSON storage";
    case "creator-namespace-v14":
      return "cron creators -> explicit principal namespaces";
    case "conversation-binding-targets-v15":
      return "conversation bindings -> exact target keys without agent/session projections";
    case "skill-workshop-directory-ownership-v16":
      return "Skill Workshop proposals -> per-agent Workshop directory ownership";
    case "prepared-worker-ownership-v17":
      return "prepared workers -> one-use capacity and fixed workspace ownership";
    case "worker-placement-execution-mode-v8":
      return "cloud worker placements -> execution-mode claims";
    case "operator-approvals-system-agent":
      return "operator approvals -> OpenClaw system changes";
    case "session-watch-cursor-provenance-v4":
      return "session watch cursors -> provenance column";
    case "strict-tables-v3":
      return "tables -> SQLite STRICT typing";
  }
  return migration.kind satisfies never;
}

/** Read and prepare legacy JSONL call records, collecting line-level warnings. */
async function readLegacyCallRecords(filePath: string): Promise<{
  entries: PreparedLegacyCallRecord[];
  warnings: string[];
}> {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return { entries: [], warnings: [] };
  }
  const entries: PreparedLegacyCallRecord[] = [];
  const warnings: string[] = [];
  let index = 0;
  for (const line of content.split("\n")) {
    const parsed = parseVoiceCallRecordLine(line, index);
    if (!parsed) {
      if (line.trim()) {
        warnings.push(`Skipped malformed Voice Call call-log line ${index + 1}`);
      }
      index += 1;
      continue;
    }
    try {
      const prepared = encodeCallRecordEvent(parsed.call);
      const chunks = Array.from({ length: prepared.meta.chunkCount }, (_, chunkIndex) =>
        prepared.chunk(chunkIndex),
      );
      entries.push({
        eventKey: buildVoiceCallLegacyJsonlEventKey(line, index),
        lineNumber: index + 1,
        chunks,
        meta: {
          ...prepared.meta,
          persistedAt: parsed.persistedAt,
          sequence: parsed.sequence,
        },
      });
    } catch (err) {
      warnings.push(`Skipped Voice Call call-log line ${index + 1}: ${String(err)}`);
    }
    index += 1;
  }
  return { entries, warnings };
}

/** Select newest missing records within complete-history and physical capacity limits. */
async function selectEntriesForImport(params: {
  entries: PreparedLegacyCallRecord[];
  eventStore: PluginStateKeyedStore<CallRecordEventMeta>;
  chunkStore: PluginStateKeyedStore<CallRecordEventChunk>;
  warnings: string[];
}): Promise<{
  existingEventKeys: Set<string>;
  entries: PreparedLegacyCallRecord[];
  recoverableMetadataWarning?: string;
}> {
  const existingEvents = await params.eventStore.entries();
  const existingEventKeys = new Set(existingEvents.map((entry) => entry.key));
  const completeEventKeys = new Set<string>();
  const stores = { events: params.eventStore, chunks: params.chunkStore };
  for (const entry of existingEvents) {
    if (await hasCompleteCallRecordEvent(stores, entry.key, entry.value)) {
      completeEventKeys.add(entry.key);
    }
  }
  const missingEntries = params.entries.filter((entry) => {
    if (!existingEventKeys.has(entry.eventKey)) {
      return true;
    }
    if (!completeEventKeys.has(entry.eventKey)) {
      // Do not overwrite an unknown owner or archive its only replay source.
      params.warnings.push(
        `Skipped Voice Call call-log migration for line ${entry.lineNumber} because existing metadata is incomplete`,
      );
    }
    return false;
  });
  const existingChunks = await params.chunkStore.entries();
  const existingChunkKeys = new Set(existingChunks.map((entry) => entry.key));
  // Metadata-first runtime writes may be interrupted: physical rows are not
  // proof of completed history. Doctor observes them without running recovery.
  let completedRoom = Math.max(0, MAX_CALL_RECORD_EVENTS - completeEventKeys.size);
  let metadataRoom = Math.max(0, CALL_RECORD_EVENT_META_MAX_ENTRIES - existingEventKeys.size);
  let chunkRoom = Math.max(0, CALL_RECORD_CHUNK_MAX_ENTRIES - existingChunks.length);
  const selected: PreparedLegacyCallRecord[] = [];
  let pruned = 0;
  let capacitySkipped = 0;
  let metadataCapacitySkipped = 0;
  for (const entry of missingEntries.toReversed()) {
    if (completedRoom <= 0) {
      pruned++;
      continue;
    }
    if (metadataRoom <= 0) {
      metadataCapacitySkipped++;
      continue;
    }
    // An interrupted deterministic import already owns its written prefix.
    const missingChunks = entry.chunks.filter(
      (chunk) => !existingChunkKeys.has(buildChunkKey(entry.eventKey, chunk.index)),
    ).length;
    if (missingChunks > chunkRoom) {
      capacitySkipped++;
      continue;
    }
    selected.push(entry);
    completedRoom--;
    metadataRoom--;
    chunkRoom -= missingChunks;
  }
  let recoverableMetadataWarning: string | undefined;
  if (metadataCapacitySkipped > 0) {
    const warning = `Skipped Voice Call call-log migration for ${metadataCapacitySkipped} ${metadataCapacitySkipped === 1 ? "record" : "records"} because metadata capacity is unavailable`;
    params.warnings.push(warning);
    const reclaimable = existingEvents.filter((entry) =>
      isInterruptedCallRecordEvent(entry.key, entry.value, existingChunkKeys),
    ).length;
    if (capacitySkipped === 0 && reclaimable >= Math.min(metadataCapacitySkipped, completedRoom)) {
      // Do not run recovery from Doctor: another process may still own a write.
      // Keep source intact and allow the updated runtime to recover on startup.
      recoverableMetadataWarning = warning;
    }
  }
  if (capacitySkipped > 0) {
    params.warnings.push(
      `Skipped Voice Call call-log migration for ${capacitySkipped} ${capacitySkipped === 1 ? "record" : "records"} because chunk capacity is unavailable`,
    );
  }
  if (pruned > 0) {
    params.warnings.push(
      `Pruned ${pruned} older Voice Call call-log ${pruned === 1 ? "record" : "records"} during migration because plugin state keeps the newest ${MAX_CALL_RECORD_EVENTS} records`,
    );
  }
  return { existingEventKeys, entries: selected.toReversed(), recoverableMetadataWarning };
}

/** Import prepared legacy call records into plugin state. */
async function importLegacyCallRecords(params: {
  entries: PreparedLegacyCallRecord[];
  eventStore: PluginStateKeyedStore<CallRecordEventMeta>;
  chunkStore: PluginStateKeyedStore<CallRecordEventChunk>;
  warnings: string[];
}): Promise<{ imported: number; recoverableMetadataWarning?: string }> {
  const selected = await selectEntriesForImport(params);
  let imported = 0;
  for (const entry of selected.entries) {
    if (selected.existingEventKeys.has(entry.eventKey)) {
      continue;
    }
    try {
      for (const chunk of entry.chunks) {
        await params.chunkStore.register(buildChunkKey(entry.eventKey, chunk.index), chunk);
      }
      await params.eventStore.register(entry.eventKey, entry.meta);
      selected.existingEventKeys.add(entry.eventKey);
      imported++;
    } catch (err) {
      params.warnings.push(
        `Failed migrating Voice Call call-log line ${entry.lineNumber}: ${String(err)}`,
      );
    }
  }
  return { imported, recoverableMetadataWarning: selected.recoverableMetadataWarning };
}

/** Doctor migrations owned by the voice-call plugin. */
export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "voice-call-calls-jsonl-to-plugin-state",
    label: "Voice Call call log",
    async detectLegacyState(params) {
      const storePath = resolveVoiceCallStorePath(params);
      // An absent store has neither legacy logs nor a plugin-local database.
      // Existing stores still need schema detection even without calls.jsonl.
      if (!existsSync(storePath)) {
        return null;
      }
      const { detectOpenClawStateDatabaseSchemaMigrations } =
        await import("openclaw/plugin-sdk/doctor-repair-runtime");
      const filePath = resolveVoiceCallLegacyCallLogPath(storePath);
      const { entries } = await readLegacyCallRecords(filePath);
      const schemaMigrations = detectOpenClawStateDatabaseSchemaMigrations({
        env: resolveVoiceCallStateDatabaseEnv(params),
      });
      if (entries.length === 0 && schemaMigrations.length === 0) {
        return null;
      }
      return {
        preview: [
          ...schemaMigrations.map(
            (migration) =>
              `- Voice Call SQLite schema: ${describeVoiceCallSchemaMigration(migration)}`,
          ),
          ...(entries.length > 0
            ? [
                `- Voice Call call log: ${entries.length} ${entries.length === 1 ? "record" : "records"} -> plugin state (${CALL_RECORD_EVENTS_NAMESPACE})`,
              ]
            : []),
        ],
      };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const storePath = resolveVoiceCallStorePath(params);
      if (!existsSync(storePath)) {
        return { changes, warnings };
      }
      const { detectOpenClawStateDatabaseSchemaMigrations, repairOpenClawStateDatabaseSchema } =
        await import("openclaw/plugin-sdk/doctor-repair-runtime");
      const filePath = resolveVoiceCallLegacyCallLogPath(storePath);
      const { entries, warnings: readWarnings } = await readLegacyCallRecords(filePath);
      warnings.push(...readWarnings);
      const stateDatabaseEnv = resolveVoiceCallStateDatabaseEnv(params);
      const schemaMigrations = detectOpenClawStateDatabaseSchemaMigrations({
        env: stateDatabaseEnv,
      });
      if (schemaMigrations.length > 0) {
        const repaired = repairOpenClawStateDatabaseSchema({ env: stateDatabaseEnv });
        warnings.push(...repaired.warnings);
        if (repaired.warnings.length > 0) {
          return { changes, warnings };
        }
        changes.push(
          ...repaired.changes.map((change) =>
            change
              .replace(/^Migrated shared state /, "Migrated Voice Call SQLite ")
              .replaceAll("→", "->"),
          ),
        );
      }
      if (entries.length === 0) {
        return { changes, warnings };
      }
      const env = stateDatabaseEnv;
      const eventStore = params.context.openPluginStateKeyedStore<CallRecordEventMeta>({
        namespace: CALL_RECORD_EVENTS_NAMESPACE,
        maxEntries: CALL_RECORD_EVENT_META_MAX_ENTRIES,
        overflowPolicy: "reject-new",
        env,
      });
      const chunkStore = params.context.openPluginStateKeyedStore<CallRecordEventChunk>({
        namespace: CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
        maxEntries: CALL_RECORD_CHUNK_MAX_ENTRIES,
        overflowPolicy: "reject-new",
        env,
      });
      const { imported, recoverableMetadataWarning } = await importLegacyCallRecords({
        entries,
        eventStore,
        chunkStore,
        warnings,
      });
      if (imported > 0) {
        changes.push(
          `Migrated ${imported} Voice Call call-log ${imported === 1 ? "record" : "records"} -> plugin state`,
        );
      }
      if (
        warnings.some(
          (warning) =>
            warning.startsWith("Failed migrating Voice Call") ||
            warning.startsWith("Skipped malformed Voice Call call-log line") ||
            warning.startsWith("Skipped Voice Call call-log line") ||
            warning.startsWith("Skipped Voice Call call-log migration"),
        )
      ) {
        const recoverable =
          recoverableMetadataWarning !== undefined &&
          warnings.every((warning) => warning === recoverableMetadataWarning);
        warnings.push("Left Voice Call call-log source in place because migration was incomplete");
        return {
          changes,
          warnings,
          ...(recoverable ? { warningDisposition: "recoverable" as const } : {}),
        };
      }
      await archiveLegacyStateSource({ filePath, label: "Voice Call call-log", changes, warnings });
      return { changes, warnings };
    },
  },
];
