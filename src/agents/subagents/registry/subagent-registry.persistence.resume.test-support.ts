import { expect, vi } from "vitest";
import { isPathInside } from "../../../infra/path-guards.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import type { SubagentRegistryDeps } from "./subagent-registry-deps.js";
import {
  createDeliveredWake,
  createSubagentRegistryTestDeps,
  withSubagentRegistryPersistenceState,
} from "./subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type RegistryModule = typeof import("./subagent-registry.test-helpers.js");
type GatewayCall = typeof import("../../../gateway/call.js").callGateway;

export const FORCED_RESTART_WAKE_CASES = [
  { order: "replacement-first", runCount: 1 },
  { order: "old-finally-first", runCount: 1 },
  { order: "before-activation", runCount: 1 },
  { order: "replacement-first", runCount: 3 },
] as const;

function listFixtureAgentDatabases(listDatabases: () => Array<{ path: string }>, stateDir: string) {
  return listDatabases().filter((database) => isPathInside(stateDir, database.path));
}

export function expectFixtureAgentDatabaseCount(
  listDatabases: () => Array<{ path: string }>,
  stateDir: string,
  message: string,
  count: number,
) {
  expect(listFixtureAgentDatabases(listDatabases, stateDir), message).toHaveLength(count);
}

async function closePersistenceResumeFixtureDatabases(params: {
  stateDir: string;
  cleanupSessionState: (params: { stateDir: string }) => Promise<void>;
  databaseLists: ReadonlyArray<{ label: string; list: () => Array<{ path: string }> }>;
  closeStateDatabases: () => void;
}) {
  await params.cleanupSessionState({ stateDir: params.stateDir });
  for (const databaseList of params.databaseLists) {
    expect(
      listFixtureAgentDatabases(databaseList.list, params.stateDir),
      `${databaseList.label} agent handles closed before fixture removal`,
    ).toEqual([]);
  }
  params.closeStateDatabases();
}

export function withPersistenceResumeRegistryState<T>(params: {
  stateDir: string;
  run: () => Promise<T>;
  mod: RegistryModule;
  cleanupSessionState: (params: { stateDir: string }) => Promise<void>;
  databaseLists: ReadonlyArray<{ label: string; list: () => Array<{ path: string }> }>;
  closeStateDatabases: () => void;
}): Promise<T> {
  return withSubagentRegistryPersistenceState(
    {
      stateDir: params.stateDir,
      resetRegistry: () => params.mod.resetSubagentRegistryForTests({ persist: false }),
      resetDeps: () => params.mod.testing.setDepsForTest(),
      closeDatabases: () =>
        closePersistenceResumeFixtureDatabases({
          stateDir: params.stateDir,
          cleanupSessionState: params.cleanupSessionState,
          databaseLists: params.databaseLists,
          closeStateDatabases: params.closeStateDatabases,
        }),
    },
    params.run,
  );
}

export function setPersistenceResumeRegistryDeps(params: {
  mod: RegistryModule;
  callGateway: GatewayCall;
  extra?: Partial<SubagentRegistryDeps>;
}) {
  params.mod.testing.setDepsForTest(
    createSubagentRegistryTestDeps({
      callGateway: vi.mocked(params.callGateway),
      ...params.extra,
    }),
  );
}

export function readPersistedRun(runId: string) {
  return loadSubagentRegistryFromSqlite().get(runId);
}

export function activatePersistenceResumeRegistry(mod: RegistryModule, callGateway: GatewayCall) {
  const recoveryRuntime = {
    dispatchAgent: (params: Record<string, unknown>, timeoutMs?: number) =>
      callGateway({ method: "agent", params, timeoutMs }),
    waitForAgent: (params: Record<string, unknown>, timeoutMs?: number) =>
      callGateway({ method: "agent.wait", params, timeoutMs }),
    sendRecoveryNotice: vi.fn(),
  };
  mod.activateSubagentRegistry(
    () => ({ resolveGatewayContext: () => ({ recoveryRuntime }) }) as never,
  );
}

