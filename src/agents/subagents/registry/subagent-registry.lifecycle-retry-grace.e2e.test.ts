// Lifecycle retry-grace e2e tests cover completion delivery retry behavior when
// lifecycle events race gateway waits or transient announce failures.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import "../spawn/subagent-spawn-model.mocks.shared.js";
import { maybeSpawnVisibleSession } from "../../tools/sessions-spawn-visible.js";
import { createSessionsYieldTool } from "../../tools/sessions-yield-tool.js";
import { testing as subagentAnnounceDeliveryTesting } from "../announce/subagent-announce-delivery.test-support.js";
import { testing as subagentAnnounceOutputTesting } from "../announce/subagent-announce-output.test-support.js";
import { announceTesting as subagentAnnounceTesting } from "../announce/subagent-announce-overrides.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import {
  getAgentResultsForChildSession,
  type LifecycleData,
  type LifecycleEvent,
  type SessionStoreEntry,
  type GatewayRequest,
} from "./subagent-registry.lifecycle-fixture.test-support.js";
import { createLifecycleWaits } from "./subagent-registry.lifecycle-waits.test-support.js";
import * as mod from "./subagent-registry.test-helpers.js";

const noop = () => {};
const MAIN_REQUESTER_SESSION_KEY = "agent:main:main";

let lifecycleHandler: ((evt: LifecycleEvent) => void) | undefined;
let agentCallPlan: Array<"ok" | "throw"> = [];
let agentCallGates = new Map<string, Promise<void>>();
let releaseAgentCallGate: (() => void) | undefined;
let chatHistoryBySessionKey = new Map<string, Array<Record<string, unknown>>>();
let transcriptEventsBySessionKey = new Map<string, unknown[]>();
let sessionStore: Record<string, SessionStoreEntry> = {};
let sessionStorePath: string;

const callGatewayMock = vi.fn(async (request: GatewayRequest) => {
  const method = request.method;
  if (method === "agent.wait") {
    // Keep wait unresolved from the RPC path so lifecycle fallback logic is exercised.
    return { status: "pending" };
  }
  if (method === "chat.history") {
    const sessionKey = request.params?.sessionKey ?? "";
    return {
      messages: chatHistoryBySessionKey.get(sessionKey) ?? [],
    };
  }
  if (method === "agent") {
    const sourceSessionKey = request.params?.inputProvenance?.sourceSessionKey;
    const gate = sourceSessionKey ? agentCallGates.get(sourceSessionKey) : undefined;
    if (gate) {
      await gate;
    }
    const next = agentCallPlan.shift() ?? "ok";
    if (next === "throw") {
      throw new Error("announce delivery failed");
    }
    return {
      result: {
        payloads: [{ text: "completion delivered" }],
        deliveryStatus: { status: "sent", resultCount: 1 },
      },
    };
  }
  return {};
});
const onAgentEventMock = vi.fn((handler: typeof lifecycleHandler) => {
  lifecycleHandler = handler;
  return noop;
});
const loadConfigMock = vi.fn(() => ({
  agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
  session: { mainKey: "main", scope: "per-sender" },
}));
vi.mock("../../../config/sessions.js", async () => ({
  ...(await import("../../../config/sessions/targets.js")),
  ...(await import("../../../config/sessions/main-session.js")),
  loadSessionStore: vi.fn(() => sessionStore),
  resolveAgentIdFromSessionKey: (key: string) => key.match(/^agent:([^:]+)/)?.[1] ?? "main",
  resolveSessionStorePathCore: () => sessionStorePath,
  resolveMainSessionKey: () => "agent:main:main",
  updateSessionStore: vi.fn(),
}));

// The sqlite session accessor bypasses loadSessionStore, so serve session
// entries (requester lookups included) from the same in-memory fixture.
vi.mock("../../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config/sessions/session-accessor.js")>()),
  loadSessionEntry: (scope: { sessionKey: string }) => sessionStore[scope.sessionKey],
  listSessionEntriesReadOnly: () =>
    Object.entries(sessionStore).map(([sessionKey, entry]) => ({ sessionKey, entry })),
}));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));

vi.mock("../spawn/subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
}));

