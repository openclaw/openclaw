import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  listSessionParticipantsReadOnly,
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveGatewaySessionStoreTargetWithStore } from "../gateway/session-utils-store-lookup.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

const { config, callGatewayMock, readAcpSessionMetaMock, readAcpSessionMetaForEntryMock } =
  vi.hoisted(() => ({
    config: {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        list: [{ id: "main", default: true }, { id: "peer" }],
      },
      tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
    } as OpenClawConfig,
    callGatewayMock: vi.fn(),
    readAcpSessionMetaMock: vi.fn(),
    readAcpSessionMetaForEntryMock: vi.fn(),
  }));
vi.mock("../acp/runtime/session-meta.js", () => ({
  readAcpSessionMeta: (params: unknown) => readAcpSessionMetaMock(params),
  readAcpSessionEntryAsync: async (params: {
    cfg?: OpenClawConfig;
    sessionKey: string;
    agentId?: string;
    assertCurrent?: () => void;
  }) => {
    params.assertCurrent?.();
    const cfg = params.cfg ?? config;
    const target = resolveGatewaySessionStoreTargetWithStore({
      cfg,
      key: params.sessionKey,
      agentId: params.agentId,
      readOnly: true,
      exactRead: true,
    });
    const entry = target.store[target.canonicalKey];
    const acp = await readAcpSessionMetaForEntryMock({
      ...params,
      cfg,
      sessionKey: target.canonicalKey,
      agentId: target.agentId,
      entry,
    });
    params.assertCurrent?.();
    return {
      cfg,
      agentId: target.agentId,
      storePath: target.storePath,
      sessionKey: params.sessionKey,
      storeSessionKey: target.canonicalKey,
      entry,
      acp,
    };
  },
}));
vi.mock("../acp/runtime/session-meta-readonly.js", async () => {
  const { rowToAcpSessionMeta } = await vi.importActual<
    typeof import("../acp/runtime/session-meta-readonly.js")
  >("../acp/runtime/session-meta-readonly.js");
  return {
    rowToAcpSessionMeta,
    readAcpSessionMetaForEntry: (params: unknown) => readAcpSessionMetaForEntryMock(params),
  };
});
vi.mock("../gateway/call.js", () => ({ callGateway: (opts: unknown) => callGatewayMock(opts) }));
vi.mock("../commands/agent.js", () => ({ agentCommandFromIngress: vi.fn() }));
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => config,
  resolveGatewayPort: () => 18789,
}));

import "./test-helpers/fast-openclaw-tools-sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "./embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "./embedded-agent-runner/runs.test-support.js";
import { createRequesterYieldCallback } from "./openclaw-tools.requester-yield.js";
import {
  registerSessionsSendRequesterRetirementTests,
  type GatewayCall,
} from "./openclaw-tools.sessions-send-requester-retirement.test-support.js";
import { observeSessionSendContinuations } from "./openclaw-tools.sessions-timeout.test-support.js";
import { announceTesting } from "./subagents/announce/subagent-announce-overrides.test-support.js";
import * as requesterTransfer from "./subagents/registry/subagent-registry-requester-wake-commit.js";
import { onSubagentRegistryPersisted } from "./subagents/registry/subagent-registry-state.js";
import { observeRootWork } from "./subagents/registry/subagent-registry.browser-cleanup.test-support.js";
import {
  addSubagentRunForTests,
  getSubagentRunByRunId,
  getLatestLiveSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
  settleRequesterAfterSessionSpawns,
} from "./subagents/registry/subagent-registry.test-helpers.js";
import { testing as agentStepTesting } from "./tools/agent-step.test-support.js";
import * as sendDelivery from "./tools/sessions-send-tool.delivery.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const continuations = observeSessionSendContinuations({ trackAllWork: true });
let settleRootWork: ReturnType<typeof observeRootWork>;

async function settleSessionWork() {
  await continuations.settle();
  await settleRootWork(true);
  expect(getActiveGatewayRootWorkCount()).toBe(0);
}

afterAll(() => {
  continuations.restore();
});

