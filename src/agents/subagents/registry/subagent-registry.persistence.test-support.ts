/**
 * Test helpers for subagent registry persistence scenarios. They seed minimal
 * SQLite-backed session entries and runtime dependency mocks without loading
 * the production embedded-agent stack.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Selectable } from "kysely";
import { expect, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionEntry } from "../../../config/sessions.js";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntriesCore,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { createRunningTaskRun } from "../../../tasks/detached-task-runtime.js";
import { createSubagentTaskBackingDetail } from "../../../tasks/task-backing-authority.js";
import type { TaskFlowRecord } from "../../../tasks/task-flow-registry.types.js";
import { getTaskFlowById } from "../../../tasks/task-flow-runtime-internal.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import type { SubagentRegistryDeps } from "./subagent-registry-deps.js";
import { upsertSubagentRunRowInDatabase } from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type SessionStore = Record<string, Record<string, unknown>>;
const SYNTHETIC_PREVIOUS_BUILD = "synthetic-previous-build";
type PersistedReleasedSubagentRow = Pick<
  Selectable<OpenClawStateKyselyDatabase["subagent_runs"]>,
  | "run_id"
  | "child_session_key"
  | "controller_session_key"
  | "requester_session_key"
  | "created_at"
  | "payload_json"
>;

export function expectSubagentFixtureFields(
  value: unknown,
  expected: Record<string, unknown>,
): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

export function createPersistedEndedSubagentRunFixture(params: {
  runId: string;
  childSessionKey: string;
  task: string;
  cleanup: "keep" | "delete";
}) {
  const now = Date.now();
  return {
    version: 2,
    runs: {
      [params.runId]: {
        runId: params.runId,
        childSessionKey: params.childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        taskOwnershipPolicy: "gateway_best_effort" as const,
        task: params.task,
        cleanup: params.cleanup,
        createdAt: now - 2,
        startedAt: now - 1,
        endedAt: now,
      },
    },
  };
}

export function expectDeferredSubagentAnnouncement(
  entry: SubagentRunRecord | undefined,
  runId: string,
) {
  expect(entry, "deferred announcement committed").toMatchObject({
    cleanupHandled: false,
    delivery: { status: "pending", attemptCount: 1, payload: { childRunId: runId } },
  });
  expect(entry?.cleanupCompletedAt, "deferred cleanup remains unfinished").toBeUndefined();
  expect(Number.isFinite(entry?.delivery?.nextAttemptAt), "durable retry deadline").toBe(true);
}

/** Hold the real lazy settlement dependency without replacing its completion policy. */
export function gateSubagentRequesterSettlement(
  settle: SubagentRegistryDeps["maybeWakeRequesterAfterAllChildrenSettled"],
) {
  const released = createDeferred();
  let pending: Promise<boolean> | undefined;
  const run = vi.fn<SubagentRegistryDeps["maybeWakeRequesterAfterAllChildrenSettled"]>((params) => {
    pending = (async () => {
      await released.promise;
      return await settle(params);
    })();
    return pending;
  });
  return {
    run,
    async release() {
      released.resolve();
      await pending;
    },
  };
}

/** Gates owned by a test must be released before waiting for imports and detached tails. */
export async function settleSubagentRegistryPersistenceWork() {
  await vi.dynamicImportSettled();
  await vi.waitFor(() =>
    expect(getActiveGatewayRootWorkCount(), "residual registry roots").toBe(0),
  );
}

type PersistenceCleanup = {
  stateDir: string;
  resetRegistry: () => void;
  resetDeps: () => void;
  closeDatabases?: () => void | Promise<void>;
};

