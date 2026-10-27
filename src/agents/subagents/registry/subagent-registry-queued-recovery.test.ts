import { setImmediate } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { applySessionEntryExactReplacements } from "../../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { GatewayInputRecovery } from "../../../gateway/agent-input-recovery.js";
import { callGateway } from "../../../gateway/call.js";
import type { GatewayInstanceAgentDispatchOptions } from "../../../gateway/server-instance-runtime.types.js";
import { sessionSharingTestContext } from "../../../gateway/server-methods/sessions-sharing.test-support.js";
import { createMockGatewayRecoveryRuntime } from "../../../gateway/server-recovery-runtime.test-support.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { withAgentDatabasePreparationContext } from "../../../state/agent-database-preparation-context.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { isSubagentRegistryWriteCommand } from "../../subagent-test-fixtures.test-helpers.js";
import {
  closeSwarmScheduler,
  isSwarmRunActive,
  releaseSwarmRun,
} from "../swarm/swarm-scheduler.js";
import { subagentRegistryLog } from "./subagent-registry-lifecycle-log.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  SubagentRegistryMutationRejectedError,
} from "./subagent-registry-persistence.js";
import { createRegistrationFixture } from "./subagent-registry-queued-recovery.test-support.js";
import type { createSubagentRegistryRestorer } from "./subagent-registry-restore.js";
import { createTestSubagentRegistryRestorer as createRestorer } from "./subagent-registry-restore.test-support.js";
import { retireSupersededSubagentRun } from "./subagent-registry-sweeper-retire.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import { readAllSubagentRunsInWorker } from "./subagent-registry.store.read.js";
import type { SubagentRegistrationScope, SubagentRunRecord } from "./subagent-registry.types.js";
import { loadSubagentSessionEntry } from "./subagent-session-reconciliation.js";

const fixture = vi.hoisted(() => ({
  sessionId: "retained-collector-session",
  lifecycleRevision: "retained-collector-lifecycle",
}));
// mock-isolation: Control config reloads during recovery without loading host config state.
vi.mock("../../../config/config.js", () => ({ getRuntimeConfig: vi.fn(() => ({})) }));
vi.mock("../../../config/sessions/session-accessor.js", () => ({
  findTranscriptEvent: () => {
    throw new Error("Unexpected transcript lookup in queued registration recovery");
  },
}));
vi.mock("../../../config/sessions/session-accessor.sqlite-replacement-projection.js", () => ({
  applySessionEntryExactReplacements: vi.fn(async () => undefined),
}));
vi.mock("./subagent-control-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-control-session.js")>()),
  prepareSubagentKillSession: async (
    _config: unknown,
    _sessionKey: string,
    assertOwner: () => void,
  ) => ({
    storePath: "/synthetic-retained-session/sessions.json",
    entry: { ...fixture, updatedAt: 1 },
    assertCurrent: assertOwner,
    prepareRead: () => undefined,
    withPublication: async <T>(run: () => Promise<T>) => {
      assertOwner();
      return await run();
    },
    release: () => {},
  }),
}));
vi.mock("../../../gateway/call.js", () => ({ callGateway: vi.fn() }));
vi.mock("./subagent-session-reconciliation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-session-reconciliation.js")>()),
  loadSubagentSessionEntry: vi.fn(async () => ({ ...fixture, updatedAt: 1 })),
}));

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});
afterAll(async () => {
  await state.cleanup();
});
beforeEach(() => {
  vi.spyOn(subagentRegistryLog, "warn").mockImplementation(() => {});
  vi.mocked(getRuntimeConfig).mockReturnValue({});
  vi.mocked(applySessionEntryExactReplacements).mockClear();
  subagentRuns.clear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  const stored = await readStored();
  for (const [id, entry] of stored) {
    subagentRuns.set(id, entry);
  }
  await mutateSubagentRuns([...stored.keys()], () => ({
    value: undefined,
    postimages: new Map([...stored.keys()].map((id) => [id, null])),
  }));
  subagentRuns.clear();
});

async function readStored() {
  return readAllSubagentRunsInWorker(captureOpenClawStateWorkerContext({ env: state.env }));
}

