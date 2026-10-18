// Requester continuation and child-batch ownership across Gateway replacement.
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  makeRestartRecoveryRun as makeRunRecord,
  useSubagentRestartRecoveryFixture,
} from "./subagent-restart-recovery.test-support.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../../config/config.js";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { markCanonicalSessionValidationPending } from "../../../config/sessions/session-canonical-key.js";
import { captureGatewayAuthPolicy } from "../../../gateway/auth-policy.js";
import * as gatewayCall from "../../../gateway/call.js";
import { captureGatewayOperatorRunAuthority } from "../../../gateway/operator-run-authority.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { prepareGatewayStartupSessions } from "../../../gateway/server-startup-session-migration.js";
import { persistGatewaySessionLifecycleEvent } from "../../../gateway/session-lifecycle-state.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  getSharedGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import {
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} from "../../../state/openclaw-agent-db.js";
import { createRecoveryRuntimeFixture } from "../../main-session-recovery/main-session-recovery-runtime.test-support.js";
import { transitionMainSessionRecovery } from "../../main-session-recovery/main-session-recovery-state.js";
import {
  markRestartAbortedMainSessions,
  markStartupOrphanedMainSessionsForRecovery,
} from "../../main-session-recovery/main-session-restart-recovery-marking.js";
import { recoverRestartAbortedMainSessions } from "../../main-session-recovery/main-session-restart-recovery.js";
import { createRestartRecoveryOperatorSource } from "../../operator-run-recovery-source.js";
import { createAgentRunRestartAbortError } from "../../run-termination.js";
import type { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { settleRequesterTurnAfterSessionSpawns } from "./subagent-registry-requester-yield.js";
import { createRequesterInitialTransferFixture } from "./subagent-registry-requester-yield.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import {
  prepareSubagentRecoveryFixture,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import {
  addSubagentRunForTests,
  activateSubagentRegistry,
  getSubagentRunByChildSessionKey,
  initSubagentRegistry,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

vi.mock("../../../gateway/session-utils.fs.js", () => ({
  readSessionMessagesAsync: vi.fn(async () => []),
}));

function lifecycleWriter(sessionKey: string, sessionId: string, agentId?: string) {
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  return (
    runId: string,
    ts: number,
    data: Parameters<typeof persistGatewaySessionLifecycleEvent>[0]["event"]["data"],
  ) =>
    persistGatewaySessionLifecycleEvent({
      sessionKey,
      agentId,
      event: { runId, sessionId, lifecycleGeneration, ts, data },
    });
}

describe("subagent parent recovery — durable yielded continuation", () => {
  const fixture = useSubagentRestartRecoveryFixture({ reuseDatabaseWorkers: true });
  const { activateGatewayRuntime, dispatchAgent, gatewayRuntime } = fixture;
  const writeSession = (
    params: Omit<Parameters<typeof writeSubagentSessionEntry>[0], "stateDir" | "agentId"> & {
      agentId?: string;
    },
  ) => writeSubagentSessionEntry({ stateDir: fixture.stateDir, agentId: "main", ...params });

  function recoveryFixture() {
    const settlement = createDeferred();
    const dispatch = vi
      .spyOn(gatewayCall, "callGateway")
      .mockResolvedValue({ runId: "recovered-parent" });
    const runtime = createRecoveryRuntimeFixture({
      callGateway: gatewayCall.callGateway,
      getDispatchSettlement: () => settlement.promise,
      sendRecoveryNotice: vi.fn(async () => ({ suppressed: false })),
    });
    return { settlement, dispatch, runtime };
  }

  it.each([
    ["subagent_settle", "announce:requester-settle:main:agent:main:parent:child:pause"],
    ["subagent_announce", "announce:v1:agent:main:subagent:child:child"],
  ])(
    "recovers an active %s turn once alongside queued child announcements",
    async (sourceTool, runId) => {
      const sessionKey = "agent:main:parent";
      const sessionId = "parent-session";
      const parentRunId = "parent-before-yield";
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const lifecycle = lifecycleWriter(sessionKey, sessionId);
      const storePath = await writeSession({
        sessionKey,
        defaultSessionId: sessionId,
        updatedAt: 1,
      });
      const target = { agentId: "main", storePath, sessionKey };
      await lifecycle(parentRunId, 1, { phase: "start", startedAt: 1 });
      const child = makeRunRecord({
        runId: "child",
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        requesterTurnRunId: parentRunId,
        requesterTurnYielded: true,
        expectsCompletionMessage: true,
      });
      await addSubagentRunForTests(child);
      await settleRequesterTurnAfterSessionSpawns({
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        requesterTurnRunId: parentRunId,
        requesterYielded: true,
        acceptedSessionSpawns: [{ runId: child.runId, childSessionKey: child.childSessionKey }],
        runs: subagentRuns,
        transfer: createRequesterInitialTransferFixture(subagentRuns),
        schedule: vi.fn(),
      });
      await lifecycle(parentRunId, 2, {
        phase: "end",
        yielded: true,
        livenessState: "paused",
        stopReason: "end_turn",
        endedAt: 2,
      });
      await lifecycle(runId, 3, { phase: "start", startedAt: 3 });
      await appendTranscriptMessage(
        { ...target, sessionId },
        {
          cwd: fixture.stateDir,
          message: {
            role: "user",
            content: "Continue the parent's work with this child result.",
            idempotencyKey: runId,
            provenance: {
              kind: "inter_session",
              sourceTool,
              sourceSessionKey: child.childSessionKey,
            },
          },
        },
      );
      expect(loadSessionEntryReadOnly(target)).toMatchObject({
        lifecycleRunId: runId,
      });
      expect(loadSessionEntryReadOnly(target)?.status).toBeUndefined();
      expect(
        await markRestartAbortedMainSessions({
          stateDir: fixture.stateDir,
          resolveGatewayContext: getGatewayContextResolver(gatewayRuntime)!,
          activeRuns: [
            { sessionKey, sessionId, runId, lifecycleGeneration },
            { sessionKey, sessionId, runId: "queued-child-announce", lifecycleGeneration },
          ],
        }),
      ).toEqual({ marked: 1, skipped: 0 });
      await lifecycle(runId, 4, {
        phase: "error",
        error: createAgentRunRestartAbortError(),
        aborted: true,
        stopReason: "restart",
      });
      rotateAgentEventLifecycleGeneration();
      await markStartupOrphanedMainSessionsForRecovery({ stateDir: fixture.stateDir });
      expect(loadSessionEntryReadOnly(target)).toMatchObject({
        abortedLastRun: true,
        mainRestartRecovery: expect.objectContaining({ cycleId: expect.any(String) }),
      });
      const { settlement, dispatch, runtime } = recoveryFixture();
      try {
        expect(
          await recoverRestartAbortedMainSessions({
            stateDir: fixture.stateDir,
            gatewayRuntime: runtime,
          }),
        ).toMatchObject({ started: 1, failed: 0 });
        expect(loadSessionEntryReadOnly(target)).toMatchObject({
          restartRecoveryDeliverySourceRunId: runId,
          abortedLastRun: false,
        });
        await recoverRestartAbortedMainSessions({
          stateDir: fixture.stateDir,
          gatewayRuntime: runtime,
        });
        expect(dispatch).toHaveBeenCalledOnce();
      } finally {
        settlement.resolve();
      }
    },
  );

  it("hands recovered child completion to the replacement Gateway without reviving its predecessor", async () => {
    const now = Date.now();
    const runId = "warm-restart-child";
    const childSessionKey = "agent:main:subagent:warm-restart-child";
    const requesterSessionKey = "agent:main:main";
    const requesterSessionId = "warm-restart-parent-session";
    const requesterLifecycleRevision = "warm-restart-parent-lifecycle";
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: requesterSessionKey,
      defaultSessionId: requesterSessionId,
      lifecycleRevision: requesterLifecycleRevision,
      updatedAt: now,
    });
    await writeSession({
      sessionKey: childSessionKey,
      defaultSessionId: "warm-restart-child-session",
      updatedAt: now,
      abortedLastRun: true,
    });
    const predecessor = makeRunRecord({
      runId,
      childSessionKey,
      childSessionIdentity: { sessionId: "warm-restart-child-session" },
      requesterSessionKey,
      requesterAgentId: "main",
      completionTarget: "parent",
      completionRequesterSessionId: requesterSessionId,
      completionRequesterLifecycleRevision: requesterLifecycleRevision,
      expectsCompletionMessage: true,
      execution: {
        status: "interrupted",
        startedAt: now - 1_000,
        interruptedAt: now,
        interruptionReason: "gateway-restart",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        requesterYieldBatch: true,
        rearmGeneration: 1,
        batchRunIds: [runId],
      },
    });
    let previousOpen = true;
    const previousContext = {
      ...createContext(),
      recoveryRuntime: gatewayRuntime,
      chatAbortControllers: new Map(),
      resolveGatewayContext: () => (previousOpen ? previousContext : undefined),
    } as GatewayRequestContext;
    const client = createOperatorClient({
      profileName: "restart-child-owner",
      scopes: ["operator.write"],
    });
    client.internal = { authenticatedOperator: true };
    client.authPolicy = captureGatewayAuthPolicy(previousContext.getRuntimeConfig(), {
      role: "operator",
      authMethod: "token",
    });
    const source = (await captureGatewayOperatorRunAuthority({
      client,
      context: previousContext,
      sourceAuthority: null,
    }))!;
    expect(source.authority.recoverySnapshot).toBeDefined();
    predecessor.operatorRecoverySource = createRestartRecoveryOperatorSource({
      authority: source.authority,
      agentId: "main",
      sessionKey: requesterSessionKey,
      entry: {
        sessionId: requesterSessionId,
        lifecycleRevision: requesterLifecycleRevision,
        updatedAt: now,
      },
      sourceRunId: "warm-restart-parent-turn",
    });
    await initSubagentRegistry();
    await activateSubagentRegistry(() => previousContext);
    bindGatewayContextResolver(predecessor, previousContext.resolveGatewayContext);
    await addSubagentRunForTests(predecessor);
    const registeredPredecessor = (await getSubagentRunByChildSessionKey(childSessionKey))!;
    bindGatewayContextResolver(registeredPredecessor, previousContext.resolveGatewayContext);
    client.internal = { ...client.internal, operatorRunAuthority: source.authority };
    const continuation = await withPluginRuntimeGatewayRequestScope(
      {
        client,
        context: previousContext,
        resolveGatewayContext: previousContext.resolveGatewayContext,
        isWebchatConnect: () => false,
      },
      () => captureOperatorToolGatewayContinuationContext(),
    );
    expect(continuation?.operatorAuthority).toBe(source.authority);
    subagentRuns.bindCompletionAuthority(registeredPredecessor, continuation!);
    source.release();
    expect(() =>
      subagentRuns.runWithCompletionAuthority(registeredPredecessor, () => {}),
    ).not.toThrow();
    expect(subagentRuns.get(runId)?.execution.status).toBe("interrupted");
    previousOpen = false;
    expect(source.authority.assertCurrent).toThrow("operator source authority is no longer active");
    rotateAgentEventLifecycleGeneration();

    let replacementOpen = true;
    const replacementRuntime = { ...gatewayRuntime };
    const replacementContext = {
      ...createContext(),
      recoveryRuntime: replacementRuntime,
      chatAbortControllers: new Map(),
      resolveGatewayContext: () => (replacementOpen ? replacementContext : undefined),
    } as GatewayRequestContext;
    bindGatewayContextResolver(replacementRuntime, replacementContext.resolveGatewayContext);
    await activateSubagentRegistry(() => replacementContext);
    await testing.sweepOnceForTests();

    expect(dispatchAgent).not.toHaveBeenCalled();
    const successor = await getSubagentRunByChildSessionKey(childSessionKey);
    expect(successor).toMatchObject({
      runId: predecessor.runId,
      childSessionKey: predecessor.childSessionKey,
      createdAt: predecessor.createdAt,
    });
    expect(successor?.generation).toBe(predecessor.generation);
    expect(successor?.execution.status).toBe("terminal");
    expect(successor?.execution.outcome).toMatchObject({
      status: "error",
      error: expect.stringContaining("interrupted by a Gateway restart"),
    });
    expect(() =>
      subagentRuns.runWithCompletionAuthority(registeredPredecessor, () => {}),
    ).toThrow();
    const restoredAuthority = subagentRuns.runWithCompletionAuthority(
      successor!,
      () => getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority,
    );
    expect(restoredAuthority?.profileId).toBe(source.authority.profileId);
    expect(restoredAuthority?.scopes).toEqual(["operator.write"]);
    expect(() => restoredAuthority?.assertCurrent()).not.toThrow();
    const resolveWakeGateway = getSharedGatewayContextResolver([successor!]);
    expect(resolveWakeGateway?.()).toBe(replacementContext);
    replacementOpen = false;
    expect(resolveWakeGateway?.()).toBeUndefined();
    expect(getGatewayContextResolver(predecessor)?.()).toBeUndefined();
  });

  it.each([
    "waiting",
    "legacy waiting",
    "legacy new foreground",
    "new foreground",
    "already marked",
    "pending final",
    "marked pending final",
    "reserved waiting cycle",
    "settled batch",
    "delivered child awaiting final",
    "unrelated agent",
    "provider timeout",
    "global in second agent store",
  ])("defers a yielded parent only while its continuation remains owned: %s", async (scenario) => {
    const legacy = scenario.startsWith("legacy ");
    const newForeground = scenario === "new foreground" || scenario === "legacy new foreground";
    const globalParent = scenario === "global in second agent store";
    const rawParent = globalParent || scenario === "unrelated agent";
    const parentAgentId = globalParent ? "other" : "main";
    const requesterAgentId = scenario === "unrelated agent" ? "other" : parentAgentId;
    if (rawParent) {
      setRuntimeConfigSnapshot({
        agents: { entries: { main: {}, other: {} } },
        session: { scope: "global" },
      });
    }
    const now = Date.now();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const parentKey = rawParent ? "global" : "agent:main:yielded-parent-recovery";
    const lifecycle = lifecycleWriter(parentKey, "yielded-parent-session", parentAgentId);
    const parentRunId = "yielded-parent-original-run";
    const childKey = "agent:main:subagent:yielded-parent-child";
    const parentStorePath = await writeSession({
      agentId: parentAgentId,
      sessionKey: parentKey,
      defaultSessionId: "yielded-parent-session",
      updatedAt: now - 2_000,
    });
    await writeSession({
      sessionKey: childKey,
      defaultSessionId: "yielded-parent-child-session",
      updatedAt: now - 1_000,
    });
    await lifecycle(parentRunId, now - 2_000, { phase: "start", startedAt: now - 2_000 });
    const child = makeRunRecord({
      runId: "yielded-parent-child-run",
      childSessionKey: childKey,
      childSessionIdentity: { sessionId: "yielded-parent-child-session" },
      requesterSessionKey: parentKey,
      requesterAgentId,
      requesterTurnRunId: parentRunId,
      requesterTurnYielded: true,
      expectsCompletionMessage: true,
    });
    if (scenario === "settled batch") {
      await prepareSubagentRecoveryFixture(child, {
        entries: {
          [parentKey]: loadSessionEntryReadOnly({
            storePath: parentStorePath,
            sessionKey: parentKey,
          })!,
        },
        storePath: parentStorePath,
      });
    }
    await addSubagentRunForTests(child);
    expect(
      await settleRequesterTurnAfterSessionSpawns({
        requesterSessionKey: parentKey,
        requesterAgentId,
        requesterTurnRunId: parentRunId,
        requesterYielded: true,
        acceptedSessionSpawns: [{ runId: child.runId, childSessionKey: childKey }],
        runs: subagentRuns,
        transfer: createRequesterInitialTransferFixture(subagentRuns),
        schedule: vi.fn(),
      }),
    ).toBe(true);
    await lifecycle(parentRunId, now - 1_000, {
      phase: "end",
      yielded: true,
      livenessState: "paused",
      stopReason: "end_turn",
      endedAt: now - 1_000,
    });
    if (newForeground) {
      await lifecycle("new-foreground-run", now, { phase: "start", startedAt: now });
    }
    const before = loadSessionEntryReadOnly({ storePath: parentStorePath, sessionKey: parentKey })!;
    expect(before.endedAt).toBe(newForeground ? undefined : now - 1_000);
    expect(before.restartRecoveryRuns).toContainEqual({
      runId: newForeground ? "new-foreground-run" : parentRunId,
      lifecycleGeneration,
    });
    if (scenario === "waiting") {
      // The parent may still be registered while its completed turn tears down.
      // Shutdown must not replace the durable batch's continuation with main recovery.
      expect(
        await markRestartAbortedMainSessions({
          cfg: getRuntimeConfig(),
          stateDir: fixture.stateDir,
          resolveGatewayContext: getGatewayContextResolver(gatewayRuntime)!,
          activeRuns: [
            {
              runId: parentRunId,
              sessionKey: parentKey,
              sessionId: before.sessionId,
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
            },
          ],
        }),
      ).toEqual({ marked: 0, skipped: 0 });
    }
    if (["already marked", "marked pending final", "reserved waiting cycle"].includes(scenario)) {
      // Persist the previous shutdown producer's real transition as an upgrade fixture.
      transitionMainSessionRecovery(before, {
        kind: "mark_interrupted",
        cycleId: "previous-gateway-yield-marker",
        now,
        runs: [{ runId: parentRunId, lifecycleGeneration: getAgentEventLifecycleGeneration() }],
      });
    }
    if (scenario === "pending final" || scenario === "marked pending final") {
      before.pendingFinalDelivery = {
        kind: "replayable",
        text: "Waiting for the child result.",
        intentId: "yield-acknowledgment-intent",
        deliveries: [{ id: "not-yet-enqueued-yield-acknowledgment", state: "prepared" }],
        createdAt: now,
      };
    }
    if (scenario === "reserved waiting cycle") {
      const observation = transitionMainSessionRecovery(before, {
        kind: "observe",
        cycleId: "previous-gateway-yield-marker",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        sessionKey: parentKey,
      });
      if (observation.kind !== "observed" || observation.view.status !== "recoverable") {
        throw new Error("Expected the persisted recovery cycle to admit its reservation");
      }
      expect(
        transitionMainSessionRecovery(before, {
          kind: "prepare_attempt",
          attempt: observation.view.nextAttempt,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          now,
          observation: observation.view.observation,
          runId: "reserved-parent-recovery",
          executionIdentity: { state: "disabled" },
        }).kind,
      ).toBe("reserved");
    }
    if (
      [
        "already marked",
        "pending final",
        "marked pending final",
        "reserved waiting cycle",
      ].includes(scenario)
    ) {
      await replaceSessionEntry({ storePath: parentStorePath, sessionKey: parentKey }, before);
    }
    if (scenario === "settled batch" || scenario === "delivered child awaiting final") {
      await mutateSubagentRuns([child.runId], (rows) => {
        const current = rows.get(child.runId);
        if (!current) {
          throw new Error("Expected the yielded child to remain registered");
        }
        return {
          value: undefined,
          postimages: new Map([
            [
              child.runId,
              {
                ...current,
                execution: {
                  ...current.execution,
                  status: "terminal" as const,
                  endedAt: now,
                  outcome: { status: "ok" as const },
                },
                delivery: {
                  status: "delivered" as const,
                  disposition: "delivered" as const,
                  deliveredAt: now,
                },
                cleanupCompletedAt: now,
              },
            ],
          ]),
        };
      });
      if (scenario === "settled batch") {
        // Settle through the lifecycle's exact batch callback, not by deleting a flag.
        const deliverBatch = vi.fn<typeof maybeWakeRequesterAfterAllChildrenSettled>(
          async (params) => {
            await params.completeBatch(
              [params.settledEntry],
              params.settledEntry.requesterSettleWake?.rearmGeneration,
              { delivered: true, requesterVisibleFinalDelivered: true, path: "direct" },
            );
            return true;
          },
        );
        vi.spyOn(
          await import("../announce/subagent-announce.requester-settle-wake.js"),
          "maybeWakeRequesterAfterAllChildrenSettled",
        ).mockImplementation(deliverBatch);
        // Activation alone keeps wake admission closed until the registry inventory is hydrated.
        await initSubagentRegistry();
        await testing.sweepOnceForTests();
        await vi.waitFor(() => expect(deliverBatch).toHaveBeenCalledOnce());
        await expect(deliverBatch.mock.results[0]?.value).resolves.toBe(true);
        expect(subagentRuns.get(child.runId)?.requesterSettleWake).toBeUndefined();
      }
    }
    if (scenario === "provider timeout") {
      await lifecycle(parentRunId, now, {
        phase: "error",
        stopReason: "timeout",
        timeoutPhase: "provider",
        endedAt: now,
        error: "provider deadline",
      });
    }
    if (legacy) {
      const nativeChild = loadSubagentRegistryFromSqlite().get(child.runId);
      expect(nativeChild?.requesterSettleWake).toMatchObject({
        requesterYieldBatch: true,
        batchRunIds: [child.runId],
      });
      for (const message of [
        { role: "user", content: "Finish the original task after the child returns." },
        { role: "toolResult", content: "The child is working." },
      ]) {
        await appendTranscriptMessage(
          {
            agentId: parentAgentId,
            sessionKey: parentKey,
            sessionId: before.sessionId,
            storePath: parentStorePath,
          },
          { cwd: fixture.stateDir, message },
        );
      }
      // The old writer persisted running for both turns; only a new start cleared yielded timing.
      runOpenClawAgentWriteTransaction(
        (database) => {
          database.db
            .prepare(
              "UPDATE session_nodes SET entry_json = json_set(json_remove(entry_json, '$.restartRecoveryRuns'), '$.status', 'running') WHERE session_key = ?",
            )
            .run(parentKey);
          markCanonicalSessionValidationPending(database, [parentKey]);
        },
        { agentId: parentAgentId },
      );
      await closeOpenClawAgentDatabasesAsync(fixture.stateDir);
      await prepareGatewayStartupSessions({
        cfg: getRuntimeConfig(),
        log: { info: vi.fn(), warn: vi.fn() },
      });
    }
    rotateAgentEventLifecycleGeneration();
    const result = await markStartupOrphanedMainSessionsForRecovery({
      cfg: getRuntimeConfig(),
      stateDir: fixture.stateDir,
      activeSessionIds: [],
      activeSessionKeys: [],
    });
    if (legacy) {
      const { settlement, dispatch, runtime } = recoveryFixture();
      try {
        expect(
          await recoverRestartAbortedMainSessions({
            cfg: getRuntimeConfig(),
            stateDir: fixture.stateDir,
            gatewayRuntime: runtime,
          }),
        ).toMatchObject({ started: newForeground ? 1 : 0, failed: 0 });
        expect(dispatch).toHaveBeenCalledTimes(newForeground ? 1 : 0);
      } finally {
        settlement.resolve();
      }
      return;
    }
    const shouldMark =
      newForeground ||
      scenario === "pending final" ||
      scenario === "settled batch" ||
      scenario === "unrelated agent";
    expect(result.marked).toBe(shouldMark ? 1 : 0);
    const after = loadSessionEntryReadOnly({ storePath: parentStorePath, sessionKey: parentKey });
    expect(after?.abortedLastRun === true).toBe(
      shouldMark || scenario === "marked pending final" || scenario === "reserved waiting cycle",
    );
    expect(after?.status).toBe(
      scenario === "provider timeout" ? "timeout" : newForeground ? "interrupted" : undefined,
    );
    if (scenario === "already marked") {
      expect(after?.mainRestartRecovery).toBeUndefined();
      expect(after?.restartRecoveryRuns).toBeUndefined();
      expect(after?.endedAt).toBe(before.endedAt);
    }
    if (scenario === "pending final" || scenario === "marked pending final") {
      expect(after?.pendingFinalDelivery).toEqual(before.pendingFinalDelivery);
      expect(after?.mainRestartRecovery).toBeDefined();
    }
    if (scenario === "reserved waiting cycle") {
      expect(after?.mainRestartRecovery?.reservation).toEqual(
        before.mainRestartRecovery?.reservation,
      );
    }
    const currentChild = subagentRuns.get(child.runId);
    expect(currentChild).toBeDefined();
    expect(currentChild?.requesterTurnRunId).toBeUndefined();
    expect(currentChild?.requesterSettleWake?.requesterYieldBatch).toBe(
      scenario === "settled batch" ? undefined : true,
    );
  });

  it.each([1, 2])(
    "settles %i interrupted children and wakes their yielded parent without redispatch",
    async (childCount) => {
      const now = Date.now();
      const requesterSessionKey = "agent:main:main";
      const requesterTurnRunId = "yielded-parent-turn";
      const children: SubagentRunRecord[] = [];
      for (let index = 0; index < childCount; index += 1) {
        const child = makeRunRecord({
          runId: `yielded-child-${index}`,
          childSessionKey: `agent:main:subagent:yielded-child-${index}`,
          childSessionIdentity: {
            sessionId: `yielded-child-session-${index}`,
            lifecycleRevision: "original-child-revision",
          },
          requesterSessionKey,
          requesterTurnRunId,
          requesterTurnYielded: true,
          expectsCompletionMessage: true,
          createdAt: now - 60_000,
          startedAt: now - 55_000,
        });
        const storePath = await writeSession({
          sessionKey: child.childSessionKey,
          updatedAt: now,
          abortedLastRun: true,
          defaultSessionId: `yielded-child-session-${index}`,
          lifecycleRevision: "original-child-revision",
        });
        await appendTranscriptMessage(
          {
            storePath,
            sessionKey: child.childSessionKey,
            sessionId: `yielded-child-session-${index}`,
          },
          {
            message: {
              role: "assistant",
              content: `Step ${index} saved before restart`,
              timestamp: now,
            },
          },
        );
        await prepareSubagentRecoveryFixture(child, { stateDir: fixture.stateDir });
        await addSubagentRunForTests(child);
        children.push(child);
      }
      expect(
        await settleRequesterTurnAfterSessionSpawns({
          requesterSessionKey,
          requesterTurnRunId,
          requesterYielded: true,
          acceptedSessionSpawns: children.map((child) => ({
            runId: child.runId,
            childSessionKey: child.childSessionKey,
          })),
          runs: subagentRuns,
          transfer: createRequesterInitialTransferFixture(subagentRuns),
          schedule: vi.fn(),
        }),
      ).toBe(true);
      await resetSubagentRegistryForTests({ persist: false });
      rotateAgentEventLifecycleGeneration();
      const wakeRequester = vi.fn<typeof maybeWakeRequesterAfterAllChildrenSettled>(
        async () => false,
      );
      vi.spyOn(
        await import("../announce/subagent-announce.requester-settle-wake.js"),
        "maybeWakeRequesterAfterAllChildrenSettled",
      ).mockImplementation(wakeRequester);
      await initSubagentRegistry();
      await activateGatewayRuntime();
      await testing.sweepOnceForTests();
      await vi.waitFor(() => expect(wakeRequester).toHaveBeenCalled());
      expect(dispatchAgent).not.toHaveBeenCalled();
      const persisted = loadSubagentRegistryFromSqlite();
      for (const child of children) {
        expect(persisted.get(child.runId)).toMatchObject({
          childSessionKey: child.childSessionKey,
          execution: {
            status: "terminal",
            interruptionReason: "gateway-restart",
            outcome: { status: "error", error: expect.stringContaining("Gateway restart") },
          },
          requesterSettleWake: { requesterYieldBatch: true },
        });
        expect((await getSubagentRunByChildSessionKey(child.childSessionKey))?.runId).toBe(
          child.runId,
        );
        const recoveredSession = loadSessionEntryReadOnly({
          agentId: "main",
          sessionKey: child.childSessionKey,
        });
        expect(recoveredSession).toMatchObject({
          status: "interrupted",
          abortedLastRun: true,
          lastRunError: "Run interrupted by a Gateway restart.",
        });
        expect(
          await loadTranscriptEvents({
            agentId: "main",
            sessionKey: child.childSessionKey,
            sessionId: loadSessionEntryReadOnly({
              agentId: "main",
              sessionKey: child.childSessionKey,
            })!.sessionId,
          }),
        ).toContainEqual(
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              content: expect.stringContaining("saved before restart"),
            }),
          }),
        );
      }
    },
  );
  it.each(["newer task generation", "superseded cancellation", "all-superseded turn"] as const)(
    "recovers interrupted children with %s",
    async (supersededBy) => {
      const allSuperseded = supersededBy === "all-superseded turn";
      const requesterYielded = supersededBy === "newer task generation";
      const now = Date.now();
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const requesterSessionKey = "agent:main:dashboard:restart-parent";
      const requesterTurnRunId = "restart-parent-run";
      const staleRequesterTurnRunId = allSuperseded ? "retired-parent-run" : requesterTurnRunId;
      const stale = makeRunRecord({
        runId: "stale-child-run",
        childSessionKey: "agent:main:subagent:restart-child",
        childSessionIdentity: {
          sessionId: "restart-child-run-session",
          lifecycleRevision: "original-child-revision",
        },
        requesterSessionKey,
        requesterTurnRunId: staleRequesterTurnRunId,
        expectsCompletionMessage: true,
        createdAt: now - 3_000,
        generation: 1,
        execution: { status: "running", startedAt: now - 3_000, lifecycleGeneration },
        ...(supersededBy === "superseded cancellation"
          ? { killReconciliation: { killedAt: now - 2_000, supersededAt: now - 1_000 } }
          : {}),
      });
      const child = makeRunRecord({
        runId: "restart-child-run",
        taskRunId: supersededBy !== "superseded cancellation" ? stale.runId : undefined,
        childSessionKey: stale.childSessionKey,
        childSessionIdentity: {
          sessionId: "restart-child-run-session",
          lifecycleRevision: "original-child-revision",
        },
        requesterSessionKey,
        requesterTurnRunId,
        requesterTurnYielded: requesterYielded || undefined,
        expectsCompletionMessage: true,
        generation: 2,
        createdAt: now - 2_000,
        execution: { status: "running", startedAt: now - 2_000, lifecycleGeneration },
      });
      const sibling = makeRunRecord({
        runId: "restart-sibling-run",
        childSessionKey: "agent:main:subagent:restart-sibling",
        childSessionIdentity: {
          sessionId: "restart-sibling-run-session",
          lifecycleRevision: "original-child-revision",
        },
        requesterSessionKey,
        requesterTurnRunId,
        requesterTurnYielded: requesterYielded || undefined,
        expectsCompletionMessage: true,
        execution: { status: "running", startedAt: now - 1_000, lifecycleGeneration },
      });
      const nested = makeRunRecord({
        runId: "restart-nested-run",
        childSessionKey: "agent:main:subagent:restart-nested",
        childSessionIdentity: {
          sessionId: "restart-nested-run-session",
          lifecycleRevision: "original-child-revision",
        },
        requesterSessionKey: child.childSessionKey,
        requesterTurnRunId: child.runId,
        expectsCompletionMessage: true,
        execution: { status: "running", startedAt: now - 1_000, lifecycleGeneration },
      });
      const interrupted = [child, sibling, nested];
      // Original order: children abort, the main requester is marked, then a new Gateway activates.
      for (const entry of interrupted) {
        const storePath = await writeSession({
          sessionKey: entry.childSessionKey,
          defaultSessionId: `${entry.runId}-session`,
          lifecycleRevision: "original-child-revision",
          abortedLastRun: true,
        });
        await replaceSessionEntry(
          { storePath, sessionKey: entry.childSessionKey },
          {
            ...loadSessionEntryReadOnly({ storePath, sessionKey: entry.childSessionKey })!,
            activeWriterRunId: entry.runId,
            lifecycleRunId: entry.runId,
          },
        );
      }
      const storePath = await writeSession({
        sessionKey: requesterSessionKey,
        defaultSessionId: "restart-parent-session",
      });
      const parent = loadSessionEntryReadOnly({ storePath, sessionKey: requesterSessionKey })!;
      transitionMainSessionRecovery(parent, {
        kind: "mark_interrupted",
        cycleId: "restart-cycle",
        now,
        runs: [{ runId: requesterTurnRunId, lifecycleGeneration }],
      });
      await replaceSessionEntry({ storePath, sessionKey: requesterSessionKey }, parent);
      saveSubagentRegistryToSqlite(
        new Map([stale, ...interrupted].map((entry) => [entry.runId, entry])),
      );
      await resetSubagentRegistryForTests({ persist: false });
      rotateAgentEventLifecycleGeneration();
      await initSubagentRegistry();

      const settleRequester = allSuperseded
        ? vi.spyOn(
            await import("./subagent-registry-requester-yield.js"),
            "settleRequesterTurnAfterSessionSpawns",
          )
        : undefined;
      await fixture.activateGatewayRuntime();
      if (settleRequester) {
        expect(settleRequester).not.toHaveBeenCalledWith(
          expect.objectContaining({ requesterTurnRunId: staleRequesterTurnRunId }),
        );
      }
      const activated = loadSubagentRegistryFromSqlite();
      expect(activated.has(stale.runId)).toBe(false);
      for (const entry of [child, sibling]) {
        if (requesterYielded) {
          expect(activated.get(entry.runId)?.requesterSettleWake).toMatchObject({
            requesterYieldBatch: true,
            yieldedFinalDeliverable: true,
            batchRunIds: [child.runId, sibling.runId],
          });
        } else {
          expect(activated.get(entry.runId)?.requesterSettleWake?.requesterYieldBatch).not.toBe(
            true,
          );
        }
      }
      await fixture.settle();

      const persisted = loadSubagentRegistryFromSqlite();
      for (const entry of interrupted) {
        expect(persisted.get(entry.runId)).toMatchObject({
          execution: { status: "terminal", interruptionReason: "gateway-restart" },
        });
        expect(persisted.get(entry.runId)?.requesterTurnRunId).toBeUndefined();
        expect(
          loadSessionEntryReadOnly({ storePath, sessionKey: entry.childSessionKey }),
        ).toMatchObject({ status: "interrupted" });
      }
      expect(fixture.dispatchAgent).not.toHaveBeenCalled();
      expect(loadSessionEntryReadOnly({ storePath, sessionKey: requesterSessionKey })).toEqual(
        parent,
      );
    },
  );
});
