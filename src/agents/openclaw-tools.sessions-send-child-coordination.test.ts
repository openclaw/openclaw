import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAcpDatabaseSessionKey } from "../acp/runtime/session-meta-keys.js";
import type { OpenClawConfig } from "../config/config.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  listSessionParticipantsReadOnly,
  loadSessionEntryReadOnly,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveGatewaySessionStoreTargetWithStoreAsync } from "../gateway/session-utils-store-lookup.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as requesterTransfer from "./subagents/registry/subagent-registry-requester-yield.js";

const { config, callGatewayMock, readAcpSessionMetaForEntryMock } = vi.hoisted(() => ({
  config: {
    session: { mainKey: "main", scope: "per-sender" },
    agents: {
      entries: { main: {}, peer: {} },
    },
    tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
  } as OpenClawConfig,
  callGatewayMock: vi.fn(),
  readAcpSessionMetaForEntryMock: vi.fn(),
}));
// mock-isolation: Keep ACP database reads controlled by each coordination scenario.
vi.mock("../acp/runtime/session-meta-readonly.js", async () => {
  const { rowToAcpSessionMeta } = await vi.importActual<
    typeof import("../acp/runtime/session-meta-readonly.js")
  >("../acp/runtime/session-meta-readonly.js");
  return {
    rowToAcpSessionMeta,
    readAcpSessionMetaForEntryAsync: async (params: unknown) =>
      readAcpSessionMetaForEntryMock(params),
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
  getActiveGatewayRootWorkHolders,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { clearTestEmbeddedRun as clearActiveEmbeddedRun } from "./embedded-agent-runner/runs.test-support.js";
import { createRequesterYieldCallback } from "./openclaw-tools.requester-yield.js";
import { registerSessionsSendReceiptRetentionTests } from "./openclaw-tools.sessions-send-receipt-retention.test-support.js";
import {
  deliveredRequesterReply,
  endChildRun,
  expectChildCleanupSettled,
  observeSubagentChange,
  seedDeliveredChild,
  childDeliverySettled,
  registerSessionsSendRequesterRetirementTests,
  type GatewayCall,
} from "./openclaw-tools.sessions-send-requester-retirement.test-support.js";
import {
  createDurableSessionsSendTestRun,
  createSessionsSendTestCaller,
  setSessionsSendTestActiveRun,
} from "./openclaw-tools.sessions-steering.test-support.js";
import { announceTesting } from "./subagents/announce/subagent-announce-overrides.test-support.js";
import { mutateSubagentRuns } from "./subagents/registry/subagent-registry-persistence.js";
import { observeRootWork } from "./subagents/registry/subagent-registry.browser-cleanup.test-support.js";
import {
  addSubagentRunForTests,
  getSubagentRunByRunId,
  resetSubagentRegistryForTests,
  settleRequesterAfterSessionSpawns,
} from "./subagents/registry/subagent-registry.test-helpers.js";
import { holdLiveRequesterTurns } from "./subagents/registry/subagent-requester-turn-liveness.test-support.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import * as sendDelivery from "./tools/sessions-send-tool.delivery.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

let settleRootWork: ReturnType<typeof observeRootWork>;

async function settleSessionWork() {
  await settleRootWork(true);
  expect(getActiveGatewayRootWorkCount(), getActiveGatewayRootWorkHolders().join(", ")).toBe(0);
}

async function releaseAndObserve(predicate: () => boolean, release: () => void) {
  const observed = observeSubagentChange(predicate);
  try {
    release();
    await observed.promise;
  } finally {
    observed.stop();
  }
}

async function cleanupFollowup() {
  await settleSessionWork();
  await resetSubagentRegistryForTests();
  announceTesting.setDepsForTest();
}

const calls: GatewayCall[] = [];
function mockGatewayReply(
  waitResult: Record<string, unknown> = {
    status: "ok",
    terminalReply: { disposition: "visible", text: "Requested result" },
  },
) {
  let targetSessionKey: string | undefined;
  callGatewayMock.mockImplementation(async (request: GatewayCall) => {
    calls.push(request);
    if (request.method === "agent") {
      targetSessionKey = String(request.params?.sessionKey);
      return { runId: "coordination-run", status: "accepted" };
    }
    if (request.method === "agent.wait") {
      if (waitResult.status === "ok" && targetSessionKey) {
        await writeFinal(targetSessionKey, "coordination-run", "Requested result");
      }
      return waitResult;
    }
    return {};
  });
}
function sendTool(requesterKey: string, requesterTurnRunId?: string) {
  return createSessionsSendTool({
    agentSessionKey: requesterKey,
    requesterTurnRunId,
    config,
    callGateway: callGatewayMock,
  });
}
function send(requesterKey: string, targetKey: string, timeoutSeconds = 1) {
  return sendTool(requesterKey).execute("coordination", {
    sessionKey: targetKey,
    message: "Return the requested result",
    timeoutSeconds,
  });
}
function yieldTool(
  sessionId: string,
  requesterSessionKey: string,
  requesterTurnRunId: string,
  onYield = () => {},
) {
  return createSessionsYieldTool({
    sessionId,
    onYield,
    claimYield: createRequesterYieldCallback({
      requesterSessionKey,
      requesterAgentId: "main",
      requesterTurnRunId,
    }),
  });
}
function requesterCalls(requesterSessionKey: string) {
  return calls.filter(
    (call) => call.method === "agent" && call.params?.sessionKey === requesterSessionKey,
  );
}
function settlePair(
  requesterSessionKey: string,
  requesterTurnRunId: string,
  childSessionKey: string,
  runIds: string[],
  requesterYielded = true,
) {
  return settleRequesterAfterSessionSpawns({
    requesterSessionKey,
    requesterAgentId: "main",
    requesterTurnRunId,
    requesterYielded,
    acceptedSessionSpawns: runIds.map((runId) => ({
      runId,
      childSessionKey,
      expectsCompletionMessage: requesterYielded,
    })),
  });
}
async function writePair(
  requesterSessionKey: string,
  requesterId: string,
  childSessionKey: string,
  sessionId: string,
) {
  await writeEntry(requesterSessionKey, { sessionId: requesterId, updatedAt: 1 });
  await writeEntry(childSessionKey, {
    sessionId,
    updatedAt: 1,
    spawnedBy: requesterSessionKey,
    spawnDepth: 1,
  });
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

async function writeFinal(sessionKey: string, runId: string, text: string) {
  const target = await resolveGatewaySessionStoreTargetWithStoreAsync({
    cfg: config,
    key: sessionKey,
    readOnly: true,
    exactRead: true,
  });
  const sessionId = target.store[target.canonicalKey]?.sessionId;
  if (!sessionId) {
    throw new Error(`Expected a fixture session for ${sessionKey}`);
  }
  await persistSessionTranscriptTurn(
    {
      agentId: target.agentId,
      storePath: target.storePath,
      sessionKey: target.canonicalKey,
      sessionId,
    },
    {
      config,
      runId,
      expectedSessionId: sessionId,
      touchSessionEntry: false,
      updateMode: "none",
      messages: [
        {
          message: {
            role: "assistant",
            phase: "final_answer",
            stopReason: "stop",
            content: [{ type: "text", text }],
          },
        },
      ],
    },
  );
}

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
  setRuntimeConfigSnapshot(config);
  resetGatewayWorkAdmission();
  callGatewayMock.mockReset();
  calls.length = 0;
  mockGatewayReply();
  readAcpSessionMetaForEntryMock.mockReset().mockReturnValue(undefined);
  setActivePluginRegistry(createSessionConversationTestRegistry());
});
afterEach(async () => {
  await settleSessionWork();
  resetGatewayWorkAdmission();
  await state.cleanup();
});

it.each(["before admission", "before receipt", "after completion"] as const)(
  "settles watched steering against its admitted run (%s)",
  async (timing) => {
    const requesterSessionKey = "agent:main:dashboard:steer-requester";
    const childSessionKey = "agent:main:dashboard:steer-child";
    const sessionId = "steer-child";
    const requesterTurnRunId = "steer-requester-turn";
    await writePair(requesterSessionKey, "steer-requester", childSessionKey, sessionId);
    await resetSubagentRegistryForTests();
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
    await seed("steer-A", 1);
    const previous = () => getSubagentRunByRunId("steer-A")!;
    const { handle: handleB, queueMessage: queueB } = createDurableSessionsSendTestRun("steer-B");
    const completePrevious = async (delivered = false) => {
      await mutateSubagentRuns(["steer-A"], (rows) => {
        const current = rows.get("steer-A");
        if (!current) {
          throw new Error("Expected the admitted steering target");
        }
        const completed: typeof current = {
          ...current,
          execution: { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } },
          ...(delivered
            ? { delivery: { status: "delivered" as const }, cleanupCompletedAt: Date.now() }
            : {}),
        };
        return { value: undefined, postimages: new Map([[current.runId, completed]]) };
      });
    };
    const replace = async () => {
      await completePrevious();
      await seed("steer-B", 2);
      await setSessionsSendTestActiveRun(
        sessionId,
        handleB,
        childSessionKey,
        requesterSessionKey,
        config,
      );
    };
    const { handle: handleA, queueMessage: queueA } = createDurableSessionsSendTestRun(
      "steer-A",
      async () => {
        if (timing === "after completion") {
          await completePrevious(true);
        } else {
          await replace();
        }
      },
    );
    await setSessionsSendTestActiveRun(
      sessionId,
      handleA,
      childSessionKey,
      requesterSessionKey,
      config,
    );
    const deliver = sendDelivery.trySessionsSendActiveRunDelivery;
    const admission = vi
      .spyOn(sendDelivery, "trySessionsSendActiveRunDelivery")
      .mockImplementationOnce(async (...args) => {
        if (timing === "before admission") {
          await replace();
        }
        return deliver(...args);
      });
    try {
      const sent = await withGatewayToolCallerIdentity(
        createSessionsSendTestCaller(requesterSessionKey),
        () =>
          sendTool(requesterSessionKey, requesterTurnRunId).execute("watched-steer", {
            sessionKey: childSessionKey,
            message: "Continue this task",
            mode: "steer",
            watch: true,
          }),
      );
      if (timing !== "before admission") {
        expect(sent.details).toMatchObject({
          status: "error",
          sentBeforeError: true,
          error: expect.stringContaining("completion could not be claimed"),
        });
        expect(queueA).toHaveBeenCalledOnce();
        expect(previous().requesterTurnRunId).toBeUndefined();
        expect(queueB).not.toHaveBeenCalled();
        expect(getSubagentRunByRunId("steer-B")?.requesterTurnRunId).toBeUndefined();
        expect(previous().delivery?.status).toBe(
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
      expect(previous().requesterTurnRunId).toBeUndefined();
      const yielded = await yieldTool(
        "steer-requester",
        requesterSessionKey,
        requesterTurnRunId,
      ).execute("yield-steered", {});
      expect(yielded.details).toEqual({ status: "yielded" });
    } finally {
      admission.mockRestore();
      clearActiveEmbeddedRun(sessionId, handleB, childSessionKey);
      clearActiveEmbeddedRun(sessionId, handleA, childSessionKey);
      await resetSubagentRegistryForTests();
    }
  },
);

describe("child followups", () => {
  const requesterSessionKey = "agent:main:dashboard:requester";
  const childSessionKey = "agent:main:dashboard:existing-child";
  const requesterTurnRunId = "followup-requester-turn";
  const runId = "coordination-followup";
  const terminalReply = { disposition: "visible", text: "Follow-up result" } as const;

  async function setupFollowup(
    wait: (request: GatewayCall) => Promise<unknown>,
    requesterKey = requesterSessionKey,
    loseAck = false,
  ) {
    await writePair(requesterKey, "requester", childSessionKey, "existing-child");
    await resetSubagentRegistryForTests();
    await seedDeliveredChild("original-child-run", childSessionKey, requesterKey);
    callGatewayMock.mockImplementation(async (request: GatewayCall) => {
      calls.push(request);
      if (request.method === "agent" && request.params?.sessionKey === childSessionKey) {
        const receipt = { runId, status: "accepted", targetDisposition: "queued" };
        if (loseAck) {
          request.onAccepted?.(receipt);
          throw new Error("accepted but final response lost");
        }
        return receipt;
      }
      if (request.method === "agent.wait" && request.params?.runId === runId) {
        return wait(request);
      }
      return request.method === "agent" && requesterKey === requesterSessionKey
        ? deliveredRequesterReply("Requester result")
        : {};
    });
    announceTesting.setDepsForTest({ callGateway: callGatewayMock });
  }
  async function completeFollowup() {
    await writeFinal(childSessionKey, runId, terminalReply.text);
    return { runId, status: "ok", startedAt: 1, endedAt: Date.now(), terminalReply };
  }
  function followup(
    timeoutSeconds: number,
    options: { watch?: boolean } = {},
    requesterKey = requesterSessionKey,
  ) {
    return sendTool(requesterKey, requesterTurnRunId).execute("followup", {
      sessionKey: childSessionKey,
      mode: "followup",
      message: "Continue the child task",
      timeoutSeconds,
      ...options,
    });
  }
  it.each([
    { acknowledgment: "acknowledged", watch: undefined, timeoutSeconds: 0, observation: "timeout" },
    { acknowledgment: "ACK lost", watch: true, timeoutSeconds: 0, observation: "timeout" },
    { acknowledgment: "acknowledged", watch: undefined, timeoutSeconds: 1, observation: "timeout" },
    { acknowledgment: "acknowledged", watch: undefined, timeoutSeconds: 1, observation: "yielded" },
    { acknowledgment: "acknowledged", watch: undefined, timeoutSeconds: 1, observation: "pending" },
  ] as const)(
    "delivers a queued child follow-up after its original wake was consumed ($acknowledgment, watch=$watch, timeout=$timeoutSeconds, $observation)",
    async ({ acknowledgment, watch, timeoutSeconds, observation }) => {
      const childPending = createDeferredCore();
      let inlineObserved = false;
      await setupFollowup(
        async (request) => {
          if (!inlineObserved && request.params?.timeoutMs === 1000) {
            inlineObserved = true;
            return observation === "yielded"
              ? { status: "ok", yielded: true }
              : { status: observation };
          }
          await childPending.promise;
          return completeFollowup();
        },
        requesterSessionKey,
        acknowledgment === "ACK lost",
      );
      try {
        const result = await followup(timeoutSeconds, watch === undefined ? {} : { watch });
        expect(result.details).toMatchObject({
          status: "accepted",
          runId,
          targetDisposition: "queued",
          ...(watch ? { watched: true } : {}),
          delivery: { status: "pending" },
        });
        const onYield = vi.fn();
        const yielded = await yieldTool(
          "requester",
          requesterSessionKey,
          requesterTurnRunId,
          onYield,
        ).execute("yield-followup", {});
        expect(yielded.details).toEqual({ status: "yielded" });
        expect(onYield).toHaveBeenCalledOnce();
        expect(
          await settlePair(requesterSessionKey, requesterTurnRunId, childSessionKey, [runId]),
        ).toBe(true);
        expect(requesterCalls(requesterSessionKey)).toHaveLength(0);
        await releaseAndObserve(() => {
          const child = getSubagentRunByRunId(runId);
          return (
            !child ||
            child.delivery?.status === "suspended" ||
            child.delivery?.status === "discarded" ||
            child.delivery?.disposition === "permanent_failure" ||
            ((child.delivery?.status === "delivered" || child.cleanupCompletedAt !== undefined) &&
              !child.requesterSettleWake)
          );
        }, childPending.resolve);
        await settleSessionWork();
        expect(getSubagentRunByRunId(runId)).toMatchObject({ delivery: { status: "delivered" } });
        expect(getSubagentRunByRunId(runId)?.requesterSettleWake).toBeUndefined();
        expect(requesterCalls(requesterSessionKey)).toHaveLength(1);
        expect(requesterCalls(requesterSessionKey)[0]?.params).toMatchObject({
          message: expect.stringContaining(terminalReply.text),
          inputProvenance: { sourceTool: "subagent_settle" },
        });
        emitAgentEvent({
          runId,
          sessionKey: childSessionKey,
          stream: "lifecycle",
          data: {
            phase: "end",
            endedAt: Date.now(),
            terminalReply,
          },
        });
        await settleSessionWork();
        expect(requesterCalls(requesterSessionKey)).toHaveLength(1);
      } finally {
        childPending.resolve();
        await cleanupFollowup();
      }
    },
  );

  it.each(["ok", "error", "timeout"] as const)(
    "consumes an inline child follow-up result without a second requester delivery (%s)",
    async (status) => {
      const result = {
        runId,
        status,
        startedAt: 1,
        ...(status === "ok" ? { terminalReply } : { error: "Child failed" }),
      };
      // The registry's own wait holds no root work while pending; release it only when
      // the test can observe what it settles, never alongside registry teardown.
      const registryWait = createDeferredCore();
      await setupFollowup(async (request) => {
        if (request.params?.timeoutMs !== 1000) {
          await registryWait.promise;
          return { ...result, endedAt: Date.now() };
        }
        if (status === "ok") {
          await writeFinal(childSessionKey, runId, terminalReply.text);
          // The real child ends while its requester still holds the inline claim.
          await endChildRun(runId, childSessionKey, terminalReply);
        }
        return { ...result, endedAt: Date.now() };
      });
      const { handle } = createDurableSessionsSendTestRun(requesterTurnRunId);
      const closeRequester = await setSessionsSendTestActiveRun(
        "requester",
        handle,
        requesterSessionKey,
        undefined,
        config,
      );
      // The fixture requester has no controller operation; model its live inline claim.
      const requesterTurn = holdLiveRequesterTurns(requesterTurnRunId);
      try {
        const sent = await followup(1);
        expect(sent.details).toMatchObject({
          status,
          ...(status === "ok"
            ? { reply: terminalReply.text, delivery: { status: "skipped" } }
            : { error: "Child failed" }),
        });
        expect(getSubagentRunByRunId(runId)).toMatchObject({
          expectsCompletionMessage: false,
          delivery: { status: "delivered" },
        });
        await closeRequester();
        await settlePair(requesterSessionKey, requesterTurnRunId, childSessionKey, [runId], false);
        if (status !== "ok") {
          // Only the registry's wait observes these endings, after the inline result was consumed.
          await releaseAndObserve(
            () => getSubagentRunByRunId(runId)?.cleanupCompletedAt !== undefined,
            registryWait.resolve,
          );
        }
        await settleSessionWork();
        expect(requesterCalls(requesterSessionKey)).toHaveLength(0);
        await expectChildCleanupSettled(runId, requesterSessionKey);
      } finally {
        requesterTurn.restore();
        await closeRequester();
        await settleSessionWork();
        await resetSubagentRegistryForTests();
        // The ok child ended through its lifecycle; its redundant wait now finds no row.
        registryWait.resolve();
        announceTesting.setDepsForTest();
      }
    },
  );

  it("retains quiet restart custody for a cron requester's fresh child follow-up", async () => {
    const cronRequesterKey = "agent:main:cron:job:run:isolated-run";
    const childPending = createDeferredCore();
    await setupFollowup(async () => {
      await childPending.promise;
      return completeFollowup();
    }, cronRequesterKey);
    try {
      const result = await followup(0, {}, cronRequesterKey);
      expect(result.details).toMatchObject({
        status: "accepted",
        delivery: { status: "skipped" },
      });
      expect(getSubagentRunByRunId(runId)).toMatchObject({
        requesterTurnRunId,
        expectsCompletionMessage: false,
        execution: { status: "running" },
      });
      await releaseAndObserve(() => {
        const child = getSubagentRunByRunId(runId);
        return !child || child.cleanupCompletedAt !== undefined;
      }, childPending.resolve);
      await settleSessionWork();
      expect(requesterCalls(cronRequesterKey)).toHaveLength(0);
    } finally {
      childPending.resolve();
      await cleanupFollowup();
    }
  });
});

registerSessionsSendReceiptRetentionTests({
  config,
  callGatewayMock,
  calls,
  writeEntry,
  writeFinal,
  sendTool,
  yieldTool,
  requesterCalls,
  settlePair,
  settleSessionWork,
  releaseAndObserve,
  cleanupFollowup,
});

it("yields two watched followups when the first settles during yield preparation", async () => {
  const requesterSessionKey = "agent:main:dashboard:race-parent";
  const childSessionKey = "agent:main:dashboard:race-child";
  const requesterTurnRunId = "race-parent-turn";
  await writePair(requesterSessionKey, "race-parent", childSessionKey, "race-child");
  await resetSubagentRegistryForTests();
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
        await writeFinal(childSessionKey, runIds[index]!, "FOLLOWUP-" + (index + 1));
        return {
          status: "ok",
          startedAt: 10,
          endedAt: 20 + index,
          terminalReply: { disposition: "visible", text: "FOLLOWUP-" + (index + 1) },
        };
      }
    }
    return deliveredRequesterReply("Both replies reviewed");
  });
  announceTesting.setDepsForTest({ callGateway: callGatewayMock });
  const enteredPreparation = createDeferredCore();
  const releasePreparation = createDeferredCore();
  const commit = requesterTransfer.commitRequesterTransfer;
  const barrier = vi
    .spyOn(requesterTransfer, "commitRequesterTransfer")
    .mockImplementation((params, options) => {
      const prepareYield = params.prepare;
      return commit(
        prepareYield
          ? {
              ...params,
              prepare: async () => {
                await prepareYield();
                enteredPreparation.resolve();
                await releasePreparation.promise;
              },
            }
          : params,
        options,
      );
    });
  try {
    const tool = sendTool(requesterSessionKey, requesterTurnRunId);
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
    const yielded = yieldTool(
      "race-parent",
      requesterSessionKey,
      requesterTurnRunId,
      onYield,
    ).execute("yield-raced-followups", {});
    void yielded.catch(() => {});
    await enteredPreparation.promise;
    await releaseAndObserve(
      () => getSubagentRunByRunId(runIds[0]!)?.execution.status === "terminal",
      replies[0]!.resolve,
    );
    releasePreparation.resolve();
    expect((await yielded).details).toEqual({ status: "yielded" });
    expect(onYield).toHaveBeenCalledOnce();
    expect(await settlePair(requesterSessionKey, requesterTurnRunId, childSessionKey, runIds)).toBe(
      true,
    );
    await releaseAndObserve(() => runIds.every(childDeliverySettled), replies[1]!.resolve);
    await settleSessionWork();
    const batches = calls.filter(
      (call) =>
        call.method === "agent" &&
        call.params?.sessionKey === requesterSessionKey &&
        (call.params?.inputProvenance as { sourceTool?: string })?.sourceTool === "subagent_settle",
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]?.params?.message).toEqual(expect.stringContaining("FOLLOWUP-1"));
    expect(batches[0]?.params?.message).toEqual(expect.stringContaining("FOLLOWUP-2"));
  } finally {
    releasePreparation.resolve();
    replies.forEach((reply) => reply.resolve());
    barrier.mockRestore();
    await cleanupFollowup();
  }
});