type Registration = Parameters<
  ReturnType<typeof createRegistrationFixture>["manager"]["registerSubagentRun"]
>[0];

function registration(runId: string, overrides: Partial<Registration> = {}): Registration {
  return {
    runId,
    childSessionKey: `agent:${overrides.childAgentId ?? "main"}:subagent:${runId}`,
    childAgentId: "main",
    sessionEntry: fixture,
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: "Restore retained child work",
    cleanup: "keep",
    ...overrides,
  };
}

function queuedRegistration(runId: string, overrides: Partial<Registration> = {}): Registration {
  const input = registration(runId, overrides);
  return {
    ...input,
    collect: true,
    groupId: input.groupId ?? runId,
    queued: true,
    queuedLaunch: input.queuedLaunch ?? {
      requesterRecovery: {},
      request: { sessionKey: input.childSessionKey },
      timeoutMs: 100,
      schedulerGroupKey: input.groupId ?? runId,
      maxConcurrent: 1,
    },
  };
}

it.for([
  { sameRequesterAgent: false, preparing: true, closeGateway: false },
  { sameRequesterAgent: false, preparing: false, closeGateway: false },
  { sameRequesterAgent: false, preparing: true, closeGateway: true },
  { sameRequesterAgent: true, preparing: true, closeGateway: false },
  { sameRequesterAgent: true, preparing: false, closeGateway: false },
])(
  "recovers an independent requester session during a database open (same requester agent: $sameRequesterAgent, preparing: $preparing, close: $closeGateway)",
  { timeout: 10_000 },
  async ({ sameRequesterAgent, preparing, closeGateway }, { signal }) => {
    const { manager } = createRegistrationFixture();
    for (const [runId, childAgentId, requester] of [
      ["slow-child", "slow", "slow"],
      ["slow-peer", "healthy", "slow"],
      ["healthy-child", "healthy", "healthy"],
    ] as const) {
      const requesterAgentId = sameRequesterAgent ? "main" : requester;
      await manager.registerSubagentRun(
        registration(runId, {
          childAgentId,
          requesterSessionKey: `agent:${requesterAgentId}:${requester}`,
          requesterAgentId,
          requesterTurnRunId: `${runId}-turn`,
          requesterDisplayKey: requesterAgentId,
        }),
      );
    }
    subagentRuns.clear();
    const databaseReady = createDeferred();
    const healthyRecovered = createDeferred();
    const slowRead = createDeferred();
    let gatewayOpen = true;
    let databaseOpen = false;
    const gateway = sessionSharingTestContext(vi.fn());
    const resolver = () => (gatewayOpen ? gateway : undefined);
    const resumeRun = vi.fn();
    const recovered: string[] = [];
    const restorer = createRestorer({
      getGatewayContextResolver: () => resolver,
      resumeRun,
      recoverInterruptedRuns: async (entries = [...subagentRuns.values()]) => {
        recovered.push(...entries.map((entry) => entry.runId));
        if (recovered.includes("healthy-child")) {
          healthyRecovered.resolve();
        }
      },
    });
    await restorer.restoreOnce();
    await vi.mocked(loadSubagentSessionEntry).withImplementation(
      async ({ childAgentId }) => {
        if (childAgentId === "slow") {
          slowRead.resolve();
          await databaseReady.promise;
        }
        return { ...fixture, updatedAt: 1 };
      },
      async () => {
        const activation = withAgentDatabasePreparationContext(
          () => ({
            waitForAgentPreparation: (agentId) =>
              preparing && agentId === "slow" && !databaseOpen ? databaseReady.promise : undefined,
          }),
          () => restorer.activate(),
        );
        try {
          await withinTest(
            preparing
              ? Promise.race([healthyRecovered.promise, slowRead.promise])
              : healthyRecovered.promise,
            signal,
          );
          expect(resumeRun).toHaveBeenCalledExactlyOnceWith("healthy-child");
          if (preparing) {
            await withinTest(activation.initial, signal);
            expect([...activation.pending.keys()].toSorted()).toEqual(
              sameRequesterAgent ? ["healthy", "main", "slow"] : ["healthy", "slow"],
            );
          }
          gatewayOpen = !closeGateway;
        } finally {
          databaseOpen = true;
          databaseReady.resolve();
          if (closeGateway) {
            await expect(activation.settled).rejects.toThrow("lost its Gateway owner");
          } else {
            await activation.settled;
          }
          restorer.reset();
        }
      },
    );
    expect(recovered).toEqual(
      closeGateway ? ["healthy-child"] : ["healthy-child", "slow-child", "slow-peer"],
    );
    if (closeGateway) {
      expect(resumeRun).toHaveBeenCalledExactlyOnceWith("healthy-child");
    } else {
      expect(resumeRun.mock.calls).toEqual([["healthy-child"], ["slow-child"], ["slow-peer"]]);
    }
  },
);

