import fs from "node:fs/promises";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterAll, beforeAll, vi } from "vitest";
import { consolidateMemory } from "./dreaming-consolidation.js";
import { readDailyIngestionState, readSessionIngestionState } from "./dreaming-ingestion-state.js";
import type { DreamingCompletion } from "./dreaming-narrative.js";
import {
  configureMemoryCoreDreamingState,
  memoryCoreWorkspaceStateKey,
  openMemoryCoreStateStore,
  SHORT_TERM_LOCK_MAX_ENTRIES,
  SHORT_TERM_LOCK_NAMESPACE,
  SHORT_TERM_META_NAMESPACE,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  writeMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntry,
} from "./dreaming-state.js";
import {
  ensureMemorySessionTombstones,
  recordMemorySessionTombstonesInDatabase,
} from "./memory-session-tombstones.js";
import { applyShortTermPromotions } from "./short-term-promotion-apply.js";
import { readPhaseSignalStore, readShortTermStore } from "./short-term-promotion-store.js";
import type { ShortTermLockEntry } from "./short-term-promotion-types.js";
import { normalizeShortTermRecallStore } from "./short-term-promotion-utils.js";

const MEMORY_CORE_PLUGIN_ID = "memory-core";
const MEMORY_CORE_TEST_AGENT_ID = "memory-core-test";

export function createDreamingCompletion(
  text = "The repository whispered of forgotten endpoints.",
) {
  return { complete: vi.fn<DreamingCompletion["complete"]>().mockResolvedValue({ text }) };
}

export function seedMemoryForgetTombstones(
  params: Parameters<typeof recordMemorySessionTombstonesInDatabase>[1],
): number {
  const { db } = openOpenClawAgentDatabase({ agentId: params.agentId });
  ensureMemorySessionTombstones(db);
  return recordMemorySessionTombstonesInDatabase(db, params);
}

export async function seedMemoryIndexWithOrphanedProvenance(
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  database.db.exec(`
    PRAGMA foreign_keys = OFF;
    INSERT INTO memory_index_chunks (
      id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
    ) VALUES (
      'orphaned-chunk', 'memory/orphan.md', 'memory', 1, 1,
      'hash', 'none', 'orphaned memory', x'', 1
    );
    INSERT INTO memory_index_chunk_provenance (
      chunk_id, origin_class, session_kind, observed_at
    ) VALUES ('orphaned-chunk', 'agent', 'unknown', 1);
    DELETE FROM memory_index_chunks WHERE id = 'orphaned-chunk';
    PRAGMA foreign_keys = ON;
  `);
  closeOpenClawAgentDatabasesForTest();
  // Replaced files cannot reuse the original connection's clean integrity receipt.
  const replacementPath = `${database.path}.replacement`;
  await fs.copyFile(database.path, replacementPath);
  await fs.rename(replacementPath, database.path);
  return database.path;
}

export function consolidateMemoryForTests(
  params: Omit<Parameters<typeof consolidateMemory>[0], "agentId">,
) {
  return consolidateMemory({ ...params, agentId: MEMORY_CORE_TEST_AGENT_ID });
}

export function applyShortTermPromotionsForTests(
  params: Omit<Parameters<typeof applyShortTermPromotions>[0], "agentId">,
) {
  return applyShortTermPromotions({ ...params, agentId: MEMORY_CORE_TEST_AGENT_ID });
}

export async function configureMemoryCoreDreamingStateForTests(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const testEnv = { ...env };
  configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>(MEMORY_CORE_PLUGIN_ID, { ...options, env: testEnv }),
  );
}

export function resetMemoryCoreDreamingStateForTests(): void {
  configureMemoryCoreDreamingState((_options: OpenKeyedStoreOptions) => {
    throw new Error("memory-core dreaming SQLite state store is not configured");
  });
}

async function writeRawShortTermStore(params: {
  workspaceDir: string;
  raw: unknown;
  namespace: string;
  metaKey: "recall" | "phase";
}): Promise<void> {
  const record = asOptionalRecord(params.raw);
  const entries = asOptionalRecord(record?.entries);
  await Promise.all([
    writeMemoryCoreWorkspaceEntries({
      namespace: params.namespace,
      workspaceDir: params.workspaceDir,
      entries: entries ? Object.entries(entries).map(([key, value]) => ({ key, value })) : [],
    }),
    writeMemoryCoreWorkspaceEntry({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir: params.workspaceDir,
      key: params.metaKey,
      value: {
        updatedAt:
          typeof record?.updatedAt === "string" && record.updatedAt.trim()
            ? record.updatedAt
            : new Date().toISOString(),
      },
    }),
  ]);
}

export const shortTermTestState = {
  SHORT_TERM_RECALL_MAX_ENTRIES: 512,
  SHORT_TERM_RECALL_MAX_SNIPPET_CHARS: 800,
  async readRecallStore(workspaceDir: string, nowIso: string) {
    return normalizeShortTermRecallStore(
      await readShortTermStore(workspaceDir, "recall", nowIso),
      nowIso,
    );
  },
  readPhaseSignalStore,
  writeRawRecallStore: (workspaceDir: string, raw: unknown) =>
    writeRawShortTermStore({
      workspaceDir,
      raw,
      namespace: SHORT_TERM_RECALL_NAMESPACE,
      metaKey: "recall",
    }),
  writeRawPhaseSignalStore: (workspaceDir: string, raw: unknown) =>
    writeRawShortTermStore({
      workspaceDir,
      raw,
      namespace: SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
      metaKey: "phase",
    }),
  async writeShortTermLock(workspaceDir: string, entry: ShortTermLockEntry) {
    await openMemoryCoreStateStore<ShortTermLockEntry>({
      namespace: SHORT_TERM_LOCK_NAMESPACE,
      maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
    }).register(memoryCoreWorkspaceStateKey(workspaceDir), entry);
  },
  async deleteShortTermLock(workspaceDir: string) {
    await openMemoryCoreStateStore<ShortTermLockEntry>({
      namespace: SHORT_TERM_LOCK_NAMESPACE,
      maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
    }).delete(memoryCoreWorkspaceStateKey(workspaceDir));
  },
};

export const dreamingTestState = {
  readDailyIngestionState,
  readSessionIngestionState,
};

export function createMemoryCoreTestHarness() {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    await configureMemoryCoreDreamingStateForTests();
    fixtureRoot = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "memory-core-test-fixtures-"),
    );
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    // The agent close releases its leases through shared state and reopens it, so the
    // shared handle is released second; otherwise Windows fails the removal with EBUSY.
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    resetMemoryCoreDreamingStateForTests();
  });

  async function createTempWorkspace(prefix: string): Promise<string> {
    const workspaceDir = path.join(fixtureRoot, `${prefix}${caseId++}`);
    await fs.mkdir(workspaceDir, { recursive: true });
    return workspaceDir;
  }

  return {
    createTempWorkspace,
  };
}
