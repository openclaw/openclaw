import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getRuntimeConfig, type OpenClawConfig } from "../../../config/config.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { callGateway } from "../../../gateway/call.js";
import { onAgentEvent } from "../../../infra/agent-events.js";
import * as gatewayWorkAdmission from "../../../process/gateway-work-admission.js";
import { createReplyOperation } from "../../../sessions/session-controller.operation.js";
import { captureSessionTarget } from "../../../sessions/session-controller.target.js";
import { matchesTranscriptEvent } from "../../../sessions/transcript-visible-record.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import "../spawn/subagent-spawn-model.mocks.shared.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import { createSessionsYieldTool } from "../../tools/sessions-yield-tool.js";
import {
  getSubagentRequesterSessionActivity,
  loadRequesterSessionEntry,
} from "../announce/subagent-announce-delivery.runtime.js";
import { testing as deliveryTesting } from "../announce/subagent-announce-delivery.test-support.js";
import { testing as outputTesting } from "../announce/subagent-announce-output.test-support.js";
import { announceTesting } from "../announce/subagent-announce-overrides.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import {
  getAgentResultsForChildSession,
  settleYieldedCliTurn,
  type LifecycleData,
  type SessionStoreEntry,
  type GatewayRequest,
} from "./subagent-registry.lifecycle-fixture.test-support.js";
import {
  createLifecycleAgentCallWaits,
  createLifecycleWaits,
} from "./subagent-registry.lifecycle-waits.test-support.js";
import { createRequesterWakeSessionFixture } from "./subagent-registry.requester-wake-session.test-support.js";
import * as mod from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

const noop = () => {};
const REQUESTER = "agent:main:main";

let lifecycleHandler: Parameters<typeof onAgentEvent>[0] | undefined;
let agentCallPlan: Array<"ok" | "throw"> = [];
let agentCallGates = new Map<string, Promise<void>>();
let releaseAgentCallGate: (() => void) | undefined;
let agentCallWaits: ReturnType<typeof createLifecycleAgentCallWaits>;
let chatHistoryBySessionKey = new Map<string, Array<Record<string, unknown>>>();
let transcriptEventsBySessionKey = new Map<string, unknown[]>();
let sessionStore: Record<string, SessionStoreEntry> = {};
let sessionStorePath: string;
let requesterActive = false;