it.each(["restartRecovery", "killIntent", "killReconciliation"] as const)(
  "activates healthy siblings without reading a child owned by %s",
  async (owner) => {
    const { manager } = createRegistrationFixture();
    for (const runId of ["owned-child", "healthy-child"]) {
      await manager.registerSubagentRun(registration(runId));
    }
    await mutateSubagentRuns(["owned-child"], (rows) => {
      const entry = expectDefined(rows.get("owned-child"), "owned child");
      const postimage: SubagentRunRecord = { ...entry };
      if (owner === "restartRecovery") {
        postimage.execution = {
          ...entry.execution,
          restartRecovery: {
            sessionId: fixture.sessionId,
            sessionMarker: "saved-recovery",
            idempotencyKey: "saved-recovery",
            phase: "reserved",
          },
        };
      } else if (owner === "killIntent") {
        postimage.killIntent = { requestedAt: 1, reason: "operator stop" };
      } else {
        postimage.killReconciliation = { killedAt: 1 };
      }
      return { value: undefined, postimages: new Map([[entry.runId, postimage]]) };
    });
    subagentRuns.clear();
    const gateway = sessionSharingTestContext(vi.fn());
    const resolver = () => gateway;
    const resumeRun = vi.fn();
    const recoverInterruptedRuns = vi.fn(async () => {});
    const restorer = createRestorer({
      getGatewayContextResolver: () => resolver,
      resumeRun,
      recoverInterruptedRuns,
    });
    try {
      await restorer.restoreOnce();
      await vi.mocked(loadSubagentSessionEntry).withImplementation(
        async ({ childSessionKey }) => {
          if (childSessionKey === "agent:main:subagent:owned-child") {
            throw new Error("Owned child database is unavailable");
          }
          return { ...fixture, updatedAt: 1 };
        },
        async () => {
          await restorer.activate().settled;
        },
      );
      expect(resumeRun).toHaveBeenCalledExactlyOnceWith("healthy-child");
      expect(recoverInterruptedRuns).toHaveBeenCalledOnce();
      expect(subagentRuns.get("owned-child")).toBeDefined();
    } finally {
      restorer.reset();
    }
  },
);