export async function cleanupSubagentRegistryPersistenceTest(params: PersistenceCleanup) {
  await settleSubagentRegistryPersistenceWork();
  params.resetRegistry();
  await cleanupSessionStateForTest({ stateDir: params.stateDir });
  await params.closeDatabases?.();
  params.resetDeps();
  await fs.rm(params.stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/** Finish fixture-owned writes before withEnvAsync restores their database location. */
export async function withSubagentRegistryPersistenceState<T>(
  params: PersistenceCleanup,
  run: () => Promise<T>,
): Promise<T> {
  return await withEnvAsync({ OPENCLAW_STATE_DIR: params.stateDir }, async () => {
    try {
      return await run();
    } finally {
      await cleanupSubagentRegistryPersistenceTest(params);
    }
  });
}

export type SubagentRunFixture = Omit<SubagentRunRecord, "execution"> & {
  execution?: SubagentRunRecord["execution"];
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunRecord["execution"]["outcome"];
};

function resolveSubagentSessionStorePath(stateDir: string, agentId: string): string {
  return path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
}

/** Expands shorthand test records into the canonical nested persistence shape. */
export function createCanonicalSubagentRunFixture(run: SubagentRunFixture): SubagentRunRecord {
  const { startedAt, endedAt, outcome, ...record } = run;
  const terminal = typeof endedAt === "number";
  return {
    ...record,
    execution:
      run.execution ??
      (terminal
        ? { status: "terminal", startedAt, endedAt, outcome }
        : { status: "running", startedAt }),
    completion: run.completion ?? { required: run.expectsCompletionMessage === true },
    delivery: run.delivery ?? {
      status:
        run.expectsCompletionMessage === false
          ? "not_required"
          : terminal
            ? "pending"
            : "not_required",
    },
  };
}

export function canonicalSubagentRunFixtures(
  runs: ReadonlyMap<string, SubagentRunFixture>,
): Map<string, SubagentRunRecord> {
  return new Map([...runs].map(([runId, run]) => [runId, createCanonicalSubagentRunFixture(run)]));
}

export function createReleasedCoreSubagentCandidateFixture(run: SubagentRunFixture): {
  run: SubagentRunRecord;
  task: TaskRecord;
  flow: TaskFlowRecord;
} {
  if (run.taskOwnershipPolicy !== undefined) {
    throw new Error("released ownership candidate fixtures must omit task ownership policy");
  }
  const generation = run.generation ?? 1;
  const taskRunId = run.taskRunId ?? run.runId;
  const candidate = createCanonicalSubagentRunFixture({
    ...run,
    taskRunId,
    generation,
  });
  const task = createRunningTaskRun({
    runtime: "subagent",
    sourceId: taskRunId,
    ownerKey: candidate.requesterSessionKey,
    requesterSessionKey: candidate.requesterSessionKey,
    scopeKind: "session",
    childSessionKey: candidate.childSessionKey,
    runId: taskRunId,
    task: candidate.task,
    deliveryStatus: candidate.expectsCompletionMessage === false ? "not_applicable" : "pending",
    detail: createSubagentTaskBackingDetail(generation),
    startedAt: candidate.execution.startedAt ?? candidate.createdAt,
    lastEventAt: candidate.execution.startedAt ?? candidate.createdAt,
  });
  if (!task?.parentFlowId) {
    throw new Error(`failed to create released task backing for ${run.runId}`);
  }
  const flow = getTaskFlowById(task.parentFlowId);
  if (!flow || flow.syncMode !== "task_mirrored") {
    throw new Error(`failed to create released mirrored task flow for ${run.runId}`);
  }
  return { run: candidate, task, flow };
}

/** Writes the exact released row shape without current-runtime normalization. */
export function writeReleasedCoreSubagentCandidateFixture(run: SubagentRunFixture): {
  run: SubagentRunRecord;
  task: TaskRecord;
  flow: TaskFlowRecord;
  row: PersistedReleasedSubagentRow;
} {
  const fixture = createReleasedCoreSubagentCandidateFixture(run);
  let persisted: PersistedReleasedSubagentRow | undefined;
  runOpenClawStateWriteTransaction((database) => {
    const stateDb = getNodeSqliteKysely<
      Pick<OpenClawStateKyselyDatabase, "schema_meta" | "subagent_runs">
    >(database.db);
    upsertSubagentRunRowInDatabase(database, {
      run_id: fixture.run.runId,
      child_session_key: fixture.run.childSessionKey,
      controller_session_key: fixture.run.controllerSessionKey?.trim() || null,
      requester_session_key: fixture.run.requesterSessionKey,
      created_at: fixture.run.createdAt,
      payload_json: JSON.stringify(fixture.run),
    });
    const schemaBefore = executeSqliteQuerySync(
      database.db,
      stateDb.selectFrom("schema_meta").select("schema_version").where("meta_key", "=", "primary"),
    ).rows[0];
    expect(schemaBefore).toBeDefined();
    const updated = executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("schema_meta")
        .set({ app_version: SYNTHETIC_PREVIOUS_BUILD })
        .where("meta_key", "=", "primary"),
    );
    expect(updated.numAffectedRows).toBe(1n);
    expect(
      executeSqliteQuerySync(
        database.db,
        stateDb
          .selectFrom("schema_meta")
          .select(["app_version", "schema_version"])
          .where("meta_key", "=", "primary"),
      ).rows[0],
    ).toEqual({
      app_version: SYNTHETIC_PREVIOUS_BUILD,
      schema_version: schemaBefore?.schema_version,
    });
    persisted = executeSqliteQuerySync(
      database.db,
      stateDb
        .selectFrom("subagent_runs")
        .select([
          "run_id",
          "child_session_key",
          "controller_session_key",
          "requester_session_key",
          "created_at",
          "payload_json",
        ])
        .where("run_id", "=", fixture.run.runId),
    ).rows[0];
  });
  if (!persisted) {
    throw new Error(`failed to persist released subagent row ${fixture.run.runId}`);
  }
  return { ...fixture, row: persisted };
}

export function expectReleasedCoreSubagentCandidatePersisted(
  fixture: ReturnType<typeof writeReleasedCoreSubagentCandidateFixture>,
): void {
  const payload = JSON.parse(fixture.row.payload_json) as Record<string, unknown>;
  expect(Object.hasOwn(payload, "taskOwnershipPolicy")).toBe(false);
  expect(Object.hasOwn(payload, "legacyTaskOwnershipCandidate")).toBe(false);
  expect(fixture.row).toMatchObject({
    run_id: payload.runId,
    child_session_key: payload.childSessionKey,
    controller_session_key: payload.controllerSessionKey ?? null,
    requester_session_key: payload.requesterSessionKey,
    created_at: payload.createdAt,
  });
  expect(payload).toMatchObject({
    taskRunId: fixture.task.sourceId,
    generation: fixture.run.generation,
    requesterSessionKey: fixture.task.requesterSessionKey,
    childSessionKey: fixture.task.childSessionKey,
  });
  expect(fixture.task).toMatchObject({
    sourceId: fixture.run.taskRunId,
    ownerKey: fixture.run.requesterSessionKey,
    requesterSessionKey: fixture.run.requesterSessionKey,
    childSessionKey: fixture.run.childSessionKey,
    detail: createSubagentTaskBackingDetail(fixture.run.generation!),
  });
  expect(fixture.flow).toMatchObject({
    flowId: fixture.task.parentFlowId,
    syncMode: "task_mirrored",
    ownerKey: fixture.run.requesterSessionKey,
  });
}

/** Reads test session entries through the active SQLite accessor. */
export async function readSubagentSessionStore(storePath: string): Promise<SessionStore> {
  return Object.fromEntries(
    listSessionEntriesCore({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  ) as unknown as SessionStore;
}

/** Writes or updates one SQLite-backed subagent session entry for persistence tests. */
export async function writeSubagentSessionEntry(params: {
  stateDir: string;
  sessionKey: string;
  sessionId?: string;
  updatedAt?: number;
  abortedLastRun?: boolean;
  lifecycleRevision?: string;
  agentId: string;
  defaultSessionId: string;
}): Promise<string> {
  const storePath = resolveSubagentSessionStorePath(params.stateDir, params.agentId);
  const current = loadSessionEntry({ storePath, sessionKey: params.sessionKey });
  const entry: SessionEntry = {
    ...current,
    sessionId: params.sessionId ?? params.defaultSessionId,
    updatedAt: params.updatedAt ?? Date.now(),
    ...(typeof params.abortedLastRun === "boolean"
      ? { abortedLastRun: params.abortedLastRun }
      : {}),
    ...(params.lifecycleRevision ? { lifecycleRevision: params.lifecycleRevision } : {}),
  };
  await replaceSessionEntry({ storePath, sessionKey: params.sessionKey }, entry);
  return storePath;
}

/** Removes one SQLite-backed subagent session entry for persistence tests. */
export async function removeSubagentSessionEntry(params: {
  stateDir: string;
  sessionKey: string;
  agentId: string;
}): Promise<string> {
  const storePath = resolveSubagentSessionStorePath(params.stateDir, params.agentId);
  await applySessionEntryLifecycleMutation({
    storePath,
    removals: [{ sessionKey: params.sessionKey }],
    skipMaintenance: true,
  });
  return storePath;
}

/** Builds default dependency mocks used by subagent registry persistence tests. */
export function createSubagentRegistryTestDeps(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
    captureSubagentCompletionReply: vi.fn(async () => undefined),
    ensureContextEnginesInitialized: vi.fn(),
    loadAgentRuntimePluginRegistryHandle: vi.fn(),
    getRuntimeConfig: vi.fn(() => ({})),
    resolveAgentTimeoutMs: vi.fn(() => 100),
    resolveContextEngine: vi.fn(async () => ({
      info: { id: "test", name: "Test", version: "0.0.1" },
      ingest: vi.fn(async () => ({ ingested: false })),
      assemble: vi.fn(async ({ messages }) => ({ messages, estimatedTokens: 0 })),
      compact: vi.fn(async () => ({ ok: false, compacted: false })),
    })),
    ...extra,
  };
}

export function createDeliveredWake(
  runId: string,
  requesterSettleWake?: NonNullable<SubagentRunRecord["requesterSettleWake"]>,
  overrides: Partial<SubagentRunRecordOverrides> = {},
): SubagentRunRecord {
  const endedAt = overrides.endedAt ?? Date.now();
  return createSubagentRunRecord({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    endedAt,
    outcome: { status: "ok" },
    expectsCompletionMessage: true,
    completion: { required: true, resultText: "done", capturedAt: endedAt },
    delivery: { status: "delivered", deliveredAt: endedAt },
    cleanupHandled: true,
    cleanupCompletedAt: endedAt,
    requesterSettleWake,
    ...overrides,
  });
}

export function createGatewayBestEffortDeliveredWake(
  runId: string,
  requesterSettleWake?: NonNullable<SubagentRunRecord["requesterSettleWake"]>,
  overrides: Partial<SubagentRunRecordOverrides> = {},
): SubagentRunRecord {
  return createDeliveredWake(runId, requesterSettleWake, {
    ...overrides,
    taskOwnershipPolicy: "gateway_best_effort",
  });
}

export function createGatewayBestEffortSubagentRun(
  overrides: SubagentRunRecordOverrides,
): SubagentRunRecord {
  return createSubagentRunRecord({
    ...overrides,
    taskOwnershipPolicy: "gateway_best_effort",
  });
}

export function writeChildSession(
  stateDir: string,
  sessionKey: string,
  defaultSessionId: string,
  lifecycleRevision?: string,
) {
  return writeSubagentSessionEntry({
    stateDir,
    agentId: "main",
    sessionKey,
    defaultSessionId,
    lifecycleRevision,
  });
}

export function createOrphanedRequiredDelivery(
  status: "pending" | "suspended" | "in_progress",
  overrides: Partial<SubagentRunRecordOverrides> = {},
): SubagentRunRecord {
  const now = Date.now();
  const runId = `run-orphan-${status}-delivery`;
  const childSessionKey = `agent:main:subagent:orphan-${status}-delivery`;
  const terminalReply = { disposition: "visible" as const, text: "durable final reply" };
  return createSubagentRunRecord({
    runId,
    childSessionKey,
    task: "deliver after restart",
    cleanup: "delete",
    createdAt: now - 100,
    expectsCompletionMessage: true,
    cleanupHandled: false,
    startedAt: now - 50,
    endedAt: now,
    outcome: { status: "ok" },
    completion: {
      required: true,
      resultText: "canonical final reply",
      capturedAt: now,
      terminalReply,
    },
    delivery: {
      status,
      ...(status === "suspended" ? { suspendedAt: now, suspendedReason: "expiry" as const } : {}),
      ...(status === "in_progress"
        ? { disposition: "session_queued" as const, queueId: "queue-1" }
        : {}),
      payload: {
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        childSessionKey,
        childRunId: runId,
        task: "deliver after restart",
        startedAt: now - 50,
        endedAt: now,
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
        terminalReply,
      },
    },
    ...overrides,
  });
}

export function createGatewayBestEffortOrphanedRequiredDelivery(
  status: "pending" | "suspended" | "in_progress",
): SubagentRunRecord {
  return createOrphanedRequiredDelivery(status, {
    taskOwnershipPolicy: "gateway_best_effort",
  });
}
