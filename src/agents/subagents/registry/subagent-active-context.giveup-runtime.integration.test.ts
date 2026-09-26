// Runtime behavior proof for the #154834 fix (PR #154963).
//
// The unit suite in subagent-active-context.test.ts pins the renderer guard with
// synthetic registry entries. This integration suite instead produces the
// exhausted row through the real lifecycle: a real registry registration with a
// message-tool-only requester, a terminal child error event, the real announce
// delivery flow failing every attempt until its deadline, and the real
// finalizeResumedAnnounceGiveUp write path. Parent turns are then read through
// the production buildRuntimeFactsContext entrypoint, including after a real
// sqlite persistence cycle plus registry reset and boot restore.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../../config/config.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { buildRuntimeFactsContext } from "../../runtime-facts-prompt.js";
import { testing as subagentAnnounceDeliveryTesting } from "../announce/subagent-announce-delivery.test-support.js";
import { testing as subagentAnnounceOutputTesting } from "../announce/subagent-announce-output.test-support.js";
import "../spawn/subagent-spawn-model.mocks.shared.js";
import { testing as subagentAnnounceTesting } from "../announce/subagent-announce.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import type {
  GatewayRequest,
  LifecycleEvent,
  SessionStoreEntry,
} from "./subagent-registry.lifecycle-fixture.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import * as mod from "./subagent-registry.test-helpers.js";

const noop = () => {};
// A cron-sourced requester keeps this proof on real lifecycle code end to end.
const MAIN_REQUESTER_SESSION_KEY = "agent:main:cron:giveup-proof";
const CHILD_ERROR_TEXT = "FailoverError: LLM request failed: network connection error.";
const AWAITING_BLOCK_HEADING = "## Child results awaiting delivery";