const callGatewayMock = vi.fn(async (request: GatewayRequest) => {
  const method = request.method;
  if (method === "agent.wait") {
    // Keep wait unresolved from the RPC path so lifecycle fallback logic is exercised.
    return { status: "pending" };
  }
  if (method === "chat.history") {
    const sessionKey = request.params?.sessionKey ?? "";
    return { messages: chatHistoryBySessionKey.get(sessionKey) ?? [] };
  }
  if (method === "agent") {
    agentCallWaits.notifyAgentCall();
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
const onAgentEventMock = vi.mocked(onAgentEvent);
const loadConfigMock = vi.mocked(getRuntimeConfig);

vi.mock("../../../config/config.js", { spy: true });
vi.mock("../../../gateway/call.js", { spy: true });
vi.mock("../../../infra/agent-events.js", { spy: true });
vi.mock("../../runtime-plugins.js", async () => {
  const { createEmptyPluginRegistry } = await import("../../../plugins/registry-empty.js");
  return {
    loadAgentRuntimePluginRegistryHandle: vi.fn<
      typeof import("../../runtime-plugins.js").loadAgentRuntimePluginRegistryHandle
    >(() => createEmptyPluginRegistry()),
  };
});

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

// mock-isolation: Registry fixtures supply requester depth without opening a session database.
vi.mock("../spawn/subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
  getSubagentDepthFromSessionStoreInWorker: async () => 0,
}));

let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
  sessionStorePath = testState.statePath("agents", "main", "sessions", "sessions.json");
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  callGatewayMock.mockClear();
  vi.mocked(callGateway).mockImplementation(callGatewayMock as typeof callGateway);
  vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReset();
  onAgentEventMock.mockClear().mockImplementation((handler) => {
    lifecycleHandler = handler;
    return noop;
  });
  const config: OpenClawConfig = {
    agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
    session: { mainKey: "main", scope: "per-sender" },
  };
  setRuntimeConfigSnapshot(config);
  loadConfigMock.mockClear().mockReturnValue(config);
  requesterActive = false;
  agentCallPlan = [];
  agentCallGates = new Map();
  chatHistoryBySessionKey = new Map();
  transcriptEventsBySessionKey = new Map();
  sessionStore = {
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
  };
  await replaceSessionEntry(
    { storePath: sessionStorePath, sessionKey: REQUESTER },
    sessionStore[REQUESTER]!,
  );
  vi.useFakeTimers();
  agentCallWaits = createLifecycleAgentCallWaits(REQUESTER, () => getAgentCalls().length);
  const gatewayDeps = {
    callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
    getRuntimeConfig: loadConfigMock,
  };
  announceTesting.setDepsForTest(gatewayDeps);
  deliveryTesting.setDepsForTest({
    ...gatewayDeps,
    loadSessionEntry: ({ sessionKey }) => sessionStore[sessionKey],
    getRequesterSessionActivity: (requesterSessionKey, requester) => {
      const entry = sessionStore[requesterSessionKey];
      return {
        sessionId: entry?.sessionId,
        target: captureSessionTarget({
          storeScope: requester.storePath ?? sessionStorePath,
          sessionKey: requester.canonicalKey,
          agentId: requester.agentId,
          incarnation: entry?.sessionId,
        }),
        isActive: requesterActive,
      };
    },
  });
  outputTesting.setDepsForTest({
    ...gatewayDeps,
    findTranscriptEvent: async ({ sessionKey }, match) => {
      const events = sessionKey ? transcriptEventsBySessionKey.get(sessionKey) : undefined;
      const event = events?.findLast((candidate) => matchesTranscriptEvent(candidate, match));
      return event === undefined ? undefined : { event };
    },
    findSessionTranscriptArchiveEventReadOnly: async () => undefined,
    readSessionMessagesAsync: async ({ sessionKey }) =>
      chatHistoryBySessionKey.get(sessionKey ?? "") ?? [],
    readSubagentSessionEntry: (_storePath, sessionKey) => sessionStore[sessionKey],
    resolveSessionStorePathCore: () => sessionStorePath,
  });
});

afterEach(async () => {
  // Failed assertions must also release the delivery owned by this test.
  releaseAgentCallGate?.();
  releaseAgentCallGate = undefined;
  try {
    try {
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      await agentCallWaits.settle();
    }
  } finally {
    lifecycleHandler = undefined;
    deliveryTesting.setDepsForTest();
    outputTesting.setDepsForTest();
    announceTesting.setDepsForTest();
    await mod.resetSubagentRegistryForTests({ persist: false });
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await testState.cleanup();
    clearRuntimeConfigSnapshot();
  }
});

const { flushAsync, waitForRun, waitForDeliveredCleanup, waitForFrozenResultText } =
  createLifecycleWaits(REQUESTER);

const waitForCalls = (count: number) => agentCallWaits.waitForAgentCallCount(count);
async function advanceAndFlush(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await flushAsync();
}

const { prepareChildSession, spawnVisibleChild } = createRequesterWakeSessionFixture({
  requesterSessionKey: REQUESTER,
  getSessionStore: () => sessionStore,
  getSessionStorePath: () => sessionStorePath,
});

async function prepareRun(
  suffix: string,
  text: string,
  requesterTurnRunId?: string,
  expectsCompletionMessage = true,
) {
  const runId = `run-${suffix}`;
  const childSessionKey = `agent:main:subagent:${suffix}`;
  const sessionEntry = await prepareChildSession(childSessionKey, `sess-${runId}`);
  await mod.registerSubagentRun({
    runId,
    requesterTurnRunId,
    childSessionKey,
    sessionEntry,
    childAgentId: "main",
    requesterSessionKey: REQUESTER,
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: suffix,
    cleanup: "keep",
    expectsCompletionMessage,
  });
  setAssistantOutput(childSessionKey, text, runId);
  return { runId, childSessionKey };
}

function emitLifecycleEvent(runId: string, data: LifecycleData, options?: { sessionKey?: string }) {
  lifecycleHandler?.({
    stream: "lifecycle",
    runId,
    seq: 1,
    ts: Date.now(),
    sessionKey: options?.sessionKey,
    data,
  });
}