type AgentCallParams = {
  extraSystemPrompt?: string;
  inputProvenance?: { sourceSessionKey?: string; sourceRole?: string };
};
const calls: GatewayCall[] = [];
const finalAnnounce = vi.fn(async () => ({
  payloads: [{ text: "ANNOUNCE_SKIP", mediaUrl: null }],
  meta: { durationMs: 1 },
}));
function mockGatewayReply(
  waitResult: Record<string, unknown> = {
    status: "ok",
    terminalReply: { disposition: "visible", text: "Requested result" },
  },
) {
  callGatewayMock.mockImplementation(async (request: GatewayCall) => {
    calls.push(request);
    if (request.method === "agent") {
      return { runId: "coordination-run", status: "accepted" };
    }
    return request.method === "agent.wait" ? waitResult : {};
  });
}
function agentParams(call: GatewayCall): AgentCallParams {
  return (call.params ?? {}) as AgentCallParams;
}
function send(requesterKey: string, targetKey: string, timeoutSeconds = 1) {
  return createSessionsSendTool({
    agentSessionKey: requesterKey,
    config,
    callGateway: callGatewayMock,
  }).execute("coordination", {
    sessionKey: targetKey,
    message: "Return the requested result",
    timeoutSeconds,
  });
}
function expectCoordination(
  result: Awaited<ReturnType<typeof send>>,
  child: boolean,
  requesterChild: boolean,
) {
  expect.soft(result.details).toMatchObject({
    status: "ok",
    reply: "Requested result",
    delivery: { status: child ? "skipped" : "pending" },
  });
  const agentCalls = calls.filter((call) => call.method === "agent");
  expect.soft(agentCalls).toHaveLength(child ? 1 : 6);
  expect
    .soft(agentParams(agentCalls[0] ?? {}).inputProvenance?.sourceRole)
    .toBe(requesterChild ? "subagent" : undefined);
  return agentCalls;
}
async function writeEntry(sessionKey: string, entry: SessionEntry, storePath?: string) {
  const agentId = parseAgentSessionKey(sessionKey)?.agentId;
  if (!agentId) {
    throw new Error(`Expected an agent-scoped fixture key: ${sessionKey}`);
  }
  await replaceSessionEntry(
    {
      agentId,
      sessionKey,
      storePath: storePath ?? resolveSessionStorePathCore(config.session?.store, { agentId }),
    },
    entry,
  );
}