it.each(["restart", "restart with newer sibling", "confirmed Stop"] as const)(
  "reconciles a retained descriptorless registration through %s",
  async (recovery) => {
    const newerSibling = recovery === "restart with newer sibling";
    const { refusal, manager } = createRegistrationFixture();
    refusal.terminal = true;
    let ownership: SubagentRegistrationScope | undefined;
    const runId = "retained-registration";
    const childSessionKey = "agent:main:subagent:retained-registration";
    const settleRootWork = observeRootWork();
    const sql = observeMainThreadSql();
    const transport = vi.mocked(callGateway).mockReset().mockResolvedValue({});
    const cleanupResources = vi.fn(async () => true);
    const cleaned = vi.fn(async () => {});
    const resume = vi.fn();
    const startQueued = vi.fn(async () => true);
    const gatewayContext = sessionSharingTestContext(vi.fn());
    const resolveGatewayContext = () => gatewayContext;
    const restorer = createRestorer({
      getGatewayContextResolver: () => resolveGatewayContext,
      resumeRun: resume,
      listSwarmRunsForGroup: () => [...subagentRuns.values()],
      startQueuedSubagentRun: startQueued,
      cleanupCollectorLaunchResources: cleanupResources,
      settleFailedQueuedSubagentLaunch: manager.settleFailedQueuedSubagentLaunch,
      completeCollectorLaunchCleanup: cleaned,
    });
    try {
      await expect(
        manager.registerSubagentRun(
          queuedRegistration(runId, {
            childSessionKey,
            groupId: "retained-group",
          }),
          {
            retainOwnership: (scope) => {
              ownership = scope;
            },
          },
        ),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ outcome: "not-committed" }),
        errors: [
          expect.objectContaining({
            outcome: "not-committed",
            message: expect.stringContaining("descriptor refused"),
          }),
          expect.objectContaining({
            outcome: "not-committed",
            message: expect.stringContaining("terminal settlement refused"),
          }),
        ],
      });
      refusal.terminal = false;
      expect((await readStored()).get(runId)?.queuedLaunch).toBeUndefined();
      expect((await readStored()).get(runId)?.execution.status).toBe("queued");
      expect(expectDefined(ownership, "registration scope").canCleanupSession()).toBe(false);
      expect(transport).not.toHaveBeenCalled();
      expect(cleanupResources).not.toHaveBeenCalled();

      if (recovery === "confirmed Stop") {
        expect(await manager.markSubagentRunTerminated({ runId })).toBe(1);
        const stopped = expectDefined(subagentRuns.get(runId), "stopped original run");
        const stoppedExecution = stopped.execution;
        expect((await readStored()).get(runId)?.killReconciliation).toBeDefined();
        await expect(
          expectDefined(ownership, "registration scope").settleFailedLaunch("later callback"),
        ).resolves.toBeUndefined();
        expect(subagentRuns.get(runId)?.execution).toEqual(stoppedExecution);
        expect(expectDefined(ownership, "registration scope").canCleanupSession()).toBe(false);
        expect(applySessionEntryExactReplacements).toHaveBeenCalled();
        return;
      }
      if (newerSibling) {
        const original = expectDefined((await readStored()).get(runId), "retained original intent");
        const successor: SubagentRunRecord = {
          ...structuredClone(original),
          runId: "recovered-successor",
          generation: (original.generation ?? 0) + 1,
          execution: {
            status: "running",
            startedAt: Date.now(),
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
          },
        };
        await mutateSubagentRuns([successor.runId], () => ({
          value: undefined,
          postimages: new Map([[successor.runId, successor]]),
        }));
      }
      subagentRuns.clear();
      await restorer.restoreOnce();
      await restorer.activate().settled;
      await settleRootWork(true);
      expect((await readStored()).get(runId)?.execution.status).toBe("terminal");
      expect((await readStored()).get(runId)).toMatchObject({
        execution: { status: "terminal", lifecycleGeneration: getAgentEventLifecycleGeneration() },
        collectorCompletion: { status: "failed" },
      });
      if (newerSibling) {
        expect(transport).not.toHaveBeenCalled();
        expect(cleanupResources).not.toHaveBeenCalled();
        expect((await readStored()).get(runId)?.execution.suppressSessionEffects).toBe(true);
        expect(resume).toHaveBeenCalledExactlyOnceWith("recovered-successor");
      } else {
        expect(transport).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            method: "sessions.delete",
            params: expect.objectContaining({
              key: childSessionKey,
              expectedSessionId: fixture.sessionId,
              expectedLifecycleRevision: fixture.lifecycleRevision,
            }),
          }),
        );
        expect(cleanupResources).toHaveBeenCalledOnce();
        expect(cleaned).toHaveBeenCalledExactlyOnceWith(runId);
        expect(resume).not.toHaveBeenCalled();
      }
      expect(startQueued).not.toHaveBeenCalled();
      sql.expectIdle();
    } finally {
      try {
        restorer.reset();
        await settleRootWork();
        sql.expectIdle();
      } finally {
        sql.restore();
      }
    }
  },
);