function endRun(runId: string, text: string, endedAt = Date.now()) {
  emitLifecycleEvent(runId, {
    phase: "end",
    endedAt,
    terminalReply: { disposition: "visible", text },
  });
}

const findRun = (runId: string) =>
  mod.listSubagentRunsForRequester(REQUESTER).find((run) => run.runId === runId);
const resultsFor = (sessionKey: string) =>
  getAgentResultsForChildSession(getAgentCalls(), sessionKey);
const settleYieldedTurn = (
  requesterTurnRunId: string,
  acceptedSessionSpawns: Parameters<typeof settleYieldedCliTurn>[0]["acceptedSessionSpawns"],
) =>
  settleYieldedCliTurn({
    requesterSessionKey: REQUESTER,
    requesterSessionId: "sess-main",
    requesterTurnRunId,
    acceptedSessionSpawns,
  });
const markYielded = (requesterTurnRunId: string) =>
  mod.markRequesterTurnYielded({
    requesterSessionKey: REQUESTER,
    requesterTurnRunId,
  });

const firstOutcome = () => getAgentCalls()[0]?.params?.internalEvents?.[0];

function setAssistantOutput(sessionKey: string, text: string, runId: string) {
  const message = { role: "assistant", content: text, stopReason: "stop", __openclaw: { runId } };
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
  return getAgentCalls().filter((request) =>
    request.params?.idempotencyKey?.startsWith("announce:requester-settle:"),
  );
}

it("delivers a restart interruption once after the requester becomes available", async () => {
  const cleanupAttempts: Promise<unknown>[] = [];
  const cleanupObservation = vi.mocked(gatewayWorkAdmission.runWithGatewayDetachedWorkContinuation);
  const original = expectDefined(
    cleanupObservation.getMockImplementation(),
    "root admission observer",
  );
  cleanupObservation.mockImplementation((run, origin) => {
    const work = original(run, origin);
    if (origin === "subagents:lifecycle-cleanup") {
      cleanupAttempts.push(work);
    }
    return work;
  });
  let operation: ReturnType<typeof createReplyOperation> | undefined;
  try {
    const child = await prepareRun("restart-child", "retained child progress");
    const requester = sessionStore[REQUESTER]!;
    delete sessionStore[REQUESTER];
    expect(
      await mod.finalizeInterruptedSubagentRun({
        runId: child.runId,
        error: "Subagent execution was interrupted by a Gateway restart.",
        endedAt: Date.now(),
      }),
    ).toBe(1);
    await waitForRun(
      child.runId,
      (run) => run.cleanupHandled === false && Boolean(run.delivery?.payload),
    );
    await expectDefined(cleanupAttempts[0], "failed boot cleanup");
    expect(findRun(child.runId)?.delivery?.status).toBe("pending");
    expect(getAgentCalls()).toHaveLength(0);

    sessionStore[REQUESTER] = requester;
    operation = createReplyOperation({
      sessionKey: REQUESTER,
      sessionId: requester.sessionId!,
      resetTriggered: false,
      target: expectDefined(
        getSubagentRequesterSessionActivity(
          REQUESTER,
          await loadRequesterSessionEntry(REQUESTER, "main"),
        ).target,
        "recovered requester target",
      ),
    });
    operation.setPhase("running");
    const received: string[] = [];
    operation.attachBackend({
      kind: "embedded",
      cancel() {},
      supportsTranscriptCommitWait: true,
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        queueMessage: async (text, options, assertCurrent) => {
          assertCurrent();
          received.push(options?.currentInboundContext?.text ?? text);
          options?.onQueueAccepted?.(true);
        },
      },
    });
    requesterActive = true;
    await advanceAndFlush(30_000);
    for (const cleanup of cleanupAttempts) {
      await cleanup;
    }
    expect(findRun(child.runId)?.delivery?.status).toBe("delivered");
    operation.complete();
    requesterActive = false;
    mod.resumeSubagentRun(child.runId);
    await advanceAndFlush(30_000);
    await waitForDeliveredCleanup(child.runId);
    expect(received).toHaveLength(1);
    expect(received[0]).toContain(child.runId);
    expect(getAgentCalls()).toHaveLength(0);
    expect(getRequesterWakeCalls()).toHaveLength(0);
  } finally {
    operation?.complete();
    requesterActive = false;
    cleanupObservation.mockImplementation(original);
  }
});