describe("subagent registry lifecycle error grace", () => {
  let previousFastTestEnv: string | undefined;
  let testState: OpenClawTestState;

  beforeEach(async () => {
    testState = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
    sessionStorePath = testState.statePath("agents", "main", "sessions", "sessions.json");
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_TEST_FAST = "1";
    callGatewayMock.mockClear();
    onAgentEventMock.mockClear();
    loadConfigMock.mockClear().mockReturnValue({
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
      session: { mainKey: "main", scope: "per-sender" },
    });
    agentCallPlan = [];
    agentCallGates = new Map();
    chatHistoryBySessionKey = new Map();
    transcriptEventsBySessionKey = new Map();
    sessionStore = new Proxy<Record<string, SessionStoreEntry>>(
      {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: 1,
          delivery: {
            kind: "external",
            route: { channel: "discord", accountId: "default", target: { to: "user-1" } },
            context: { channel: "discord", to: "user-1", accountId: "default" },
            origin: { provider: "discord", to: "user-1", accountId: "default" },
          },
        },
      },
      {
        get(target, prop, receiver) {
          if (typeof prop !== "string" || prop in target) {
            return Reflect.get(target, prop, receiver);
          }
          return {
            sessionId: `sess-${prop.replace(/[^a-z0-9]+/gi, "-")}`,
            updatedAt: 1,
          };
        },
      },
    );
    await replaceSessionEntry(
      { storePath: sessionStorePath, sessionKey: MAIN_REQUESTER_SESSION_KEY },
      sessionStore[MAIN_REQUESTER_SESSION_KEY]!,
    );
    vi.useFakeTimers();
    mod.testing.setDepsForTest({
      callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
      getRuntimeConfig:
        loadConfigMock as typeof import("../../../config/config.js").getRuntimeConfig,
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      onAgentEvent:
        onAgentEventMock as unknown as typeof import("../../../infra/agent-events.js").onAgentEvent,
    });
    subagentAnnounceTesting.setDepsForTest({
      callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
      getRuntimeConfig:
        loadConfigMock as typeof import("../../../config/config.js").getRuntimeConfig,
    });
    subagentAnnounceDeliveryTesting.setDepsForTest({
      callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
      getRuntimeConfig:
        loadConfigMock as typeof import("../../../config/config.js").getRuntimeConfig,
      loadSessionEntry: ({ sessionKey }) => sessionStore[sessionKey],
      getRequesterSessionActivity: (requesterSessionKey: string) => {
        const entry = sessionStore[requesterSessionKey];
        return {
          sessionId: entry?.sessionId,
          isActive: false,
        };
      },
    });
    subagentAnnounceOutputTesting.setDepsForTest({
      findTranscriptEvent: async ({ sessionKey }, match) => {
        const events = sessionKey ? transcriptEventsBySessionKey.get(sessionKey) : undefined;
        const event = events?.findLast(match);
        return event === undefined ? undefined : { event };
      },
      findSessionTranscriptArchiveEventReadOnly: async () => undefined,
      readSessionMessagesAsync: async ({ sessionKey }) =>
        chatHistoryBySessionKey.get(sessionKey ?? "") ?? [],
      callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
      getRuntimeConfig:
        loadConfigMock as typeof import("../../../config/config.js").getRuntimeConfig,
      readSubagentSessionEntry: (_storePath, sessionKey) => sessionStore[sessionKey],
      resolveAgentIdFromSessionKey: (key) => key?.match(/^agent:([^:]+)/)?.[1] ?? "main",
      resolveSessionStorePathCore: () => sessionStorePath,
    });
  });

  afterEach(async () => {
    // Failed assertions must also release the delivery owned by this test.
    releaseAgentCallGate?.();
    releaseAgentCallGate = undefined;
    await vi.advanceTimersByTimeAsync(0);
    lifecycleHandler = undefined;
    subagentAnnounceDeliveryTesting.setDepsForTest();
    subagentAnnounceOutputTesting.setDepsForTest();
    subagentAnnounceTesting.setDepsForTest();
    mod.testing.setDepsForTest();
    mod.resetSubagentRegistryForTests({ persist: false });
    vi.useRealTimers();
    if (previousFastTestEnv === undefined) {
      delete process.env.OPENCLAW_TEST_FAST;
    } else {
      process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
    }
    await testState.cleanup();
  });

  const {
    flushAsync,
    waitForCleanupHandledFalse,
    waitForDeliveredCleanup,
    waitForFrozenResult,
    waitForFrozenResultText,
  } = createLifecycleWaits(MAIN_REQUESTER_SESSION_KEY);

  const waitForAgentCallCount = async (expectedCount: number) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (getAgentCalls().length >= expectedCount) {
        return;
      }
      await vi.advanceTimersByTimeAsync(100);
      await flushAsync();
      await vi.dynamicImportSettled();
    }
    const pending = mod.listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY).map((run) => ({
      runId: run.runId,
      execution: run.execution,
      delivery: run.delivery,
      requesterSettleWake: run.requesterSettleWake,
    }));
    throw new Error(
      `expected ${expectedCount} agent call(s), got ${getAgentCalls().length}: ${JSON.stringify(pending)}`,
    );
  };

  function registerCompletionRun(
    runId: string,
    childSuffix: string,
    task: string,
    requesterTurnRunId?: string,
    expectsCompletionMessage = true,
  ) {
    mod.registerSubagentRun({
      runId,
      requesterTurnRunId,
      childSessionKey: `agent:main:subagent:${childSuffix}`,
      requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
      requesterAgentId: "main",
      requesterDisplayKey: "main",
      task,
      cleanup: "keep",
      expectsCompletionMessage,
    });
  }

  async function settleYieldedCliTurn(params: {
    requesterTurnRunId: string;
    acceptedSessionSpawns: Array<{
      runId: string;
      childSessionKey: string;
      expectsCompletionMessage?: boolean;
    }>;
  }) {
    const { withLocalSessionPlacementTurnSettlement } =
      await import("../../session-placement-admission.js");
    return await withLocalSessionPlacementTurnSettlement(
      {
        sessionId: "sess-main",
        sessionKey: MAIN_REQUESTER_SESSION_KEY,
        agentId: "main",
        runId: params.requesterTurnRunId,
      },
      async () => ({
        acceptedSessionSpawns: params.acceptedSessionSpawns,
        meta: {
          durationMs: 1,
          yielded: true,
          executionTrace: { runner: "cli", attempts: [], fallbackUsed: false },
        },
      }),
    );
  }

  function emitLifecycleEvent(
    runId: string,
    data: LifecycleData,
    options?: { sessionKey?: string },
  ) {
    lifecycleHandler?.({
      stream: "lifecycle",
      runId,
      sessionKey: options?.sessionKey,
      data,
    });
  }

  function readFirstAnnounceOutcome() {
    return getAgentCalls()[0]?.params?.internalEvents?.[0];
  }

  function setAssistantOutput(sessionKey: string, text: string, runId: string) {
    const message = {
      role: "assistant",
      content: text,
      stopReason: "stop",
      __openclaw: { runId },
    };
    chatHistoryBySessionKey.set(sessionKey, [message]);
    const events = transcriptEventsBySessionKey.get(sessionKey) ?? [];
    events.push({ type: "message", message });
    transcriptEventsBySessionKey.set(sessionKey, events);
  }

  function getAgentCalls() {
    return (callGatewayMock.mock.calls as [GatewayRequest][])
      .map(([request]) => request)
      .filter((request): request is GatewayRequest => request.method === "agent");
  }

  function getRequesterWakeCalls() {
    return getAgentCalls().filter((request) => {
      const idempotencyKey = (request.params as Record<string, unknown> | undefined)
        ?.idempotencyKey;
      return (
        typeof idempotencyKey === "string" &&
        idempotencyKey.startsWith("announce:requester-settle:")
      );
    });
  }

  it("yields an owned visible child and delivers its requester final exactly once", async () => {
    const requesterTurnRunId = "run-requester-visible-yield";
    const runId = "run-visible-yield";
    const childSessionKey = "agent:main:dashboard:visible-yield";
    const spawnResult = await maybeSpawnVisibleSession({
      raw: { visible: true },
      task: "finish visible dashboard work",
      label: "Visible child",
      runtime: "subagent",
      sandbox: "inherit",
      expectsCompletionMessage: true,
      options: {
        agentSessionKey: MAIN_REQUESTER_SESSION_KEY,
        requesterTurnRunId,
        requesterAgentIdOverride: "main",
        config: {
          agents: { list: [{ id: "main" }] },
          session: { mainKey: "main", scope: "per-sender" },
        },
        callGateway: vi.fn(async () => ({
          key: childSessionKey,
          runStarted: true,
          runId,
        })) as never,
        registerRun: mod.registerSubagentRun,
        countActiveRuns: () => 0,
      },
    });
    expect(spawnResult).toMatchObject({ status: "accepted", runId, childSessionKey });
    setAssistantOutput(childSessionKey, "visible dashboard child complete", runId);

    const onYield = vi.fn();
    const yieldTool = createSessionsYieldTool({
      sessionId: "sess-main",
      claimYield: () =>
        mod.markRequesterTurnYielded({
          requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
          requesterAgentId: "main",
          requesterTurnRunId,
        }) > 0,
      onYield,
    });
    const yieldResult = await yieldTool.execute("yield-visible-child", {
      message: "Wait for the visible dashboard child",
    });
    expect(yieldResult.details).toEqual({
      status: "yielded",
    });
    expect(onYield).toHaveBeenCalledOnce();
    expect(onYield).toHaveBeenCalledWith("Wait for the visible dashboard child", undefined);

    await settleYieldedCliTurn({
      requesterTurnRunId,
      acceptedSessionSpawns: [{ runId, childSessionKey, expectsCompletionMessage: true }],
    });
    const settled = mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((run) => run.runId === runId);
    expect(settled?.execution.status).toBe("running");
    expect(settled?.requesterTurnRunId).toBeUndefined();
    expect(settled?.requesterTurnYielded).toBeUndefined();
    expect(settled?.requesterSettleWake).toMatchObject({
      status: "pending",
      batchRunIds: [runId],
      requesterYieldBatch: true,
    });
    expect(settled?.delivery?.lastError).not.toBe("completion_handoff_pending");
    expect(getAgentCalls()).toHaveLength(0);

    const endedAt = Date.now();
    const terminalResult = {
      phase: "end",
      endedAt,
      terminalReply: {
        disposition: "visible" as const,
        text: "visible dashboard child complete",
      },
    };
    emitLifecycleEvent(runId, terminalResult, { sessionKey: childSessionKey });
    await waitForAgentCallCount(1);
    await waitForDeliveredCleanup(runId);
    expect(getAgentCalls()).toHaveLength(1);
    expect(getRequesterWakeCalls()).toHaveLength(1);
    expect(getRequesterWakeCalls()[0]?.params).toMatchObject({
      sessionKey: MAIN_REQUESTER_SESSION_KEY,
      message: expect.stringContaining("visible final answer"),
    });

    emitLifecycleEvent(runId, terminalResult, { sessionKey: childSessionKey });
    await vi.advanceTimersByTimeAsync(30_000);
    await flushAsync();
    expect(getAgentCalls()).toHaveLength(1);
    expect(getRequesterWakeCalls()).toHaveLength(1);
  });

  it("does not replay a requester-owned final already delivered before its turn yields", async () => {
    const requesterTurnRunId = "run-requester-already-delivered";
    const runId = "run-completed-before-yield";
    const childSessionKey = "agent:main:subagent:completed-before-yield";
    registerCompletionRun(runId, "completed-before-yield", "finish once", requesterTurnRunId);
    setAssistantOutput(childSessionKey, "child complete", runId);

    emitLifecycleEvent(runId, {
      phase: "end",
      endedAt: Date.now(),
      terminalReply: { disposition: "visible", text: "child complete" },
    });
    await waitForDeliveredCleanup(runId, { allowPendingRequesterSettleWake: true });

    const completed = mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((run) => run.runId === runId);
    expect(completed?.delivery?.requesterVisibleFinal).toEqual({
      requesterTurnRunId,
      batchRunIds: [runId],
    });
    expect(getAgentCalls()).toHaveLength(1);
    expect(
      mod.markRequesterTurnYielded({
        requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
        requesterTurnRunId,
      }),
    ).toBe(1);
    await settleYieldedCliTurn({
      requesterTurnRunId,
      acceptedSessionSpawns: [{ runId, childSessionKey, expectsCompletionMessage: true }],
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await flushAsync();
    expect(getAgentCalls()).toHaveLength(1);
    expect(getRequesterWakeCalls()).toHaveLength(0);
    expect(completed?.delivery?.requesterVisibleFinal).toBeUndefined();
    expect(completed?.requesterSettleWake).toBeUndefined();
  });

  it("lets requester settlement own a yielded batch after sibling deliveries race", async () => {
    const requesterTurnRunId = "run-requester-yield-race";
    const alphaSessionKey = "agent:main:subagent:yield-alpha";
    const betaSessionKey = "agent:main:subagent:yield-beta";
    registerCompletionRun("run-yield-alpha", "yield-alpha", "yield alpha", requesterTurnRunId);
    registerCompletionRun("run-yield-beta", "yield-beta", "yield beta", requesterTurnRunId);
    setAssistantOutput(alphaSessionKey, "alpha complete", "run-yield-alpha");
    setAssistantOutput(betaSessionKey, "beta complete", "run-yield-beta");

    agentCallGates.set(
      betaSessionKey,
      new Promise<void>((resolve) => {
        releaseAgentCallGate = resolve;
      }),
    );

    emitLifecycleEvent("run-yield-alpha", {
      phase: "end",
      endedAt: Date.now(),
      terminalReply: { disposition: "visible", text: "alpha complete" },
    });
    await waitForAgentCallCount(1);
    await waitForDeliveredCleanup("run-yield-alpha", { allowPendingRequesterSettleWake: true });

    emitLifecycleEvent("run-yield-beta", {
      phase: "end",
      endedAt: Date.now() + 1,
      terminalReply: { disposition: "visible", text: "beta complete" },
    });
    await waitForAgentCallCount(2);
    const betaBeforeYield = mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((run) => run.runId === "run-yield-beta");
    if (!betaBeforeYield) {
      throw new Error("expected beta run before requester yield");
    }
    betaBeforeYield.delivery = { ...betaBeforeYield.delivery, status: "in_progress" };

    expect(
      mod.markRequesterTurnYielded({
        requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
        requesterTurnRunId,
      }),
    ).toBe(2);
    await settleYieldedCliTurn({
      requesterTurnRunId,
      acceptedSessionSpawns: [
        {
          runId: "run-yield-alpha",
          childSessionKey: alphaSessionKey,
          expectsCompletionMessage: true,
        },
        {
          runId: "run-yield-beta",
          childSessionKey: betaSessionKey,
          expectsCompletionMessage: true,
        },
      ],
    });

    await waitForDeliveredCleanup("run-yield-alpha");

    const yieldedBatch = mod.listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY);
    expect(
      yieldedBatch.map((run) => ({
        runId: run.runId,
        delivery: run.delivery?.status,
        disposition: run.delivery?.disposition,
        nextAttemptAt: run.requesterSettleWake?.nextAttemptAt,
        rearmGeneration: run.requesterSettleWake?.rearmGeneration,
      })),
    ).toEqual([
      {
        runId: "run-yield-alpha",
        delivery: "delivered",
        disposition: "delivered",
        nextAttemptAt: undefined,
        rearmGeneration: undefined,
      },
      {
        runId: "run-yield-beta",
        delivery: "delivered",
        disposition: "delivered",
        nextAttemptAt: undefined,
        rearmGeneration: undefined,
      },
    ]);
    await waitForAgentCallCount(3);
    expect(getRequesterWakeCalls()).toHaveLength(1);

    agentCallGates.delete(betaSessionKey);
    releaseAgentCallGate?.();
    await waitForDeliveredCleanup("run-yield-alpha");
    await waitForDeliveredCleanup("run-yield-beta");

    expect(getRequesterWakeCalls()).toHaveLength(1);
    const requesterWakeParams = getRequesterWakeCalls()[0]?.params as
      | Record<string, unknown>
      | undefined;
    expect(requesterWakeParams?.idempotencyKey).toContain(":yield-1");
    expect(requesterWakeParams?.message).toContain("visible final answer");
    expect(
      mod
        .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
        .filter((run) => run.runId === "run-yield-alpha" || run.runId === "run-yield-beta")
        .every((run) => run.requesterSettleWake === undefined),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);
    await flushAsync();
    expect(getRequesterWakeCalls()).toHaveLength(1);
  });

  it("keeps a frozen live child asleep until its real registry row becomes terminal", async () => {
    const requesterTurnRunId = "run-requester-live-child";
    const liveChildSessionKey = "agent:main:subagent:frozen-live-child";
    registerCompletionRun(
      "run-frozen-live-child",
      "frozen-live-child",
      "live child",
      requesterTurnRunId,
    );
    setAssistantOutput(liveChildSessionKey, "live child complete", "run-frozen-live-child");

    expect(
      mod.markRequesterTurnYielded({
        requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
        requesterTurnRunId,
      }),
    ).toBe(1);
    expect(
      mod.settleRequesterAfterSessionSpawns({
        requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
        requesterTurnRunId,
        requesterYielded: true,
        acceptedSessionSpawns: [
          { runId: "run-frozen-live-child", childSessionKey: liveChildSessionKey },
        ],
      }),
    ).toBe(true);

    const liveChild = mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((run) => run.runId === "run-frozen-live-child");
    if (!liveChild) {
      throw new Error("expected frozen live child");
    }
    expect(
      await maybeWakeRequesterAfterAllChildrenSettled({
        requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
        settledEntry: liveChild,
        transitionBatch: noop,
        completeBatch: noop,
      }),
    ).toBe(false);
    await flushAsync();

    expect(getRequesterWakeCalls()).toHaveLength(0);
    expect(liveChild.execution.status).toBe("running");

    emitLifecycleEvent("run-frozen-live-child", {
      phase: "end",
      endedAt: Date.now() + 1,
      terminalReply: { disposition: "visible", text: "live child complete" },
    });
    await waitForAgentCallCount(1);
    await waitForDeliveredCleanup("run-frozen-live-child");

    expect(
      mod
        .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
        .find((run) => run.runId === "run-frozen-live-child")?.execution,
    ).toMatchObject({ status: "terminal", endedAt: expect.any(Number) });
    expect(getRequesterWakeCalls()).toHaveLength(1);
  });

  it("ignores transient lifecycle errors when run retries and then ends successfully", async () => {
    const runId = "run-transient-error";
    registerCompletionRun(runId, "transient-error", "transient error test");
    setAssistantOutput("agent:main:subagent:transient-error", "Final answer transient", runId);

    emitLifecycleEvent(runId, {
      phase: "error",
      error: "rate limit",
      endedAt: Date.now(),
    });
    await flushAsync();
    expect(getAgentCalls()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(getAgentCalls()).toHaveLength(0);

    emitLifecycleEvent(runId, { phase: "start", startedAt: Date.now() });
    await flushAsync();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(getAgentCalls()).toHaveLength(0);

    emitLifecycleEvent(runId, {
      phase: "end",
      endedAt: Date.now(),
      terminalReply: { disposition: "visible", text: "Final answer transient" },
    });
    await flushAsync();

    await waitForAgentCallCount(1);
    expect(readFirstAnnounceOutcome()?.status).toBe("ok");
  });

  it("announces error when lifecycle error remains terminal after grace window", async () => {
    registerCompletionRun("run-terminal-error", "terminal-error", "terminal error test");
    setAssistantOutput("agent:main:subagent:terminal-error", "fatal summary", "run-terminal-error");

    emitLifecycleEvent("run-terminal-error", {
      phase: "error",
      error: "fatal failure",
      endedAt: Date.now(),
    });
    await flushAsync();
    expect(getAgentCalls()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(15_000);
    await flushAsync();

    await waitForAgentCallCount(1);
    expect(readFirstAnnounceOutcome()?.status).toBe("error");
    expect(readFirstAnnounceOutcome()?.statusLabel).toContain("fatal failure");
  });

  it("freezes completion result at run termination across deferred announce retries", async () => {
    // Regression guard: late lifecycle noise must never overwrite the frozen completion reply.
    registerCompletionRun("run-freeze", "freeze", "freeze test");
    setAssistantOutput("agent:main:subagent:freeze", "Final answer X", "run-freeze");
    agentCallPlan = ["throw", "ok"];

    const endedAt = Date.now();
    emitLifecycleEvent("run-freeze", {
      phase: "end",
      endedAt,
      terminalReply: { disposition: "visible", text: "Final answer X" },
    });
    await flushAsync();

    await waitForAgentCallCount(1);
    expect(getAgentResultsForChildSession(getAgentCalls(), "agent:main:subagent:freeze")).toEqual([
      "Final answer X",
    ]);

    await waitForCleanupHandledFalse("run-freeze");
    const firstCapturedAt = mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((candidate) => candidate.runId === "run-freeze")?.completion?.capturedAt;

    setAssistantOutput("agent:main:subagent:freeze", "Late reply Y", "run-freeze-late-traffic");
    emitLifecycleEvent(
      "run-freeze-late-traffic",
      { phase: "end", endedAt: endedAt + 50 },
      { sessionKey: "agent:main:subagent:freeze" },
    );
    const refreshed = await waitForFrozenResultText("run-freeze", "Late reply Y");
    expect(refreshed.completion?.resultText).toBe("Late reply Y");
    expect(refreshed.completion?.capturedAt).toBeGreaterThanOrEqual(firstCapturedAt ?? 0);
    expect(refreshed.completion?.terminalReply).toEqual({
      disposition: "visible",
      text: "Final answer X",
    });
    emitLifecycleEvent("run-freeze", {
      phase: "end",
      endedAt: endedAt + 100,
      terminalReply: { disposition: "visible", text: "Final answer X" },
    });
    await flushAsync();

    await waitForAgentCallCount(2);
    expect(getAgentResultsForChildSession(getAgentCalls(), "agent:main:subagent:freeze")).toEqual([
      "Final answer X",
      "Final answer X",
    ]);
  });

  it("retries a corrected same-run final without substituting later session traffic", async () => {
    registerCompletionRun("run-refresh", "refresh", "refresh frozen output test");
    setAssistantOutput(
      "agent:main:subagent:refresh",
      "Both spawned. Waiting for completion events...",
      "run-refresh",
    );
    agentCallPlan = ["throw", "ok"];

    const endedAt = Date.now();
    emitLifecycleEvent("run-refresh", {
      phase: "end",
      endedAt,
      terminalReply: {
        disposition: "visible",
        text: "Both spawned. Waiting for completion events...",
      },
    });
    await flushAsync();

    await waitForAgentCallCount(1);
    expect(getAgentResultsForChildSession(getAgentCalls(), "agent:main:subagent:refresh")).toEqual([
      "Both spawned. Waiting for completion events...",
    ]);

    await waitForCleanupHandledFalse("run-refresh");

    const runBeforeRefresh = expectDefined(
      mod
        .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
        .find((candidate) => candidate.runId === "run-refresh"),
      "Expected the completed run before its corrected receipt",
    );
    const generation = runBeforeRefresh.generation;
    const firstCapturedAt = runBeforeRefresh.completion?.capturedAt ?? 0;

    setAssistantOutput(
      "agent:main:subagent:refresh",
      "All 3 subagents complete. Here's the final summary.",
      "run-refresh",
    );
    setAssistantOutput(
      "agent:main:subagent:refresh",
      "Unrelated later turn",
      "run-refresh-followup-turn",
    );
    emitLifecycleEvent("run-refresh", {
      phase: "end",
      endedAt: endedAt + 300,
      terminalReply: {
        disposition: "visible",
        text: "All 3 subagents complete. Here's the final summary.",
      },
    });
    await flushAsync();

    const runAfterRefresh = await waitForFrozenResultText(
      "run-refresh",
      "All 3 subagents complete. Here's the final summary.",
    );
    expect(runAfterRefresh).toBe(runBeforeRefresh);
    expect(runAfterRefresh).toMatchObject({
      runId: "run-refresh",
      generation,
      childSessionKey: "agent:main:subagent:refresh",
      execution: { status: "terminal" },
      completion: {
        resultText: "All 3 subagents complete. Here's the final summary.",
        terminalReply: {
          disposition: "visible",
          text: "All 3 subagents complete. Here's the final summary.",
        },
      },
    });
    expect(runAfterRefresh.completion?.capturedAt).toBeGreaterThanOrEqual(firstCapturedAt);
    await waitForAgentCallCount(2);
    expect(getAgentResultsForChildSession(getAgentCalls(), "agent:main:subagent:refresh")).toEqual([
      "Both spawned. Waiting for completion events...",
      "All 3 subagents complete. Here's the final summary.",
    ]);
  });

  it("ignores silent follow-up turns when refreshing frozen completion output", async () => {
    registerCompletionRun("run-refresh-silent", "refresh-silent", "refresh silent test");
    setAssistantOutput(
      "agent:main:subagent:refresh-silent",
      "All work complete, final summary",
      "run-refresh-silent",
    );
    agentCallPlan = ["throw", "ok"];

    const endedAt = Date.now();
    emitLifecycleEvent("run-refresh-silent", {
      phase: "end",
      endedAt,
      terminalReply: {
        disposition: "visible",
        text: "All work complete, final summary",
      },
    });
    await flushAsync();
    await waitForCleanupHandledFalse("run-refresh-silent");
    await waitForFrozenResultText("run-refresh-silent", "All work complete, final summary");

    setAssistantOutput(
      "agent:main:subagent:refresh-silent",
      "NO_REPLY",
      "run-refresh-silent-followup-turn",
    );
    emitLifecycleEvent(
      "run-refresh-silent-followup-turn",
      { phase: "end", endedAt: endedAt + 200 },
      { sessionKey: "agent:main:subagent:refresh-silent" },
    );
    await flushAsync();

    const runAfterSilent = mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((candidate) => candidate.runId === "run-refresh-silent");
    expect(runAfterSilent?.completion?.resultText).toBe("All work complete, final summary");

    emitLifecycleEvent("run-refresh-silent", {
      phase: "end",
      endedAt: endedAt + 300,
      terminalReply: {
        disposition: "visible",
        text: "All work complete, final summary",
      },
    });
    await flushAsync();

    await waitForAgentCallCount(2);
    expect(
      getAgentResultsForChildSession(getAgentCalls(), "agent:main:subagent:refresh-silent"),
    ).toEqual(["All work complete, final summary", "All work complete, final summary"]);
  });

  it("regression, captures frozen completion output with 100KB cap and retains it for keep-mode cleanup", async () => {
    registerCompletionRun("run-capped", "capped", "capped result test", undefined, false);
    setAssistantOutput("agent:main:subagent:capped", "x".repeat(120 * 1024), "run-capped");

    emitLifecycleEvent("run-capped", { phase: "end", endedAt: Date.now() });
    await flushAsync();

    const run = await waitForFrozenResult("run-capped", (resultText) =>
      resultText.includes("[truncated: frozen completion output exceeded 100KB"),
    );
    expect(getAgentCalls()).toHaveLength(0);
    expect(run.runId).toBe("run-capped");
    expect(typeof run.completion?.resultText).toBe("string");
    expect(run.completion?.resultText).toContain(
      "[truncated: frozen completion output exceeded 100KB",
    );
    expect(Buffer.byteLength(run.completion?.resultText ?? "", "utf8")).toBeLessThanOrEqual(
      100 * 1024,
    );
    expect(run.completion?.capturedAt).toBeTypeOf("number");
  });

  it("records a bare aborted end event as cancellation after retry grace", async () => {
    registerCompletionRun("run-aborted", "aborted", "aborted test");
    setAssistantOutput(
      "agent:main:subagent:aborted",
      "Partial output before cancellation",
      "run-aborted",
    );

    emitLifecycleEvent("run-aborted", {
      phase: "end",
      aborted: true,
      endedAt: 3_000,
    });
    await flushAsync();

    expect(getAgentCalls()).toHaveLength(0);
    expect(
      mod
        .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
        .find((candidate) => candidate.runId === "run-aborted")?.execution.status,
    ).toBe("running");

    await vi.advanceTimersByTimeAsync(15_000);
    await flushAsync();

    const run = mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((candidate) => candidate.runId === "run-aborted");
    expect(run).toMatchObject({
      endedReason: "subagent-killed",
      execution: { outcome: { status: "error", error: "subagent run terminated" } },
    });
    expect(getAgentCalls()).toHaveLength(0);
  });

  it("announces a provider hard timeout from its canonical lifecycle metadata", async () => {
    registerCompletionRun("run-provider-timeout", "provider-timeout", "provider timeout test");
    setAssistantOutput(
      "agent:main:subagent:provider-timeout",
      "Partial output before provider timeout",
      "run-provider-timeout",
    );

    emitLifecycleEvent("run-provider-timeout", {
      phase: "end",
      aborted: true,
      stopReason: "restart",
      status: "timeout",
      timeoutPhase: "provider",
      providerStarted: true,
      endedAt: Date.now(),
      error: "provider timed out",
    });
    await flushAsync();
    expect(getAgentCalls()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(30_000);
    await flushAsync();
    await waitForAgentCallCount(1);

    expect(readFirstAnnounceOutcome()?.status).toBe("timeout");
    const run = mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((candidate) => candidate.runId === "run-provider-timeout");
    expect(run?.execution.outcome?.status).toBe("timeout");
  });

  it("cancels timeout grace when a successful end event arrives before the grace window expires", async () => {
    registerCompletionRun("run-timeout-cancel", "timeout-cancel", "timeout cancel test");
    setAssistantOutput(
      "agent:main:subagent:timeout-cancel",
      "Final answer after recovery",
      "run-timeout-cancel",
    );

    // Emit a structured timeout terminal (starts timeout grace).
    emitLifecycleEvent("run-timeout-cancel", {
      phase: "end",
      aborted: true,
      status: "timeout",
      timeoutPhase: "provider",
      providerStarted: true,
      endedAt: Date.now(),
    });
    await flushAsync();
    expect(getAgentCalls()).toHaveLength(0);

    // Before the grace window, the run successfully ends (non-aborted)
    emitLifecycleEvent("run-timeout-cancel", {
      phase: "end",
      endedAt: Date.now(),
      terminalReply: { disposition: "visible", text: "Final answer after recovery" },
    });
    await flushAsync();

    await waitForAgentCallCount(1);
    expect(readFirstAnnounceOutcome()?.status).toBe("ok");
    await waitForDeliveredCleanup("run-timeout-cancel");

    // Advance past the original grace window; no timeout completion or
    // requester-settle wake should be emitted after successful delivery.
    await vi.advanceTimersByTimeAsync(30_000);
    await flushAsync();
    const readIdempotencyKey = (request: GatewayRequest) => {
      const key = (request.params as Record<string, unknown> | undefined)?.idempotencyKey;
      return typeof key === "string" ? key : "";
    };
    expect(
      getAgentCalls().filter((request) => readIdempotencyKey(request).startsWith("announce:v1:")),
    ).toHaveLength(1);
    expect(
      getAgentCalls()
        .map(readIdempotencyKey)
        .filter((key) => key.startsWith("announce:requester-settle:")),
    ).toHaveLength(0);
  });

  it("keeps parallel child completion results frozen even when late traffic arrives", async () => {
    // Regression guard: fan-out retries must preserve each child's first frozen result text.
    registerCompletionRun("run-parallel-a", "parallel-a", "parallel a");
    registerCompletionRun("run-parallel-b", "parallel-b", "parallel b");
    setAssistantOutput("agent:main:subagent:parallel-a", "Final answer A", "run-parallel-a");
    setAssistantOutput("agent:main:subagent:parallel-b", "Final answer B", "run-parallel-b");
    agentCallPlan = ["throw", "throw", "ok", "ok"];

    const parallelEndedAt = Date.now();
    emitLifecycleEvent("run-parallel-a", {
      phase: "end",
      endedAt: parallelEndedAt,
      terminalReply: { disposition: "visible", text: "Final answer A" },
    });
    emitLifecycleEvent("run-parallel-b", {
      phase: "end",
      endedAt: parallelEndedAt + 1,
      terminalReply: { disposition: "visible", text: "Final answer B" },
    });
    await flushAsync();

    await waitForAgentCallCount(2);
    await waitForCleanupHandledFalse("run-parallel-a");
    await waitForCleanupHandledFalse("run-parallel-b");

    setAssistantOutput(
      "agent:main:subagent:parallel-a",
      "Late overwrite",
      "run-parallel-a-late-traffic",
    );
    setAssistantOutput(
      "agent:main:subagent:parallel-b",
      "Late overwrite",
      "run-parallel-b-late-traffic",
    );

    emitLifecycleEvent("run-parallel-a", {
      phase: "end",
      endedAt: parallelEndedAt + 100,
      terminalReply: { disposition: "visible", text: "Final answer A" },
    });
    emitLifecycleEvent("run-parallel-b", {
      phase: "end",
      endedAt: parallelEndedAt + 101,
      terminalReply: { disposition: "visible", text: "Final answer B" },
    });
    await flushAsync();

    await waitForAgentCallCount(4);

    expect(
      getAgentResultsForChildSession(getAgentCalls(), "agent:main:subagent:parallel-a"),
    ).toEqual(["Final answer A", "Final answer A"]);
    expect(
      getAgentResultsForChildSession(getAgentCalls(), "agent:main:subagent:parallel-b"),
    ).toEqual(["Final answer B", "Final answer B"]);
  });
});