it.each([
  "accepted after input recovery",
  "shutdown during input recovery",
  "accepted after limit reload",
  "captured system",
  "requester unavailable",
  "operator unavailable",
  "legacy unclassified",
  "malformed capture",
  "malformed operator",
] as const)("restores queued requester custody with an explicit %s outcome", async (outcome) => {
  const { refusal, manager } = createRegistrationFixture();
  refusal.descriptor = false;
  const reloadLimit = outcome === "accepted after limit reload";
  const configureLimit = (maxConcurrent: number) =>
    vi.mocked(getRuntimeConfig).mockReturnValue({
      tools: { swarm: { maxConcurrent: 3 } },
      agents: { entries: { main: { tools: { swarm: { maxConcurrent } } } } },
    });
  if (reloadLimit) {
    configureLimit(2);
  }
  const runId = "queued-requester-custody";
  const runningSiblingId = "queued-requester-running-sibling";
  const childAgentId = reloadLimit ? "worker" : "main";
  const childSessionKey = `agent:${childAgentId}:subagent:queued-requester-custody`;
  const requesterFacts = {
    sessionKey: "agent:main:slack:channel:human",
    messageProvider: "slack",
    senderId: "bob",
  };
  await manager.registerSubagentRun(
    queuedRegistration(runId, {
      childSessionKey,
      childAgentId,
      queuedLaunch: {
        request: { sessionKey: childSessionKey, idempotencyKey: runId, message: "Queued work" },
        ...(outcome === "legacy unclassified"
          ? {}
          : {
              requesterRecovery:
                outcome === "captured system"
                  ? {}
                  : {
                      facts: outcome === "requester unavailable" ? null : requesterFacts,
                      ...(outcome === "operator unavailable"
                        ? { operator: { kind: "unavailable" as const } }
                        : {}),
                    },
            }),
        timeoutMs: 100,
        schedulerGroupKey: runId,
        maxConcurrent: 1,
      },
    }),
  );
  if (reloadLimit) {
    await manager.registerSubagentRun(
      registration(runningSiblingId, {
        childAgentId,
        collect: true,
        groupId: runId,
      }),
    );
  }
  if (outcome === "malformed capture" || outcome === "malformed operator") {
    await mutateSubagentRuns([runId], (rows) => {
      const draft = structuredClone(expectDefined(rows.get(runId), "persisted queued run"));
      const launch = expectDefined(draft.queuedLaunch, "persisted queued descriptor");
      // Model corrupted retained bytes without widening the typed producer contract.
      Object.defineProperty(launch, "requesterRecovery", {
        value: outcome === "malformed capture" ? [] : { facts: requesterFacts, operator: null },
        enumerable: true,
      });
      return { value: undefined, postimages: new Map([[runId, draft]]) };
    });
  }
  subagentRuns.clear();
  const gateway = sessionSharingTestContext(vi.fn());
  const inputRecovery =
    outcome === "accepted after input recovery" || outcome === "shutdown during input recovery"
      ? new GatewayInputRecovery()
      : undefined;
  const recoveryWaitStarted = createDeferred();
  if (inputRecovery) {
    gateway.inputRecovery = inputRecovery;
    const wait = inputRecovery.waitForAgentInputRecovery.bind(inputRecovery);
    vi.spyOn(inputRecovery, "waitForAgentInputRecovery").mockImplementation((...args) => {
      recoveryWaitStarted.resolve();
      return wait(...args);
    });
  }
  const resolver = () => gateway;
  let acceptedOptions: GatewayInstanceAgentDispatchOptions | undefined;
  const settled = createDeferred<string>();
  vi.mocked(callGateway).mockReset().mockResolvedValue({});
  const recovery = createMockGatewayRecoveryRuntime();
  vi.mocked(recovery.dispatchAgent).mockImplementation(async (_request, _timeout, options) => {
    acceptedOptions = options;
    options?.assertAdmissionCurrent?.();
    settled.resolve("accepted");
    return { runId, status: "accepted" };
  });
  gateway.recoveryRuntime = recovery;
  const settleRootWork = observeRootWork();
  const started = vi.fn(manager.startQueuedSubagentRun);
  const restorer = createRestorer({
    getGatewayContextResolver: () => resolver,
    listSwarmRunsForGroup: () => [...subagentRuns.values()],
    startQueuedSubagentRun: started,
    settleFailedQueuedSubagentLaunch: async (id, error) => {
      const recorded = await manager.settleFailedQueuedSubagentLaunch(id, error);
      settled.resolve(error);
      return recorded;
    },
  });
  try {
    await restorer.restoreOnce();
    if (reloadLimit) {
      const preparationStarted = createDeferred();
      const databaseReady = createDeferred();
      const activation = withAgentDatabasePreparationContext(
        () => ({
          waitForAgentPreparation: (agentId) => {
            if (agentId !== childAgentId) {
              return undefined;
            }
            preparationStarted.resolve();
            return databaseReady.promise;
          },
        }),
        () => restorer.activate().settled,
      );
      try {
        await awaitGateBeforeSettlement(
          preparationStarted.promise,
          activation,
          "Recovery did not wait for the child's database",
        );
        configureLimit(1);
      } finally {
        databaseReady.resolve();
        await activation;
      }
      await settleRootWork(true);
      expect(isSwarmRunActive(runId)).toBe(false);
      expect(recovery.dispatchAgent).not.toHaveBeenCalled();
      expect(releaseSwarmRun(runningSiblingId)).toBe(true);
    } else {
      await restorer.activate().settled;
    }
    if (inputRecovery) {
      await awaitGateBeforeSettlement(
        recoveryWaitStarted.promise,
        settled.promise,
        "Restored collector dispatched before input recovery completed",
      );
      expect(recovery.dispatchAgent).not.toHaveBeenCalled();
      expect((await readStored()).get(runId)?.execution.status).toBe("queued");
      if (outcome === "shutdown during input recovery") {
        await closeSwarmScheduler();
        expect(recovery.dispatchAgent).not.toHaveBeenCalled();
        expect((await readStored()).get(runId)).toMatchObject({
          execution: { status: "queued" },
          queuedLaunch: { request: { idempotencyKey: runId } },
        });
        await settleRootWork(true);
        return;
      }
      inputRecovery.releaseInitial();
    }
    const result = await settled.promise;
    if (inputRecovery || reloadLimit || outcome === "captured system") {
      expect(result).toBe("accepted");
      await settleRootWork(true);
      expect(started).toHaveBeenCalledOnce();
      if (outcome === "captured system") {
        expect(acceptedOptions?.agentToolCaller).toBeUndefined();
      } else {
        const caller = expectDefined(
          acceptedOptions?.agentToolCaller,
          "accepted requester custody",
        );
        expect(caller.requesterOrigin).toEqual(requesterFacts);
        expect(caller.assertCurrent).not.toThrow();
      }
      expect(acceptedOptions?.assertAdmissionCurrent).not.toThrow();
    } else {
      const error =
        outcome === "legacy unclassified" || outcome === "malformed capture"
          ? "Queued requester recovery source is unavailable; submit a new request."
          : outcome === "requester unavailable"
            ? "Queued requester identity could not be retained; submit a new request."
            : outcome === "malformed operator"
              ? "Queued operator recovery source is invalid; submit a new request."
              : "Queued operator authority cannot be recovered; submit a new request.";
      expect(result).toBe(error);
      await expect(settleRootWork(true)).rejects.toMatchObject({
        errors: expect.arrayContaining([expect.objectContaining({ message: error })]),
      });
      expect(recovery.dispatchAgent).not.toHaveBeenCalled();
      expect(started).not.toHaveBeenCalled();
      expect((await readStored()).get(runId)).toMatchObject({
        execution: { status: "terminal", outcome: { status: "error", error } },
        collectorCompletion: { status: "failed" },
      });
    }
    expect((await readStored()).get(runId)?.queuedLaunch).toBeUndefined();
  } finally {
    inputRecovery?.releaseInitial();
    restorer.reset();
    if (releaseSwarmRun(runningSiblingId)) {
      await settleRootWork(true);
    }
    releaseSwarmRun(runId);
    await settleRootWork();
  }
});