it("delivers a yielded visible child exactly once", async () => {
  const requesterTurnRunId = "run-requester-visible-yield";
  const runId = "run-visible-yield";
  const childSessionKey = "agent:main:dashboard:visible-yield";
  await spawnVisibleChild({ runId, childSessionKey, requesterTurnRunId });
  expect(findRun(runId)?.childSessionKey).toBe(childSessionKey);
  setAssistantOutput(childSessionKey, "visible dashboard child complete", runId);

  const onYield = vi.fn();
  const yieldTool = createSessionsYieldTool({
    sessionId: "sess-main",
    claimYield: async () =>
      (await mod.markRequesterTurnYielded({
        requesterSessionKey: REQUESTER,
        requesterAgentId: "main",
        requesterTurnRunId,
      })) > 0,
    onYield,
  });
  const yieldResult = await yieldTool.execute("yield-visible-child", {
    message: "Wait for the visible dashboard child",
  });
  expect(yieldResult.details).toEqual({ status: "yielded" });
  expect(onYield).toHaveBeenCalledExactlyOnceWith(
    "Wait for the visible dashboard child",
    undefined,
    undefined,
  );

  await settleYieldedTurn(requesterTurnRunId, [
    { runId, childSessionKey, expectsCompletionMessage: true },
  ]);
  const settled = findRun(runId);
  expect(settled).toMatchObject({
    execution: { status: "running" },
    requesterTurnRunId: undefined,
    requesterTurnYielded: undefined,
    requesterSettleWake: { batchRunIds: [runId], requesterYieldBatch: true },
  });
  expect(settled?.delivery?.lastError).not.toBe("completion_handoff_pending");
  expect(getAgentCalls()).toHaveLength(0);

  const endedAt = Date.now();
  const terminalResult = {
    phase: "end",
    endedAt,
    terminalReply: { disposition: "visible" as const, text: "visible dashboard child complete" },
  };
  emitLifecycleEvent(runId, terminalResult, { sessionKey: childSessionKey });
  await waitForCalls(1);
  await waitForDeliveredCleanup(runId);
  expect(getAgentCalls()).toHaveLength(1);
  expect(getRequesterWakeCalls()).toHaveLength(1);
  expect(getRequesterWakeCalls()[0]?.params).toMatchObject({
    sessionKey: REQUESTER,
    message: expect.stringContaining("visible final answer"),
  });

  emitLifecycleEvent(runId, terminalResult, { sessionKey: childSessionKey });
  await advanceAndFlush(30_000);
  expect(getAgentCalls()).toHaveLength(1);
  expect(getRequesterWakeCalls()).toHaveLength(1);
});

it("does not replay a final delivered before requester yield", async () => {
  const requesterTurnRunId = "run-requester-already-delivered";
  const { runId, childSessionKey } = await prepareRun(
    "completed-before-yield",
    "child complete",
    requesterTurnRunId,
  );

  endRun(runId, "child complete");
  await waitForCalls(1);
  await waitForDeliveredCleanup(runId, { allowPendingRequesterSettleWake: true });

  const completed = findRun(runId);
  expect(completed?.delivery?.requesterVisibleFinal).toEqual({
    requesterTurnRunId,
    batchRunIds: [runId],
  });
  expect(getAgentCalls()).toHaveLength(1);
  expect(await markYielded(requesterTurnRunId)).toBe(1);
  await settleYieldedTurn(requesterTurnRunId, [
    { runId, childSessionKey, expectsCompletionMessage: true },
  ]);

  await advanceAndFlush(30_000);
  expect(getAgentCalls()).toHaveLength(1);
  expect(getRequesterWakeCalls()).toHaveLength(0);
  const settled = mod.getSubagentRunByRunId(runId);
  expect(settled?.delivery?.requesterVisibleFinal).toBeUndefined();
  expect(settled?.requesterSettleWake).toBeUndefined();
});