describe("sessions_send child coordination", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    settleRootWork = observeRootWork();
    state = await createOpenClawTestState({ scenario: "minimal" });
    config.session = {
      mainKey: "main",
      scope: "per-sender",
      dmScope: "main",
      store: state.path("configured", "agents", "{agentId}", "sessions", "sessions.json"),
    };
    resetGatewayWorkAdmission();
    callGatewayMock.mockReset();
    calls.length = 0;
    mockGatewayReply();
    finalAnnounce.mockClear();
    readAcpSessionMetaMock.mockReset().mockReturnValue(undefined);
    readAcpSessionMetaForEntryMock
      .mockReset()
      .mockImplementation((params: unknown) => readAcpSessionMetaMock(params));
    setActivePluginRegistry(createSessionConversationTestRegistry());
    await agentStepTesting.setDepsForTest({ agentCommandFromIngress: finalAnnounce });
  });
  afterEach(async () => {
    await settleSessionWork();
    resetGatewayWorkAdmission();
    await agentStepTesting.setDepsForTest();
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  });

  it.each(["before admission", "before receipt", "after completion"] as const)(
    "settles watched steering against its admitted run (%s)",
    async (timing) => {
      const requesterSessionKey = "agent:main:dashboard:steer-requester";
      const childSessionKey = "agent:main:dashboard:steer-child";
      const sessionId = "steer-child";
      const requesterTurnRunId = "steer-requester-turn";
      await writeEntry(requesterSessionKey, { sessionId: "steer-requester", updatedAt: 1 });
      await writeEntry(childSessionKey, {
        sessionId,
        updatedAt: 1,
        spawnedBy: requesterSessionKey,
        spawnDepth: 1,
      });
      resetSubagentRegistryForTests();
      const seed = (runId: string, generation: number) =>
        addSubagentRunForTests({
          runId,
          generation,
          childSessionKey,
          requesterSessionKey,
          requesterAgentId: "main",
          expectsCompletionMessage: true,
          createdAt: Date.now(),
          execution: { status: "running", startedAt: Date.now() },
          completion: { required: true },
          delivery: { status: "pending" },
        });
      seed("steer-A", 1);
      const previous = getLatestLiveSubagentRunByChildSessionKey(childSessionKey)!;
      const queueB = vi.fn(async () => {});
      const handleB = createEmbeddedRunHandle({ runId: "steer-B", queueMessage: queueB });
      const replace = () => {
        previous.execution = { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } };
        seed("steer-B", 2);
        setActiveEmbeddedRun(sessionId, handleB, childSessionKey);
      };
      const queueA = vi.fn(async () => {
        if (timing === "after completion") {
          previous.execution = {
            status: "terminal",
            endedAt: Date.now(),
            outcome: { status: "ok" },
          };
          previous.delivery = { status: "delivered" };
          previous.cleanupCompletedAt = Date.now();
        } else {
          replace();
        }
      });
      const handleA = createEmbeddedRunHandle({ runId: "steer-A", queueMessage: queueA });
      setActiveEmbeddedRun(sessionId, handleA, childSessionKey);
      const deliver = sendDelivery.trySessionsSendActiveRunDelivery;
      const admission = vi
        .spyOn(sendDelivery, "trySessionsSendActiveRunDelivery")
        .mockImplementationOnce((...args) => {
          if (timing === "before admission") {
            replace();
          }
          return deliver(...args);
        });
      try {
        const sent = await createSessionsSendTool({
          agentSessionKey: requesterSessionKey,
          requesterTurnRunId,
          config,
          callGateway: callGatewayMock,
        }).execute("watched-steer", {
          sessionKey: childSessionKey,
          message: "Continue this task",
          mode: "steer",
          watch: true,
        });
        if (timing !== "before admission") {
          expect(sent.details).toMatchObject({
            status: "error",
            sentBeforeError: true,
            error: expect.stringContaining("completion could not be claimed"),
          });
          expect(queueA).toHaveBeenCalledOnce();
          expect(previous.requesterTurnRunId).toBeUndefined();
          expect(queueB).not.toHaveBeenCalled();
          expect(getSubagentRunByRunId("steer-B")?.requesterTurnRunId).toBeUndefined();
          expect(previous.delivery?.status).toBe(
            timing === "after completion" ? "delivered" : "pending",
          );
          return;
        }
        expect(sent.details).toMatchObject({
          status: "accepted",
          targetDisposition: "steered",
          delivery: { status: "pending" },
        });
        expect(queueB).toHaveBeenCalledOnce();
        expect(queueA).not.toHaveBeenCalled();
        expect(getSubagentRunByRunId("steer-B")?.requesterTurnRunId).toBe(requesterTurnRunId);
        expect(previous.requesterTurnRunId).toBeUndefined();
        const yielded = await createSessionsYieldTool({
          sessionId: "steer-requester",
          onYield: () => {},
          claimYield: createRequesterYieldCallback({
            requesterSessionKey,
            requesterAgentId: "main",
            requesterTurnRunId,
          }),
        }).execute("yield-steered", {});
        expect(yielded.details).toEqual({ status: "yielded" });
      } finally {
        admission.mockRestore();
        clearActiveEmbeddedRun(sessionId, handleB, childSessionKey);
        clearActiveEmbeddedRun(sessionId, handleA, childSessionKey);
        resetSubagentRegistryForTests();
      }
    },
  );

  it.each(["acknowledged", "ACK lost"] as const)(
    "claims a queued watched follow-up after the original child wake was consumed (%s)",
    async (acknowledgment) => {
      const requesterSessionKey = "agent:main:dashboard:requester";
      const childSessionKey = "agent:main:dashboard:existing-child";
      const requesterTurnRunId = "followup-requester-turn";
      const runId = "coordination-followup";
      await writeEntry(requesterSessionKey, { sessionId: "requester", updatedAt: 1 });
      await writeEntry(childSessionKey, {
        sessionId: "existing-child",
        updatedAt: 1,
        spawnedBy: requesterSessionKey,
        spawnDepth: 1,
      });
      resetSubagentRegistryForTests();
      addSubagentRunForTests({
        runId: "original-child-run",
        childSessionKey,
        requesterSessionKey,
        requesterAgentId: "main",
        expectsCompletionMessage: true,
        createdAt: 1,
        execution: { status: "terminal", startedAt: 1, endedAt: 2, outcome: { status: "ok" } },
        completion: { required: true, resultText: "Original result" },
        delivery: { status: "delivered" },
        cleanupCompletedAt: 3,
        requesterTurnRunId: undefined,
        requesterSettleWake: undefined,
      });
      let finishChild = () => {};
      const childPending = new Promise<void>((resolve) => {
        finishChild = resolve;
      });
      callGatewayMock.mockImplementation(async (request: GatewayCall) => {
        calls.push(request);
        if (request.method === "agent" && request.params?.sessionKey === childSessionKey) {
          const receipt = { runId, status: "accepted", targetDisposition: "queued" };
          if (acknowledgment === "ACK lost") {
            request.onAccepted?.(receipt);
            throw new Error("accepted but final response lost");
          }
          return receipt;
        }
        if (request.method === "agent.wait" && request.params?.runId === runId) {
          await childPending;
          return {
            runId,
            status: "ok",
            startedAt: Date.now(),
            endedAt: Date.now(),
            terminalReply: { disposition: "visible", text: "Follow-up result" },
          };
        }
        if (request.method === "agent") {
          return {
            result: {
              payloads: [{ text: "Follow-up reached the requester" }],
              deliveryStatus: { status: "sent", resultCount: 1 },
            },
          };
        }
        return {};
      });
      announceTesting.setDepsForTest({ callGateway: callGatewayMock });
      let stopObserving = () => {};
      try {
        const result = await createSessionsSendTool({
          agentSessionKey: requesterSessionKey,
          requesterTurnRunId,
          config,
          callGateway: callGatewayMock,
        }).execute("followup", {
          sessionKey: childSessionKey,
          mode: "followup",
          watch: true,
          timeoutSeconds: 0,
          message: "Return the follow-up result",
        });
        expect(result.details).toMatchObject({
          status: "accepted",
          runId,
          targetDisposition: "queued",
          watched: true,
          delivery: { status: "pending", mode: "announce" },
        });
        const onYield = vi.fn();
        const yielded = await createSessionsYieldTool({
          sessionId: "requester",
          claimYield: createRequesterYieldCallback({
            requesterSessionKey,
            requesterAgentId: "main",
            requesterTurnRunId,
          }),
          onYield,
        }).execute("yield-followup", {});
        expect(yielded.details).toEqual({ status: "yielded" });
        expect(onYield).toHaveBeenCalledOnce();
        expect(
          await settleRequesterAfterSessionSpawns({
            requesterSessionKey,
            requesterAgentId: "main",
            requesterTurnRunId,
            requesterYielded: true,
            acceptedSessionSpawns: [{ runId, childSessionKey, expectsCompletionMessage: true }],
          }),
        ).toBe(true);
        const requesterCalls = () =>
          calls.filter(
            (call) => call.method === "agent" && call.params?.sessionKey === requesterSessionKey,
          );
        expect(requesterCalls()).toHaveLength(0);
        const delivered = new Promise<void>((resolve) => {
          stopObserving = onSubagentRegistryPersisted(() => {
            const child = getSubagentRunByRunId(runId);
            if (child?.delivery?.status === "delivered" && !child.requesterSettleWake) {
              resolve();
            }
          });
        });
        finishChild();
        await delivered;
        await settleSessionWork();
        expect(requesterCalls()).toHaveLength(1);
        expect(requesterCalls()[0]?.params).toMatchObject({
          message: expect.stringContaining("Follow-up result"),
          inputProvenance: { sourceTool: "subagent_settle" },
        });
        emitAgentEvent({
          runId,
          sessionKey: childSessionKey,
          stream: "lifecycle",
          data: {
            phase: "end",
            endedAt: Date.now(),
            terminalReply: { disposition: "visible", text: "Follow-up result" },
          },
        });
        await settleSessionWork();
        expect(requesterCalls()).toHaveLength(1);
      } finally {
        finishChild();
        stopObserving();
        await settleSessionWork();
        resetSubagentRegistryForTests();
        announceTesting.setDepsForTest();
      }
    },
  );

  it("yields two watched followups when the first settles during yield preparation", async () => {
    const requesterSessionKey = "agent:main:dashboard:race-parent";
    const childSessionKey = "agent:main:dashboard:race-child";
    const requesterTurnRunId = "race-parent-turn";
    await writeEntry(requesterSessionKey, { sessionId: "race-parent", updatedAt: 1 });
    await writeEntry(childSessionKey, {
      sessionId: "race-child",
      updatedAt: 1,
      spawnedBy: requesterSessionKey,
      spawnDepth: 1,
    });
    resetSubagentRegistryForTests();
    const replies = [createDeferredCore(), createDeferredCore()];
    const runIds = ["race-followup-1", "race-followup-2"];
    let dispatched = 0;
    callGatewayMock.mockImplementation(async (request: GatewayCall) => {
      calls.push(request);
      if (request.method === "agent" && request.params?.sessionKey === childSessionKey) {
        return { runId: runIds[dispatched++], status: "accepted", targetDisposition: "queued" };
      }
      if (request.method === "agent.wait") {
        const index = runIds.indexOf(String(request.params?.runId));
        if (index >= 0) {
          await replies[index]!.promise;
          return {
            status: "ok",
            startedAt: 10,
            endedAt: 20 + index,
            terminalReply: { disposition: "visible", text: "FOLLOWUP-" + (index + 1) },
          };
        }
      }
      return {
        result: {
          payloads: [{ text: "Both replies reviewed" }],
          deliveryStatus: { status: "sent", resultCount: 1 },
        },
      };
    });
    announceTesting.setDepsForTest({ callGateway: callGatewayMock });
    const enteredPreparation = createDeferredCore();
    const releasePreparation = createDeferredCore();
    const commit = requesterTransfer.commitRequesterInitialTransfer;
    const barrier = vi
      .spyOn(requesterTransfer, "commitRequesterInitialTransfer")
      .mockImplementation((context, params) =>
        commit(context, {
          ...params,
          prepare: async () => {
            await params.prepare?.();
            if (params.kind === "intent") {
              enteredPreparation.resolve();
              await releasePreparation.promise;
            }
          },
        }),
      );
    let stopObserving = () => {};
    try {
      const tool = createSessionsSendTool({
        agentSessionKey: requesterSessionKey,
        requesterTurnRunId,
        config,
        callGateway: callGatewayMock,
      });
      for (const runId of runIds) {
        expect(
          (
            await tool.execute(runId, {
              sessionKey: childSessionKey,
              mode: "followup",
              watch: true,
              timeoutSeconds: 0,
              message: runId,
            })
          ).details,
        ).toMatchObject({ status: "accepted", runId, watched: true });
      }
      const onYield = vi.fn();
      const yielded = createSessionsYieldTool({
        sessionId: "race-parent",
        onYield,
        claimYield: createRequesterYieldCallback({
          requesterSessionKey,
          requesterAgentId: "main",
          requesterTurnRunId,
        }),
      }).execute("yield-raced-followups", {});
      void yielded.catch(() => {});
      await enteredPreparation.promise;
      const settled = createDeferredCore();
      stopObserving = onSubagentRegistryPersisted(() => {
        if (getSubagentRunByRunId(runIds[0]!)?.execution.status === "terminal") {
          settled.resolve();
        }
      });
      replies[0]!.resolve();
      await settled.promise;
      releasePreparation.resolve();
      expect((await yielded).details).toEqual({ status: "yielded" });
      expect(onYield).toHaveBeenCalledOnce();
      expect(
        await settleRequesterAfterSessionSpawns({
          requesterSessionKey,
          requesterAgentId: "main",
          requesterTurnRunId,
          requesterYielded: true,
          acceptedSessionSpawns: runIds.map((runId) => ({
            runId,
            childSessionKey,
            expectsCompletionMessage: true,
          })),
        }),
      ).toBe(true);
      stopObserving();
      const delivered = createDeferredCore();
      stopObserving = onSubagentRegistryPersisted(() => {
        if (
          runIds.every((runId) => {
            const child = getSubagentRunByRunId(runId);
            return child?.delivery?.status === "delivered" && !child.requesterSettleWake;
          })
        ) {
          delivered.resolve();
        }
      });
      replies[1]!.resolve();
      await delivered.promise;
      await settleSessionWork();
      const batches = calls.filter(
        (call) =>
          call.method === "agent" &&
          call.params?.sessionKey === requesterSessionKey &&
          (call.params?.inputProvenance as { sourceTool?: string })?.sourceTool ===
            "subagent_settle",
      );
      expect(batches).toHaveLength(1);
      expect(batches[0]?.params?.message).toEqual(expect.stringContaining("FOLLOWUP-1"));
      expect(batches[0]?.params?.message).toEqual(expect.stringContaining("FOLLOWUP-2"));
    } finally {
      releasePreparation.resolve();
      replies.forEach((reply) => reply.resolve());
      stopObserving();
      barrier.mockRestore();
      await settleSessionWork();
      resetSubagentRegistryForTests();
      announceTesting.setDepsForTest();
    }
  });

  registerSessionsSendRequesterRetirementTests({
    config,
    callGatewayMock,
    calls,
    writeEntry,
    settleSessionWork,
    drainRootWork: () => settleRootWork(true),
  });

  it.each([
    { direction: "requester", child: true },
    { direction: "target", child: false },
  ])(
    "uses the registered alternate store for $direction with child=$child",
    async ({ direction, child }) => {
      const peerKey = "agent:peer:main";
      const alternateKey = child ? "agent:main:dashboard:alternate" : "agent:main:subagent:root";
      const alternate = openOpenClawAgentDatabase({ agentId: "main" });
      const configuredStorePath = resolveSessionStorePathCore(config.session?.store, {
        agentId: "main",
      });
      const alternateScope = {
        agentId: "main",
        sessionKey: alternateKey,
        storePath: alternate.path,
      };
      await writeEntry(peerKey, { sessionId: "peer-session", updatedAt: 1 });
      await writeEntry(
        alternateKey,
        {
          sessionId: "alternate-session",
          updatedAt: 1,
          parentSessionKey: peerKey,
          ...(child ? { spawnedBy: peerKey, spawnDepth: 1 } : { spawnDepth: 0 }),
        },
        alternate.path,
      );
      expect(
        loadSessionEntryReadOnly({ ...alternateScope, storePath: configuredStorePath }),
      ).toBeUndefined();
      const requesterKey = direction === "requester" ? alternateKey : peerKey;
      const targetKey = direction === "target" ? alternateKey : peerKey;
      const result = await send(requesterKey, targetKey);
      await settleSessionWork();
      const agentCalls = expectCoordination(result, child, direction === "requester" && child);
      if (child) {
        expect(result.details).toMatchObject({ delivery: { mode: "announce" } });
        expect(agentParams(agentCalls[0] ?? {}).extraSystemPrompt).toBeUndefined();
        expect(finalAnnounce).not.toHaveBeenCalled();
        expect(calls.some((call) => call.method === "send")).toBe(false);
      }
      if (direction === "target") {
        await runOpenClawAgentWriteAdmission(
          toDatabaseOptions(resolveSqliteScope(alternateScope)),
          () => undefined,
        );
        expect
          .soft(listSessionParticipantsReadOnly(alternateScope).get(alternateKey) ?? [])
          .toEqual([
            expect.objectContaining({
              identity: { type: "agent", id: "peer" },
              contributionCount: 1,
            }),
          ]);
        expect
          .soft(
            listSessionParticipantsReadOnly({
              ...alternateScope,
              storePath: configuredStorePath,
            }).get(alternateKey) ?? [],
          )
          .toEqual([]);
      }
    },
  );

  it.each(["requester", "target"])(
    "binds %s ACP coordination to its loaded lifecycle entry",
    async (direction) => {
      const expectedChild = direction === "target";
      const lifecycleRevision = expectedChild ? "current" : "retired";
      const sessionId = "same-session";
      const sessionStartedAt = 50;
      const metadata = await vi.importActual<typeof import("../acp/runtime/session-meta.js")>(
        "../acp/runtime/session-meta.js",
      );
      const metadataRead = await vi.importActual<
        typeof import("../acp/runtime/session-meta-readonly.js")
      >("../acp/runtime/session-meta-readonly.js");
      const databasePath = path.join(
        tempDirs.make("sessions-send-acp-binding-"),
        "openclaw.sqlite",
      );
      const peerKey = "agent:main:main";
      const reusedKey = "agent:main:dashboard:reused-acp";
      const requesterKey = direction === "requester" ? reusedKey : peerKey;
      const targetKey = direction === "target" ? reusedKey : peerKey;
      const currentEntry: SessionEntry = {
        sessionId: "same-session",
        lifecycleRevision: "current",
        sessionStartedAt,
        updatedAt: 200,
        parentSessionKey: peerKey,
      };
      metadata.writeAcpSessionMetaForMigration({
        databasePath,
        sessionKey: reusedKey,
        sessionId,
        lifecycleRevision,
        now: () => 100,
        meta: {
          backend: "acpx",
          agent: "main",
          runtimeSessionName: "previous-acp",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 100,
        },
      });
      // The separate lookup can observe another entry snapshot; classification must
      // join its metadata against the entry already selected by sessions_send.
      readAcpSessionMetaMock.mockImplementation(
        (params: Parameters<typeof metadata.readAcpSessionMeta>[0]) =>
          metadataRead.readAcpSessionMetaForEntry({
            ...params,
            databasePath,
            entry: { sessionId, lifecycleRevision, sessionStartedAt: 50 },
          }),
      );
      readAcpSessionMetaForEntryMock.mockImplementation(
        (params: Parameters<typeof metadataRead.readAcpSessionMetaForEntry>[0]) =>
          metadataRead.readAcpSessionMetaForEntry({ ...params, databasePath }),
      );
      await writeEntry(reusedKey, currentEntry);
      const result = await send(requesterKey, targetKey);
      await settleSessionWork();
      expectCoordination(result, expectedChild, direction === "requester" && expectedChild);
    },
  );

  it.each([
    {
      name: "hidden child with opaque direct token under main DM scope",
      requesterKey: "agent:main:subagent:direct:peer-1",
      targetKey: "agent:peer:main",
      entry: {},
      timeoutSeconds: 0,
    },
    {
      name: "restored child with cyclic lineage",
      requesterKey: "agent:main:dashboard:cycle",
      entry: { spawnedBy: "agent:main:dashboard:cycle" },
      timeoutSeconds: 1,
    },
  ])(
    "sessions_send does not start reply turns for $name after timeoutSeconds=$timeoutSeconds",
    async ({ requesterKey, entry, timeoutSeconds, targetKey = "agent:main:main" }) => {
      await writeEntry(requesterKey, { sessionId: "child", updatedAt: 1, ...entry });
      mockGatewayReply({ status: "timeout" });
      const result = await send(requesterKey, targetKey, timeoutSeconds);
      expect(result.details).toMatchObject({
        status: "accepted",
        delivery: { status: "skipped", mode: "announce" },
      });
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      const agentCalls = calls.filter((call) => call.method === "agent");
      expect(agentCalls).toHaveLength(1);
      expect(agentCalls[0]?.params).toMatchObject({
        sessionKey: targetKey,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: requesterKey,
          sourceTool: "sessions_send",
        },
      });
      expect(agentParams(agentCalls[0] ?? {}).inputProvenance?.sourceRole).toBe("subagent");
      expect(calls.filter((call) => call.method === "agent.wait")).toHaveLength(
        timeoutSeconds === 0 ? 0 : 1,
      );
    },
  );
});