it("leaves an acknowledged collector rekey with its launch owner during restore metadata preparation", async () => {
  const { refusal, manager } = createRegistrationFixture();
  refusal.descriptor = false;
  const runId = "queued-restore-address";
  const acceptedRunId = "accepted-restore-address";
  const childSessionKey = "agent:main:subagent:restore-rekey";
  await manager.registerSubagentRun(
    queuedRegistration(runId, {
      childSessionKey,
      groupId: "restore-rekey",
    }),
  );
  const gateway = sessionSharingTestContext(vi.fn());
  const resolver = () => gateway;
  const resumeRun = vi.fn();
  const startQueuedSubagentRun = vi.fn(async () => true);
  const restorer = createRestorer({
    getGatewayContextResolver: () => resolver,
    resumeRun,
    startQueuedSubagentRun,
  });
  const entered = createDeferred();
  const release = createDeferred();
  vi.mocked(loadSubagentSessionEntry).mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return { ...fixture, updatedAt: 1 };
  });
  await restorer.restoreOnce();
  const activation = restorer.activate().settled;
  try {
    await awaitGateBeforeSettlement(
      entered.promise,
      activation,
      "Restore skipped metadata preparation",
    );
    expect(await manager.startQueuedSubagentRun(runId, acceptedRunId)).toBe(true);
    const accepted = expectDefined(subagentRuns.get(acceptedRunId), "accepted collector");
    release.resolve();
    await activation;
    expect(subagentRuns.has(runId)).toBe(false);
    expect(subagentRuns.get(acceptedRunId)).toBe(accepted);
    expect(accepted.execution.status).toBe("running");
    expect(resumeRun).not.toHaveBeenCalled();
    expect(startQueuedSubagentRun).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await activation;
    restorer.reset();
  }
});