it("settles a yielded batch after racing sibling deliveries", async () => {
  const requesterTurnRunId = "run-requester-yield-race";
  const { runId, childSessionKey: alphaSessionKey } = await prepareRun(
    "yield-alpha",
    "alpha complete",
    requesterTurnRunId,
  );
  const { childSessionKey: betaSessionKey } = await prepareRun(
    "yield-beta",
    "beta complete",
    requesterTurnRunId,
  );

  agentCallGates.set(
    betaSessionKey,
    new Promise<void>((resolve) => {
      releaseAgentCallGate = resolve;
    }),
  );

  endRun(runId, "alpha complete");
  await waitForCalls(1);
  await waitForDeliveredCleanup(runId, { allowPendingRequesterSettleWake: true });

  endRun("run-yield-beta", "beta complete", Date.now() + 1);
  await waitForCalls(2);
  const betaBeforeYield = expectDefined(findRun("run-yield-beta"), "beta run before yield");
  await mutateSubagentRuns([betaBeforeYield.runId], (rows) => {
    const current = expectDefined(rows.get(betaBeforeYield.runId), "beta delivery owner");
    const postimage = {
      ...current,
      delivery: { ...current.delivery, status: "in_progress" as const },
    };
    return { value: undefined, postimages: new Map([[current.runId, postimage]]) };
  });

  expect(await markYielded(requesterTurnRunId)).toBe(2);
  // The beta completion owns the earlier controller source. Let that turn
  // settle before the later yielded-batch followup can claim the mailbox.
  agentCallGates.delete(betaSessionKey);
  releaseAgentCallGate?.();
  await settleYieldedTurn(requesterTurnRunId, [
    { runId, childSessionKey: alphaSessionKey, expectsCompletionMessage: true },
    { runId: "run-yield-beta", childSessionKey: betaSessionKey, expectsCompletionMessage: true },
  ]);

  await waitForDeliveredCleanup(runId);

  const yieldedBatch = mod.listSubagentRunsForRequester(REQUESTER);
  expect(yieldedBatch.map(({ runId: id }) => id)).toEqual([runId, "run-yield-beta"]);
  for (const entry of yieldedBatch) {
    expect(entry.delivery).toMatchObject({ status: "delivered", disposition: "delivered" });
    expect(entry.requesterSettleWake?.rearmGeneration).toBeUndefined();
  }
  await waitForCalls(3);
  expect(getRequesterWakeCalls()).toHaveLength(1);

  await waitForDeliveredCleanup(runId);
  await waitForDeliveredCleanup("run-yield-beta");

  expect(getRequesterWakeCalls()).toHaveLength(1);
  expect(getRequesterWakeCalls()[0]?.params).toMatchObject({
    idempotencyKey: expect.stringContaining(":yield-1"),
    message: expect.stringContaining("visible final answer"),
  });
  expect(
    mod
      .listSubagentRunsForRequester(REQUESTER)
      .filter((run) => run.runId === runId || run.runId === "run-yield-beta")
      .every((run) => run.requesterSettleWake === undefined),
  ).toBe(true);

  await advanceAndFlush(30_000);
  expect(getRequesterWakeCalls()).toHaveLength(1);
});

it("wakes a frozen live child only after registry completion", async () => {
  const requesterTurnRunId = "run-requester-live-child";
  const { runId, childSessionKey: liveChildSessionKey } = await prepareRun(
    "frozen-live-child",
    "live child complete",
    requesterTurnRunId,
  );

  expect(await markYielded(requesterTurnRunId)).toBe(1);
  expect(
    await mod.settleRequesterAfterSessionSpawns({
      requesterSessionKey: REQUESTER,
      requesterTurnRunId,
      requesterYielded: true,
      acceptedSessionSpawns: [{ runId, childSessionKey: liveChildSessionKey }],
    }),
  ).toBe(true);

  const liveChild = expectDefined(findRun(runId), "live child run");
  expect(
    await maybeWakeRequesterAfterAllChildrenSettled({
      isSourceCurrent: () => true,
      requesterSessionKey: REQUESTER,
      settledEntry: liveChild,
      transitionBatch: () => {
        throw new Error("A live child cannot transition requester delivery");
      },
      completeBatch: noop,
    }),
  ).toBe(false);
  await flushAsync();

  expect(getRequesterWakeCalls()).toHaveLength(0);
  expect(liveChild.execution.status).toBe("running");

  endRun(runId, "live child complete", Date.now() + 1);
  await waitForCalls(1);
  await waitForDeliveredCleanup(runId);

  expect(findRun(runId)?.execution).toMatchObject({
    status: "terminal",
    endedAt: expect.any(Number),
  });
  expect(getRequesterWakeCalls()).toHaveLength(1);
});