export function createHydratedRegistryRuns(endedAt: number) {
  const yieldedRun = createDeliveredWake("run-hydrated-yield", undefined, {
    taskRunId: "run-hydrated-yield",
    requesterTurnRunId: "run-requester",
    requesterTurnYielded: true,
    childSessionKey: "agent:main:subagent:hydrated-yield",
    task: "wake only after lifecycle activation",
    createdAt: endedAt - 1_000,
    endedReason: "subagent-complete",
    startedAt: endedAt - 500,
    endedAt,
    cleanupCompletedAt: endedAt,
  });
  const queuedCollector = createSubagentRunRecord({
    runId: "run-hydrated-collector",
    childSessionKey: "agent:main:subagent:hydrated-collector",
    task: "clean only after lifecycle activation",
    createdAt: endedAt - 500,
    collect: true,
    swarmRequesterSessionKey: "agent:main:main",
    groupId: "hydrated-group",
    archiveAtMs: endedAt - 1,
    startedAt: endedAt - 400,
    endedAt,
    outcome: { status: "error", error: "launch failed" },
    completion: { required: true },
    delivery: { status: "pending" },
    collectorCompletion: { status: "failed" },
    collectorLaunchCleanupPending: true,
  });
  const runningRun = createSubagentRunRecord({
    runId: "run-hydrated-running",
    childSessionKey: "agent:main:subagent:hydrated-running",
    task: "wait through the activated instance",
    createdAt: endedAt,
    execution: { status: "running", startedAt: endedAt },
    completion: { required: false },
    delivery: { status: "not_required" },
  });
  return { queuedCollector, runningRun, yieldedRun };
}

export function createRejectedRequesterWake(params: {
  restarting: boolean;
  waitingForActivation: boolean;
  endedAt: number;
}) {
  return createDeliveredWake("run-rejected-requester-wake", {
    status: params.restarting && !params.waitingForActivation ? "dispatching" : "pending",
    attemptCount: params.waitingForActivation ? 2 : params.restarting ? 1 : 0,
    ...(params.restarting ? { replayCount: 1, nextAttemptAt: params.endedAt + 30_000 } : {}),
    batchRunIds: ["run-rejected-requester-wake"],
    requesterYieldBatch: true,
    afterRequesterYield: true,
    rearmGeneration: 1,
  });
}

export function createOutstandingWakeRuns(runCount: number) {
  return Array.from({ length: runCount }, (_, index) => {
    const runId = `run-outstanding-wake-${index}`;
    return {
      ...createDeliveredWake(runId, {
        status: "pending",
        attemptCount: 2,
        batchRunIds: [runId],
        requesterYieldBatch: true,
        afterRequesterYield: true,
        rearmGeneration: 1,
      }),
      requesterSessionKey: `agent:main:requester-${index}`,
    };
  });
}

export function createRestoredWakeRuns(params: {
  endedAt: number;
  activationSettlement: boolean;
  requesterYielded?: boolean;
}): SubagentRunRecord[] {
  return Array.from({ length: 3 }, (_, index): SubagentRunRecord => {
    const runId = `run-restored-wake-${index}`;
    return createDeliveredWake(
      runId,
      params.activationSettlement ? undefined : { status: "pending", attemptCount: 0 },
      {
        childSessionKey: `agent:main:subagent:restored-wake-${index}`,
        requesterSessionKey: `agent:main:requester-${index}`,
        requesterDisplayKey: `requester-${index}`,
        task: "resume a durable requester wake",
        createdAt: params.endedAt - 1_000,
        endedReason: "subagent-complete",
        startedAt: params.endedAt - 500,
        endedAt: params.endedAt,
        ...(params.activationSettlement
          ? {
              requesterTurnRunId: `requester-turn-${index}`,
              ...(params.requesterYielded ? { requesterTurnYielded: true as const } : {}),
              taskRunId: runId,
            }
          : {}),
      },
    );
  });
}

export function createSteeredRestoreRuns(endedAt: number, requesterYielded: boolean) {
  const run = createDeliveredWake("run-steered", undefined, {
    taskRunId: "run-original",
    requesterTurnRunId: "run-requester",
    ...(requesterYielded ? { requesterTurnYielded: true } : {}),
    childSessionKey: "agent:main:subagent:steered",
    task: "deliver the steered result",
    createdAt: endedAt - 1_000,
    endedReason: "subagent-complete",
    startedAt: endedAt - 500,
    endedAt,
    cleanupCompletedAt: endedAt,
  });
  const nonannouncing: SubagentRunRecord[] = [];
  for (const collect of [false, true]) {
    nonannouncing.push({
      ...run,
      runId: `run-nonannouncing-${collect}`,
      taskRunId: `run-nonannouncing-${collect}`,
      childSessionKey: `agent:main:subagent:nonannouncing-${collect}`,
      expectsCompletionMessage: false,
      requesterTurnYielded: undefined,
      collect,
      completion: { required: false, resultText: "quiet result", capturedAt: endedAt },
      delivery: { status: "not_required" },
      ...(collect ? { collectorCompletion: { status: "done" } } : {}),
    });
  }
  return { nonannouncing, run };
}