it.each(["current", "during hydration"] as const)(
  "isolates failed requester activation until an explicit retry (%s)",
  async (owner) => {
    const { manager } = createRegistrationFixture();
    for (const runId of ["first-child", "later-child"]) {
      await manager.registerSubagentRun(
        registration(runId, {
          requesterSessionKey: `agent:main:${runId}-requester`,
          requesterTurnRunId: `${runId}-turn`,
          expectsCompletionMessage: true,
        }),
      );
    }
    subagentRuns.clear();
    const context = sessionSharingTestContext(vi.fn());
    const resolver = () => context;
    context.resolveGatewayContext = resolver;
    const failure = new Error("requester transfer temporarily unavailable");
    let firstAttempts = 0;
    const restoredRows: WeakRef<SubagentRunRecord>[] = [];
    const settleRequesterTurn = vi.fn<
      Parameters<typeof createSubagentRegistryRestorer>[0]["settleRequesterTurn"]
    >(async (params) => {
      params.assertCurrent?.();
      const first = params.requesterTurnRunId === "first-child-turn";
      if (first && ++firstAttempts < 2) {
        throw failure;
      }
      const runId = first ? "first-child" : "later-child";
      await mutateSubagentRuns(
        [runId],
        (rows) => {
          const entry = expectDefined(rows.get(runId), "restored requester child");
          restoredRows.push(new WeakRef(entry));
          return {
            value: undefined,
            postimages: new Map([[runId, { ...entry, requesterTurnRunId: undefined }]]),
          };
        },
        { context: params.stateContext, assertCurrent: params.assertCurrent },
      );
      return true;
    });
    const resumeRun = vi.fn();
    const restorer = createRestorer({
      getGatewayContextResolver: () => resolver,
      settleRequesterTurn,
      resumeRun,
    });
    try {
      if (owner === "during hydration") {
        await restorer.activate().settled;
        await expect(restorer.restoreOnce(true)).rejects.toBe(failure);
      } else {
        await restorer.restoreOnce();
        await expect(restorer.activate().settled).rejects.toBe(failure);
      }
      // Independent requester sessions have no cross-session resume order.
      expect(resumeRun).toHaveBeenCalledTimes(2);
      expect(resumeRun).toHaveBeenCalledWith("first-child");
      expect(resumeRun).toHaveBeenCalledWith("later-child");
      expect(subagentRuns.get("first-child")?.requesterTurnRunId).toBe("first-child-turn");
      expect(subagentRuns.get("later-child")?.requesterTurnRunId).toBeUndefined();
      await restorer.activate().settled;
      expect(subagentRuns.get("first-child")?.requesterTurnRunId).toBeUndefined();
      expect(settleRequesterTurn).toHaveBeenCalledTimes(3);
      expect(resumeRun).toHaveBeenCalledTimes(2);
      // Session-read mock arguments retain the recovery authority closures.
      vi.clearAllMocks();
      await setImmediate();
      queryObjects(WeakRef);
      expect(restoredRows.map((entry) => entry.deref())).toEqual([undefined, undefined]);
      await restorer.activate().settled;
      expect(resumeRun).not.toHaveBeenCalled();
    } finally {
      restorer.reset();
    }
  },
);