registerSessionsSendRequesterRetirementTests({
  config,
  callGatewayMock,
  calls,
  writeEntry,
  writeFinal,
  writePair,
  sendTool,
  yieldTool,
  deliveredReply: deliveredRequesterReply,
  requesterCalls,
  settleSessionWork,
  drainRootWork: () => settleRootWork(true),
});

it.each(["requester", "target"])(
  "uses the registered alternate store for %s",
  async (direction) => {
    const child = direction === "requester";
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
    const result = await send(requesterKey, targetKey, direction === "target" ? 0 : 1);
    await settleSessionWork();
    expect(result.details).toMatchObject(
      child
        ? { status: "ok", reply: "Requested result", delivery: { status: "skipped" } }
        : { status: "accepted", delivery: { status: "pending" } },
    );
    if (direction === "target") {
      await runOpenClawAgentWriteAdmission(
        toDatabaseOptions(resolveSqliteScope(alternateScope)),
        () => undefined,
      );
      expect.soft(listSessionParticipantsReadOnly(alternateScope).get(alternateKey) ?? []).toEqual([
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
    const database = openOpenClawStateDatabase({ env: state.env });
    const databasePath = database.path;
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
      sessionKey: buildAcpDatabaseSessionKey(reusedKey, parseAgentSessionKey(reusedKey)?.agentId),
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
    readAcpSessionMetaForEntryMock.mockImplementation(
      (params: Parameters<typeof metadataRead.readAcpSessionMetaForEntryAsync>[0]) =>
        metadataRead.readAcpSessionMetaForEntryAsync({ ...params, databasePath }),
    );
    await writeEntry(peerKey, { sessionId: "peer-session", updatedAt: 1 });
    await writeEntry(reusedKey, currentEntry);
    const result = await send(requesterKey, targetKey, direction === "target" ? 0 : 1);
    await settleSessionWork();
    if (direction === "target") {
      expect(result.details).toMatchObject({
        status: "accepted",
        delivery: { status: "skipped" },
      });
      const agentCalls = calls.filter((call) => call.method === "agent");
      expect(agentCalls).toEqual([
        expect.objectContaining({ params: expect.objectContaining({ sessionKey: targetKey }) }),
      ]);
      expect(
        calls.filter((call) => call.method === "agent.wait" || call.method === "send"),
      ).toHaveLength(0);
    } else {
      expect(result.details).toMatchObject({
        status: "ok",
        reply: "Requested result",
        delivery: { status: "skipped" },
      });
    }
    // Retire the native handle before state.cleanup removes the fixture directory.
    expect(database.db.isOpen).toBe(true);
    await state.restoreEnv();
    expect(database.db.isOpen).toBe(false);
  },
);

it("does not start reply turns for an opaque child token under main DM scope", async () => {
  const requesterKey = "agent:main:subagent:direct:peer-1";
  const targetKey = "agent:peer:main";
  await writeEntry(requesterKey, { sessionId: "child", updatedAt: 1 });
  await writeEntry(targetKey, { sessionId: "target", updatedAt: 1 });
  mockGatewayReply({ status: "timeout" });
  expect((await send(requesterKey, targetKey, 0)).details).toMatchObject({
    status: "accepted",
    delivery: { status: "skipped" },
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
      sourceRole: "subagent",
    },
  });
  expect(calls.filter((call) => call.method === "agent.wait")).toHaveLength(0);
});

it("rejects cyclic child ancestry before dispatch", async () => {
  const requesterKey = "agent:main:dashboard:cycle";
  await writeEntry(requesterKey, { sessionId: "child", updatedAt: 1, spawnedBy: requesterKey });
  await writeEntry("agent:main:main", { sessionId: "target", updatedAt: 1 });
  mockGatewayReply({ status: "timeout" });
  expect((await send(requesterKey, "agent:main:main", 1)).details).toMatchObject({
    status: "forbidden",
    error: "Session communication ancestry is invalid.",
  });
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  expect(calls.map((call) => call.method)).toEqual(["sessions.resolve"]);
});