it.each(["transient-error", "terminal-error"] as const)(
  "waits for error grace or successful retry: %s",
  async (kind) => {
    const retried = kind === "transient-error";
    const text = retried ? "Final answer transient" : "fatal summary";
    const { runId } = await prepareRun(kind, text);
    emitLifecycleEvent(runId, {
      phase: "error",
      error: retried ? "rate limit" : "fatal failure",
      endedAt: Date.now(),
    });
    await flushAsync();
    expect(getAgentCalls()).toHaveLength(0);
    if (retried) {
      await vi.advanceTimersByTimeAsync(14_999);
      expect(getAgentCalls()).toHaveLength(0);
      const restartedAt = Date.now();
      emitLifecycleEvent(runId, { phase: "start", startedAt: restartedAt });
      await waitForRun(
        runId,
        (run) => run.execution.status === "running" && run.execution.startedAt === restartedAt,
      );
      await vi.advanceTimersByTimeAsync(20_000);
      expect(getAgentCalls()).toHaveLength(0);
      const endedAt = Date.now();
      endRun(runId, text, endedAt);
      await waitForRun(
        runId,
        (run) =>
          run.execution.status === "terminal" &&
          run.execution.endedAt === endedAt &&
          run.execution.outcome?.status === "ok",
      );
    } else {
      await advanceAndFlush(15_000);
    }
    await waitForCalls(1);
    expect(firstOutcome()?.status).toBe(retried ? "ok" : "error");
    if (!retried) {
      expect(firstOutcome()?.statusLabel).toContain("fatal failure");
    }
  },
);

it.each(["corrected same-run final", "silent follow-up"] as const)(
  "retries frozen output without substituting later traffic: %s",
  async (mode) => {
    const corrected = mode === "corrected same-run final";
    const firstText = corrected
      ? "Both spawned. Waiting for completion events..."
      : "All work complete, final summary";
    const resultText = corrected
      ? "All 3 subagents complete. Here's the final summary."
      : firstText;
    const { runId, childSessionKey } = await prepareRun(
      corrected ? "refresh" : "refresh-silent",
      firstText,
    );
    agentCallPlan = ["throw", "ok"];
    const endedAt = Date.now();
    endRun(runId, firstText, endedAt);
    await flushAsync();
    await waitForCalls(1);
    expect(resultsFor(childSessionKey)).toEqual([firstText]);
    await agentCallWaits.waitForCleanupHandledFalse(runId);
    await waitForFrozenResultText(runId, firstText);
    const before = expectDefined(findRun(runId), "frozen completion before refresh");
    const firstCapturedAt = before.completion?.capturedAt ?? 0;

    if (corrected) {
      setAssistantOutput(childSessionKey, resultText, runId);
      setAssistantOutput(childSessionKey, "Unrelated later turn", "run-refresh-followup-turn");
    } else {
      const followupRunId = "run-refresh-silent-followup-turn";
      setAssistantOutput(childSessionKey, "NO_REPLY", followupRunId);
      emitLifecycleEvent(
        followupRunId,
        { phase: "end", endedAt: endedAt + 200 },
        { sessionKey: childSessionKey },
      );
      await flushAsync();
      // The legacy refresh briefly polls the silent follow-up.
      await vi.advanceTimersByTimeAsync(50);
      expect(findRun(runId)?.completion?.resultText).toBe(resultText);
    }
    endRun(runId, resultText, endedAt + 300);
    await flushAsync();
    const after = await waitForFrozenResultText(runId, resultText);
    expect(getSubagentRunRuntimeKey(after)).toBe(getSubagentRunRuntimeKey(before));
    expect(after).toMatchObject({
      runId,
      generation: before.generation,
      childSessionKey,
      execution: { status: "terminal" },
      completion: { resultText, terminalReply: { disposition: "visible", text: resultText } },
    });
    expect(after.completion?.capturedAt).toBeGreaterThanOrEqual(firstCapturedAt);
    await waitForCalls(2);
    expect(resultsFor(childSessionKey)).toEqual([firstText, resultText]);
  },
);