let lifecycleHandler: ((evt: LifecycleEvent) => void) | undefined;
let agentCallPlan: Array<"ok" | "throw"> = [];
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
    return { messages: chatHistoryBySessionKey.get(sessionKey) ?? [] };
  }
  if (method === "agent") {
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
  agents: { defaults: { subagents: { archiveAfterMinutes: 120 } } },
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

const loadSubagentRegistryRuntimeForTest = async () =>
  ({
    replaceSubagentRunAfterSteer: mod.replaceSubagentRunAfterSteerCore,
  }) as unknown as typeof import("./subagent-registry-runtime.js");

const setAllTestDeps = () => {
  mod.testing.setDepsForTest({
    callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
    getRuntimeConfig: loadConfigMock as typeof import("../../../config/config.js").getRuntimeConfig,
    loadAgentRuntimePluginRegistryHandle: () => undefined,
    onAgentEvent:
      onAgentEventMock as unknown as typeof import("../../../infra/agent-events.js").onAgentEvent,
  });
  subagentAnnounceTesting.setDepsForTest({
    callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
    getRuntimeConfig: loadConfigMock as typeof import("../../../config/config.js").getRuntimeConfig,
    loadSubagentRegistryRuntime: loadSubagentRegistryRuntimeForTest,
  });
  subagentAnnounceDeliveryTesting.setDepsForTest({
    callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
    getRuntimeConfig: loadConfigMock as typeof import("../../../config/config.js").getRuntimeConfig,
    loadSessionEntry: ({ sessionKey }: { sessionKey: string }) => sessionStore[sessionKey],
    getRequesterSessionActivity: (requesterSessionKey: string) => {
      const entry = sessionStore[requesterSessionKey];
      return { sessionId: entry?.sessionId, isActive: false };
    },
  });
  subagentAnnounceOutputTesting.setDepsForTest({
    findTranscriptEvent: async ({ sessionKey }, match) => {
      const events = sessionKey ? transcriptEventsBySessionKey.get(sessionKey) : undefined;
      const event = events?.findLast(match);
      return event === undefined ? undefined : { event };
    },
    findSessionTranscriptArchiveEventReadOnly: async () => undefined,
    callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
    getRuntimeConfig: loadConfigMock as typeof import("../../../config/config.js").getRuntimeConfig,
    readSubagentSessionEntry: (_storePath: string, sessionKey: string) => sessionStore[sessionKey],
    resolveAgentIdFromSessionKey: (key?: string) => key?.match(/^agent:([^:]+)/)?.[1] ?? "main",
    resolveSessionStorePathCore: () => sessionStorePath,
  });
};

describe("exhausted failed delivery leaves parent runtime context (real give-up flow)", () => {
  let previousFastTestEnv: string | undefined;
  let testState: OpenClawTestState;

  beforeEach(async () => {
    testState = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
    sessionStorePath = testState.statePath("agents", "main", "sessions", "sessions.json");
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_TEST_FAST = "1";
    setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
    callGatewayMock.mockClear();
    onAgentEventMock.mockClear();
    loadConfigMock.mockClear().mockReturnValue({
      agents: { defaults: { subagents: { archiveAfterMinutes: 120 } } },
      session: { mainKey: "main", scope: "per-sender" },
    });
    agentCallPlan = [];
    chatHistoryBySessionKey = new Map();
    transcriptEventsBySessionKey = new Map();
    lifecycleHandler = undefined;
    // Message-tool-only requester source: an external bot-channel delivery route.
    sessionStore = new Proxy<Record<string, SessionStoreEntry>>(
      {
        [MAIN_REQUESTER_SESSION_KEY]: {
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
    setAllTestDeps();
  });

  afterEach(async () => {
    // Failed assertions must also release the delivery owned by this test.
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

  const flushAsync = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const findRun = (runId: string) =>
    mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((candidate) => candidate.runId === runId);

  const getAgentCalls = () =>
    (callGatewayMock.mock.calls as [GatewayRequest][])
      .map(([request]) => request)
      .filter((request) => request.method === "agent");

  const waitForAgentCallCount = async (expectedCount: number) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (getAgentCalls().length >= expectedCount) {
        return;
      }
      await vi.advanceTimersByTimeAsync(100);
      await flushAsync();
    }
    throw new Error(`expected ${expectedCount} agent call(s), got ${getAgentCalls().length}`);
  };

  const waitForCleanupOpenPendingPayload = async (runId: string) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const run = findRun(runId);
      if (
        run?.cleanupHandled === false &&
        run.delivery?.status === "pending" &&
        run.delivery.payload
      ) {
        return;
      }
      await vi.advanceTimersByTimeAsync(1);
      await flushAsync();
    }
    throw new Error(`run ${runId} did not reach an open pending delivery payload in time`);
  };

  const waitForExhaustedGiveUp = async (runId: string) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const run = findRun(runId);
      if (run?.delivery?.status === "failed" && typeof run.cleanupCompletedAt === "number") {
        return;
      }
      await vi.advanceTimersByTimeAsync(60_000);
      await flushAsync();
    }
    const run = findRun(runId);
    throw new Error(
      `run ${runId} never reached the exhausted give-up shape: ${JSON.stringify({
        delivery: run?.delivery,
        cleanupCompletedAt: run?.cleanupCompletedAt,
        requesterSettleWake: run?.requesterSettleWake,
      })}`,
    );
  };

  const waitForRestoredRun = async (runId: string) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (findRun(runId)) {
        return;
      }
      await vi.advanceTimersByTimeAsync(100);
      await flushAsync();
    }
    throw new Error(`run ${runId} was not restored from sqlite after registry reset`);
  };

  const emitLifecycleEvent = (
    runId: string,
    data: Record<string, unknown>,
    options?: { sessionKey?: string },
  ) => {
    lifecycleHandler?.({
      stream: "lifecycle",
      runId,
      sessionKey: options?.sessionKey,
      data,
    } as LifecycleEvent);
  };

  const setAssistantOutput = (sessionKey: string, text: string, runId: string) => {
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
  };

  const buildParentRuntimeContext = async (): Promise<string> => {
    const fragments = await buildRuntimeFactsContext({
      capabilityToolNames: new Set(["sessions_spawn"]),
      sessionKey: MAIN_REQUESTER_SESSION_KEY,
      agentId: "main",
      cfg: getRuntimeConfig(),
    });
    return fragments.map((fragment) => fragment.text).join("\n");
  };

  const activateRegistryForRestore = () => {
    const gatewayContext = {
      recoveryRuntime: {
        dispatchAgent: vi.fn(),
        waitForAgent: vi.fn(async () => ({ status: "pending" })),
        sendRecoveryNotice: vi.fn(),
        dispatchSessionMethod: vi.fn(),
      },
      resolveGatewayContext: () => undefined,
    };
    gatewayContext.resolveGatewayContext = () => gatewayContext as never;
    mod.activateSubagentRegistry(gatewayContext.resolveGatewayContext);
  };

  it("stops rendering an exhausted give-up row on later parent turns and after restart", async () => {
    const runId = "run-giveup-runtime-proof";
    const childSessionKey = "agent:main:subagent:giveup-runtime-proof";
    mod.registerSubagentRun({
      runId,
      childSessionKey,
      requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
      controllerSessionKey: MAIN_REQUESTER_SESSION_KEY,
      requesterAgentId: "main",
      requesterDisplayKey: "main",
      task: "message-tool-only delivery task that fails",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });

    // Every completion-agent attempt fails, like the reported deployment where
    // the completion agent never used the message tool on a bot-channel source.
    agentCallPlan = Array.from({ length: 64 }, () => "throw" as const);

    setAssistantOutput(childSessionKey, "fatal child summary", runId);

    emitLifecycleEvent(runId, {
      phase: "error",
      error: CHILD_ERROR_TEXT,
      endedAt: Date.now(),
    });
    await flushAsync();
    // The terminal-error grace window (15s under OPENCLAW_TEST_FAST) must pass
    // before the announce flow starts for the failed child.
    await vi.advanceTimersByTimeAsync(15_000);
    await flushAsync();
    await waitForAgentCallCount(1);

    // While cleanup is still open, the delivery stays a live obligation and the
    // production runtime-facts entrypoint must keep surfacing it.
    await waitForCleanupOpenPendingPayload(runId);
    const inflightContext = await buildParentRuntimeContext();
    expect(inflightContext).toContain(AWAITING_BLOCK_HEADING);
    expect(inflightContext).toContain(`run_json="${runId}"`);

    // Drive fake time through the announce retry backoff past the hard
    // delivery deadline so the real finalizeResumedAnnounceGiveUp path runs.
    await waitForExhaustedGiveUp(runId);

    const exhausted = findRun(runId);
    expect(exhausted?.delivery?.status).toBe("failed");
    expect(typeof exhausted?.cleanupCompletedAt).toBe("number");
    expect(exhausted?.execution.outcome).toMatchObject({ status: "error" });
    expect(exhausted?.completion).toMatchObject({ required: true, resultText: null });

    // Current main's give-up path schedules a requester settle wake, whose own
    // cron completion may remove it asynchronously. While such a wake is
    // retained the row stays an outstanding obligation, and this PR leaves the
    // with-wake rendering to #151769/#151771 — so nothing is asserted about
    // the wake's instantaneous state here.

    // The #154834 row shape is the failed delivery whose wake is gone. The
    // reported deployment persisted exactly that durable state (its 2026.9.5
    // give-up path predated retained settle wakes), and rows whose never
    // -committing wake was abandoned land in the same shape. Represent that
    // durable row by dropping any retained wake, then verify the renderer
    // through the real persistence + boot-restore paths below.
    const liveEntry = mod.getSubagentRunByRunId(runId);
    expect(liveEntry).toBeDefined();
    liveEntry!.requesterSettleWake = undefined;
    persistSubagentRunsToDiskOrThrow(subagentRuns, [runId]);

    // Later parent turns over the live registry: the dead row must not be
    // re-injected by the production entrypoint.
    const laterTurnOne = await buildParentRuntimeContext();
    const laterTurnTwo = await buildParentRuntimeContext();
    for (const contextText of [laterTurnOne, laterTurnTwo]) {
      expect(contextText).not.toContain(AWAITING_BLOCK_HEADING);
      expect(contextText).not.toContain("requester_continuation=");
      expect(contextText).not.toContain(`run_json="${runId}"`);
    }

    // Restart leg: durable sqlite row, then a fresh registry boot restore.
    const persisted = loadSubagentRegistryFromSqlite().get(runId);
    expect(persisted?.delivery?.status).toBe("failed");
    expect(typeof persisted?.cleanupCompletedAt).toBe("number");
    expect(persisted?.requesterSettleWake).toBeUndefined();

    mod.resetSubagentRegistryForTests({ persist: false });
    setAllTestDeps();
    activateRegistryForRestore();
    mod.initSubagentRegistry();
    await waitForRestoredRun(runId);

    const restored = findRun(runId);
    expect(restored?.delivery?.status).toBe("failed");
    expect(typeof restored?.cleanupCompletedAt).toBe("number");
    expect(restored?.requesterSettleWake).toBeUndefined();

    const postRestartContext = await buildParentRuntimeContext();
    expect(postRestartContext).not.toContain(AWAITING_BLOCK_HEADING);
    expect(postRestartContext).not.toContain("requester_continuation=");
    expect(postRestartContext).not.toContain(`run_json="${runId}"`);
  });
});