it("retries retirement when registration supersedes another restored child during a held write", async () => {
  const { manager } = createRegistrationFixture();
  const settleOwnedWork = observeRootWork();
  const held = createDeferred();
  const release = createDeferred();
  const retiredLater = createDeferred();
  const context = sessionSharingTestContext(vi.fn());
  const resolver = () => context;
  context.resolveGatewayContext = resolver;
  const register = (runId: string, child: string, expectsCompletionMessage = false) =>
    manager.registerSubagentRun(
      registration(runId, {
        childSessionKey: `agent:main:subagent:${child}`,
        requesterSessionKey: "agent:main:retirement-requester",
        requesterTurnRunId: expectsCompletionMessage ? "retirement-turn" : undefined,
        expectsCompletionMessage,
      }),
    );
  const restorer = createRestorer({
    getGatewayContextResolver: () => resolver,
    settleRequesterTurn: async () => {
      throw new Error("Superseded children must retire before requester handoff");
    },
    retireSupersededRun: async (runId, entry, assertCurrent) => {
      await retireSupersededSubagentRun({
        runId,
        entry,
        runs: subagentRuns,
        clearPendingLifecycleError: () => {},
        assertCurrent,
      });
      if (runId === "later-child") {
        retiredLater.resolve();
      }
    },
  });
  let activation: Promise<unknown> | undefined;
  try {
    for (const runId of ["first-child", "later-child"]) {
      await register(runId, runId, true);
      expect(await manager.markSubagentRunTerminated({ runId })).toBe(1);
    }
    await register("first-successor", "first-child");
    subagentRuns.clear();
    await restorer.restoreOnce();
    expect(subagentRuns.get("first-child")?.killReconciliation?.supersededAt).toBeTypeOf("number");
    expect(subagentRuns.get("later-child")?.killReconciliation?.supersededAt).toBeUndefined();

    const execute = expectDefined(
      vi.mocked(stateWorker.runOpenClawStateWorkerOperation).getMockImplementation(),
      "registration fixture worker transport",
    );
    vi.mocked(stateWorker.runOpenClawStateWorkerOperation).mockImplementation(
      (owner, run, options) =>
        execute(
          owner,
          (scope) =>
            run({
              execute: async (command, executeOptions) => {
                if (
                  isSubagentRegistryWriteCommand(command) &&
                  command.input.deleteRunIds.includes("first-child")
                ) {
                  held.resolve();
                  await release.promise;
                }
                return scope.execute(command, executeOptions);
              },
            }),
          options,
        ),
    );
    activation = restorer.activate().settled.then(
      () => undefined,
      (error: unknown) => error,
    );
    await awaitGateBeforeSettlement(
      held.promise,
      activation,
      "Restored retirement did not reach its native deletion",
    );
    await register("later-successor", "later-child");
    expect((await readStored()).get("later-child")?.killReconciliation?.supersededAt).toBeTypeOf(
      "number",
    );
    release.resolve();
    expect(await activation).toBeInstanceOf(SubagentRegistryMutationRejectedError);
    expect((await readStored()).has("first-child")).toBe(false);
    expect((await readStored()).get("later-child")?.requesterTurnRunId).toBe("retirement-turn");

    await restorer.activate().settled;
    await retiredLater.promise;
    const saved = await readStored();
    expect(saved.has("later-child")).toBe(false);
    for (const runId of ["first-successor", "later-successor"]) {
      expect(saved.get(runId)).toMatchObject({
        runId,
        expectsCompletionMessage: false,
        execution: { status: "running" },
      });
    }
  } finally {
    release.resolve();
    await activation;
    restorer.reset();
    await settleOwnedWork();
  }
});