it("caps frozen output at 100KB and retains it after keep cleanup", async () => {
  const { runId } = await prepareRun("capped", "x".repeat(120 * 1024), undefined, false);

  emitLifecycleEvent(runId, { phase: "end", endedAt: Date.now() });
  await flushAsync();
  await agentCallWaits.settle();

  // Cleanup evicts resident payloads; the public reader hydrates the retained result.
  const prepared = await mod.prepareSubagentRunsByRunIds([runId]);
  const retained = prepared.consume((runs) => runs.get(runId));
  expect(retained.ready).toBe(true);
  const run = expectDefined(retained.ready ? retained.value : undefined, "retained child run");
  expect(getAgentCalls()).toHaveLength(0);
  expect(run.runId).toBe(runId);
  expect(run.cleanupCompletedAt).toBeTypeOf("number");
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
  const { runId } = await prepareRun("aborted", "Partial output before cancellation");

  emitLifecycleEvent(runId, { phase: "end", aborted: true, endedAt: Date.now() });
  await flushAsync();

  expect(getAgentCalls()).toHaveLength(0);
  expect(findRun(runId)?.execution.status).toBe("running");

  // The confirmed kill retires its row, so read its outcome from the last published row.
  let lastPublished: SubagentRunRecord | undefined;
  const stopRecording = subscribeSubagentRunChanges("projection", () => {
    lastPublished = structuredClone(mod.getSubagentRunByRunId(runId)) ?? lastPublished;
  });
  try {
    await advanceAndFlush(15_000);
    await agentCallWaits.settle();
  } finally {
    stopRecording();
  }

  expect(lastPublished).toMatchObject({
    endedReason: "subagent-killed",
    execution: { outcome: { status: "error", error: "subagent run terminated" } },
  });
  // The requester did not issue this kill, so it hears the stopped outcome exactly once.
  expect(getAgentCalls()).toHaveLength(1);
  expect(JSON.stringify(getAgentCalls()[0]?.params)).toContain(
    "ended without a result: 1 stopped, killed, or deleted before finishing",
  );
});

it.each([false, true])("settles provider timeout (recovered: %s)", async (recovered) => {
  const text = recovered ? "Final answer after recovery" : "Partial output before provider timeout";
  const { runId } = await prepareRun(recovered ? "timeout-cancel" : "provider-timeout", text);
  emitLifecycleEvent(runId, {
    phase: "end",
    aborted: true,
    status: "timeout",
    timeoutPhase: "provider",
    providerStarted: true,
    endedAt: Date.now(),
    ...(!recovered ? { stopReason: "restart", error: "provider timed out" } : {}),
  });
  await flushAsync();
  expect(getAgentCalls()).toHaveLength(0);
  if (recovered) {
    endRun(runId, text);
    await flushAsync();
  } else {
    await advanceAndFlush(30_000);
  }
  await waitForCalls(1);
  expect(firstOutcome()?.status).toBe(recovered ? "ok" : "timeout");
  if (!recovered) {
    expect(findRun(runId)?.execution.outcome?.status).toBe("timeout");
    return;
  }
  await waitForDeliveredCleanup(runId);
  await advanceAndFlush(30_000);
  expect(
    getAgentCalls().filter((request) => request.params?.idempotencyKey?.startsWith("announce:v1:")),
  ).toHaveLength(1);
  expect(getRequesterWakeCalls()).toHaveLength(0);
});

it("freezes parallel results across late traffic", async () => {
  const children = [];
  for (const [suffix, text] of [
    ["parallel-a", "Final answer A"],
    ["parallel-b", "Final answer B"],
  ] as const) {
    children.push({ ...(await prepareRun(suffix, text)), text });
  }
  agentCallPlan = ["throw", "throw", "ok", "ok"];
  const parallelEndedAt = Date.now();
  children.forEach(({ runId, text }, index) => endRun(runId, text, parallelEndedAt + index));
  await flushAsync();
  await waitForCalls(2);
  for (const { runId } of children) {
    await agentCallWaits.waitForCleanupHandledFalse(runId);
  }
  for (const { runId, childSessionKey } of children) {
    setAssistantOutput(childSessionKey, "Late overwrite", `${runId}-late-traffic`);
  }
  children.forEach(({ runId, text }, index) => endRun(runId, text, parallelEndedAt + 100 + index));
  await flushAsync();
  await waitForCalls(4);
  for (const { childSessionKey, text } of children) {
    expect(resultsFor(childSessionKey)).toEqual([text, text]);
  }
});
