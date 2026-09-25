import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { callGateway } from "../../../gateway/call.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { getAgentEventLifecycleGeneration, onAgentEvent } from "../../../infra/agent-events.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import type { deliverAgentCommandResult } from "../../command/delivery.js";
import type { EmbeddedAgentRunResult } from "../../embedded-agent-runner/types.js";
import "../spawn/subagent-spawn-model.mocks.shared.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import { createSubagentRunParams } from "../../subagent-test-fixtures.test-helpers.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { maybeSpawnVisibleSession } from "../../tools/sessions-spawn-visible.js";
import { createSessionsYieldTool } from "../../tools/sessions-yield-tool.js";
import { testing as subagentAnnounceDeliveryTesting } from "../announce/subagent-announce-delivery.test-support.js";
import { testing as subagentAnnounceOutputTesting } from "../announce/subagent-announce-output.test-support.js";
import { announceTesting as subagentAnnounceTesting } from "../announce/subagent-announce-overrides.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import * as completionStore from "../completion/subagent-completion-admission.store.js";
import { registerRequesterFinalAttachment } from "../requester-final-attachment.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type {
  GatewayRequest,
  SessionStoreEntry,
} from "./subagent-registry.lifecycle-fixture.test-support.js";
import { createLifecycleWaits } from "./subagent-registry.lifecycle-waits.test-support.js";
import { registerRequesterWakeSettlementBoundaryTests } from "./subagent-registry.requester-wake-settlement.test-support.js";
import * as registry from "./subagent-registry.test-helpers.js";

const MAIN_REQUESTER_SESSION_KEY = "agent:main:main";

type GatewayDeliveryStatus = NonNullable<
  Awaited<ReturnType<typeof deliverAgentCommandResult>>["deliveryStatus"]
>;

type GatewayResponse = {
  status?: string;
  runId?: string;
  messages?: Array<Record<string, unknown>>;
  result?: Partial<EmbeddedAgentRunResult> & { deliveryStatus?: Partial<GatewayDeliveryStatus> };
};

let lifecycleHandler: Parameters<typeof onAgentEvent>[0] | undefined;
let agentCallGates = new Map<string, Promise<void>>();
let releaseAgentCallGate: (() => void) | undefined;
let agentCallObserved = createDeferred();
let chatHistoryBySessionKey = new Map<string, Array<Record<string, unknown>>>();
let sessionStore: Record<string, SessionStoreEntry> = {};
let sessionStorePath: string;
let rejectNextRequesterWake = false;
let rejectNextRequesterWakePersistence = false;
let armRequesterWakePersistenceFailure = false;
let emptyGatedAgentReply = false;

const sendMessageMock = vi.fn<typeof import("../../../infra/outbound/message.js").sendMessage>(
  async () => ({
    channel: "discord",
    to: "user-1",
    via: "direct",
    mediaUrl: null,
    result: { messageId: "unexpected-fallback" },
  }),
);

const callGatewayMock = vi.fn(async (request: GatewayRequest): Promise<GatewayResponse> => {
  if (request.method === "agent.wait") {
    return { status: "pending" };
  }
  if (request.method === "chat.history") {
    return { messages: chatHistoryBySessionKey.get(request.params?.sessionKey ?? "") ?? [] };
  }
  if (request.method === "agent") {
    agentCallObserved.resolve();
    agentCallObserved = createDeferred();
    const sourceSessionKey = request.params?.inputProvenance?.sourceSessionKey;
    const gate = sourceSessionKey ? agentCallGates.get(sourceSessionKey) : undefined;
    if (gate) {
      await gate;
      if (emptyGatedAgentReply) {
        return { result: { payloads: [] } };
      }
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
vi.mock("../announce/subagent-announce.requester-settle-wake.js", { spy: true });

const { maybeWakeRequesterAfterAllChildrenSettled: wakeRequester } = await vi.importActual<
  typeof import("../announce/subagent-announce.requester-settle-wake.js")
>("../announce/subagent-announce.requester-settle-wake.js");

function createGatewayContext() {
  const recoveryRuntime: GatewayRequestContext["recoveryRuntime"] = {
    dispatchAgent: (params, timeoutMs) => callGateway({ method: "agent", params, timeoutMs }),
    waitForAgent: (params, timeoutMs, signal) =>
      callGateway({ method: "agent.wait", params, timeoutMs, signal }),
    dispatchSessionMethod: (method, params, options) =>
      callGateway({
        method,
        params,
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
        assertDispatchCurrent: options?.assertCurrent,
      }),
    sendRecoveryNotice: async () => {
      throw new Error("Unexpected recovery notice");
    },
  };
  const context = { recoveryRuntime } as GatewayRequestContext;
  context.resolveGatewayContext = () => context;
  return context;
}

vi.mock("../../../config/sessions.js", async () => ({
  ...(await import("../../../config/sessions/targets.js")),
  ...(await import("../../../config/sessions/main-session.js")),
  loadSessionStore: vi.fn(() => sessionStore),
  resolveAgentIdFromSessionKey: (key: string) => key.match(/^agent:([^:]+)/)?.[1] ?? "main",
  resolveSessionStorePathCore: () => sessionStorePath,
  resolveMainSessionKey: () => MAIN_REQUESTER_SESSION_KEY,
  updateSessionStore: vi.fn(),
}));

vi.mock("../../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config/sessions/session-accessor.js")>()),
  loadSessionEntry: (scope: { sessionKey: string }) => sessionStore[scope.sessionKey],
  // Timing writes must share the synthetic session fixture used by reads.
  // Subagent and task settlement below still use their real SQLite stores.
  patchSessionEntryCore: async (
    ...[scope, update, options = {}]: Parameters<
      typeof import("../../../config/sessions/session-accessor.js").patchSessionEntryCore
    >
  ) => {
    const entry = sessionStore[scope.sessionKey];
    if (!entry) {
      return null;
    }
    const patch = await update(entry, { existingEntry: { ...entry } });
    if (patch === null || options.shouldCommit?.() === false) {
      return entry;
    }
    options.assertCommitAllowed?.();
    const updated = options.replaceEntry
      ? (patch as import("../../../config/sessions/types.js").SessionEntry)
      : { ...entry, ...patch };
    sessionStore[scope.sessionKey] = updated;
    return updated;
  },
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

describe("requester settle wake product flow", () => {
  let previousFastTestEnv: string | undefined;
  let testState: OpenClawTestState;
  let settleRootWork: ReturnType<typeof observeRootWork>;
  const { flushAsync, waitForDeliveredCleanup } = createLifecycleWaits(MAIN_REQUESTER_SESSION_KEY);
  const flushOwnedWork = async () => {
    await flushAsync();
    await settleRootWork(true);
  };

  beforeEach(async () => {
    testState = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
    sessionStorePath = testState.statePath("agents", "main", "sessions", "sessions.json");
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_TEST_FAST = "1";
    loadConfigMock.mockReset().mockReturnValue({
      agents: {
        defaults: { subagents: { archiveAfterMinutes: 0 } },
        list: [{ id: "main" }, { id: "research" }],
      },
      session: { mainKey: "main", scope: "per-sender" },
    });
    callGatewayMock.mockClear();
    vi.mocked(callGateway).mockImplementation(callGatewayMock as typeof callGateway);
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReset();
    vi.mocked(onAgentEvent).mockImplementation((handler) => {
      lifecycleHandler = handler;
      return () => {};
    });
    agentCallGates = new Map();
    agentCallObserved = createDeferred();
    chatHistoryBySessionKey = new Map();
    rejectNextRequesterWake = false;
    rejectNextRequesterWakePersistence = false;
    armRequesterWakePersistenceFailure = false;
    emptyGatedAgentReply = false;
    sendMessageMock.mockClear();
    sessionStore = {
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
    };
    await replaceSessionEntry(
      { storePath: sessionStorePath, sessionKey: MAIN_REQUESTER_SESSION_KEY },
      sessionStore[MAIN_REQUESTER_SESSION_KEY]!,
    );
    vi.useFakeTimers();
    settleRootWork = observeRootWork();
    const settle = completionStore.settleRequesterCompletionBatch;
    vi.spyOn(completionStore, "settleRequesterCompletionBatch").mockImplementation((params) => {
      if (rejectNextRequesterWakePersistence) {
        rejectNextRequesterWakePersistence = false;
        throw new Error("database is locked");
      }
      settle(params);
    });
    vi.mocked(maybeWakeRequesterAfterAllChildrenSettled).mockImplementation(async (params) => {
      if (rejectNextRequesterWake) {
        rejectNextRequesterWake = false;
        rejectNextRequesterWakePersistence = armRequesterWakePersistenceFailure;
        armRequesterWakePersistenceFailure = false;
        throw new Error("requester wake rejected before attempt admission");
      }
      return await wakeRequester(params);
    });
    subagentAnnounceTesting.setDepsForTest({
      callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
      getRuntimeConfig: loadConfigMock,
    });
    subagentAnnounceDeliveryTesting.setDepsForTest({
      sendMessage: sendMessageMock,
      callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
      getRuntimeConfig: loadConfigMock,
      loadSessionEntry: ({ sessionKey }) => sessionStore[sessionKey],
      getRequesterSessionActivity: (requesterSessionKey: string) => ({
        sessionId: sessionStore[requesterSessionKey]?.sessionId,
        isActive: false,
      }),
    });
    subagentAnnounceOutputTesting.setDepsForTest({
      callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
      getRuntimeConfig: loadConfigMock,
      readSubagentSessionEntry: (_storePath, sessionKey) => sessionStore[sessionKey],
      resolveAgentIdFromSessionKey: (key) => key?.match(/^agent:([^:]+)/)?.[1] ?? "main",
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
        await settleRootWork();
      }
    } finally {
      lifecycleHandler = undefined;
      subagentAnnounceDeliveryTesting.setDepsForTest();
      subagentAnnounceOutputTesting.setDepsForTest();
      subagentAnnounceTesting.setDepsForTest();
      registry.resetSubagentRegistryForTests({ persist: false });
      vi.useRealTimers();
      vi.restoreAllMocks();
      if (previousFastTestEnv === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
      }
      await testState.cleanup();
    }
  });

  const getAgentCalls = () =>
    (callGatewayMock.mock.calls as [GatewayRequest][])
      .map(([request]) => request)
      .filter((request) => request.method === "agent");

  const getRequesterWakeCalls = () =>
    getAgentCalls().filter((request) =>
      request.params?.idempotencyKey?.startsWith("announce:requester-settle:"),
    );

  const waitForAgentCallCount = async (expectedCount: number) => {
    while (getAgentCalls().length < expectedCount) {
      await agentCallObserved.promise;
    }
  };

  const spawnVisibleChild = async (params: {
    runId: string;
    childSessionKey: string;
    requesterTurnRunId: string;
  }) => {
    const result = await maybeSpawnVisibleSession({
      raw: { visible: true },
      task: `finish ${params.runId}`,
      label: params.runId,
      runtime: "subagent",
      sandbox: "inherit",
      expectsCompletionMessage: true,
      options: {
        agentSessionKey: MAIN_REQUESTER_SESSION_KEY,
        requesterTurnRunId: params.requesterTurnRunId,
        requesterAgentIdOverride: "main",
        config: {
          agents: { list: [{ id: "main" }] },
          session: { mainKey: "main", scope: "per-sender" },
        },
        callGateway: vi.fn(async () => ({
          key: params.childSessionKey,
          runStarted: true,
          runId: params.runId,
        })) as never,
        registerRun: registry.registerSubagentRun,
        countActiveRuns: () => 0,
      },
    });
    expect(result).toMatchObject({ status: "accepted", runId: params.runId });
  };

  const emitCompleted = (
    runId: string,
    childSessionKey: string,
    text: string,
    modelRouteChange?: string,
  ) => {
    chatHistoryBySessionKey.set(childSessionKey, [{ role: "assistant", content: text }]);
    if (!lifecycleHandler) {
      throw new Error("Fixture lifecycle listener was not registered before completion");
    }
    lifecycleHandler({
      stream: "lifecycle",
      runId,
      seq: 1,
      ts: Date.now(),
      sessionKey: childSessionKey,
      data: {
        phase: "end",
        endedAt: Date.now(),
        terminalReply: {
          disposition: "visible",
          text,
          ...(modelRouteChange ? { modelRouteChange } : {}),
        },
      },
    });
  };

  it.each(
    ["alpha", "beta"].flatMap((firstCompleted) =>
      ["same", "distinct", "mixed-unbound", "yielded"].map((mode) => ({
        firstCompleted,
        binding: mode === "yielded" ? "same" : mode,
        yieldedParent: mode === "yielded" ? "alpha" : undefined,
      })),
    ),
  )(
    "settles overlapping caller turns with $firstCompleted first ($binding ownership, yielded=$yieldedParent)",
    async ({ firstCompleted, binding, yieldedParent }) => {
      vi.setSystemTime(100_000);
      const context = createGatewayContext();
      const otherContext = createGatewayContext();
      registry.initSubagentRegistry();
      const activate = () => {
        // Standalone registration can be wholly unbound, but cannot mix ambient
        // routing with a captured owner. Restored rows have a separate activation gate.
        if (binding !== "mixed-unbound") {
          registry.activateSubagentRegistry(() => context);
        }
      };
      activate();
      const children = ["alpha", "beta"].map((name) => ({
        name,
        runId: `run-${name}`,
        childSessionKey: `agent:main:subagent:${name}`,
      }));
      const resolvers: Array<GatewayRequestContext["resolveGatewayContext"]> = [];
      for (const child of children) {
        const requesterTurnRunId = `requester-${child.name}`;
        const admission = prepareSystemAgentRunAdmission(
          {},
          requesterTurnRunId,
          "main",
          "requester-wake-test",
        );
        try {
          const admitted = await admission.admit("embedded");
          bindGatewayContextResolver(
            admitted,
            binding !== "same" && child.name === "beta"
              ? binding === "distinct"
                ? otherContext.resolveGatewayContext
                : undefined
              : context.resolveGatewayContext,
          );
          await withGatewayToolCallerIdentity(
            createAdmittedGatewayToolCallerIdentity({
              admittedRunContext: admitted,
              agentId: "main",
              sessionKey: MAIN_REQUESTER_SESSION_KEY,
            }),
            async () => {
              const gatewayContextResolver = getGatewayToolCallerIdentity()?.gatewayContextResolver;
              resolvers.push(gatewayContextResolver);
              await registry.registerSubagentRun(
                createSubagentRunParams({
                  ...child,
                  requesterTurnRunId,
                  requesterAgentId: "main",
                  expectsCompletionMessage: true,
                  gatewayContextResolver,
                }),
              );
            },
          );
          if (child.name === yieldedParent) {
            await createSessionsYieldTool({
              sessionId: "sess-main",
              claimYield: () =>
                registry.markRequesterTurnYielded({
                  requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
                  requesterAgentId: "main",
                  requesterTurnRunId,
                }) > 0,
              onYield: () => {},
            }).execute(`yield-${child.name}`, {});
          }
          registry.settleRequesterAfterSessionSpawns({
            requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
            requesterAgentId: "main",
            requesterTurnRunId,
            requesterYielded: child.name === yieldedParent,
            acceptedSessionSpawns: [child],
          });
        } finally {
          admission.close();
        }
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(resolvers[0]).not.toBe(resolvers[1]);
      expect(resolvers[0]?.()).toBe(context);
      expect(resolvers[1]?.()).toBe(
        binding === "same" ? context : binding === "distinct" ? otherContext : undefined,
      );
      const completionOrder = firstCompleted === "alpha" ? children : children.toReversed();
      const first = completionOrder[0]!;
      const second = completionOrder[1]!;
      emitCompleted(first.runId, first.childSessionKey, `${first.name} complete`);
      await flushOwnedWork();
      if (first.name === yieldedParent) {
        // Yielded completion stays owned by its frozen wake until every child settles.
        await vi.waitFor(() =>
          expect(registry.getSubagentRunByRunId(first.runId)).toMatchObject({
            execution: { status: "terminal" },
            cleanupCompletedAt: expect.any(Number),
            requesterSettleWake: { rearmGeneration: 1 },
          }),
        );
      } else {
        await waitForDeliveredCleanup(first.runId, { allowPendingRequesterSettleWake: true });
      }
      expect(getRequesterWakeCalls()).toHaveLength(0);
      activate();
      activate();
      children.forEach((child, index) => {
        const row = registry.getSubagentRunByRunId(child.runId)!;
        expect(getGatewayContextResolver(row)).toBe(resolvers[index]);
        expect(row.requesterTurnRunId).toBeUndefined();
      });
      emitCompleted(second.runId, second.childSessionKey, `${second.name} complete`);
      await flushOwnedWork();
      await waitForDeliveredCleanup(second.runId, { allowPendingRequesterSettleWake: true });
      activate();
      await registry.testing.sweepOnceForTests();
      await vi.advanceTimersByTimeAsync(30_000);
      await flushOwnedWork();
      expect(getRequesterWakeCalls()).toHaveLength(binding === "same" ? 1 : 0);
      for (const child of children) {
        expect(registry.getSubagentRunByRunId(child.runId)).toMatchObject({
          delivery: { status: "delivered" },
          requesterSettleWake: undefined,
        });
      }
    },
  );

  it.each([
    {
      name: "delivers the visible requester final",
      rejectRequesterWake: false,
      rejectPersistence: false,
      emptyReply: false,
    },
    {
      name: "settles the rejected delivered-row wake",
      rejectRequesterWake: true,
      rejectPersistence: false,
      emptyReply: false,
    },
    {
      name: "backs off when rejected-wake settlement persistence fails",
      rejectRequesterWake: true,
      rejectPersistence: true,
      emptyReply: false,
    },
    {
      name: "retires a stale empty announce after requester delivery",
      rejectRequesterWake: false,
      rejectPersistence: false,
      emptyReply: true,
    },
  ])("$name", async ({ rejectRequesterWake, rejectPersistence, emptyReply }) => {
    emptyGatedAgentReply = emptyReply;
    const requesterTurnRunId = "run-requester-yield";
    const alpha = {
      runId: "run-alpha",
      childSessionKey: "agent:main:subagent:alpha",
      expectsCompletionMessage: true,
    };
    const beta = {
      runId: "run-beta",
      childSessionKey: "agent:main:subagent:beta",
      expectsCompletionMessage: true,
    };
    await spawnVisibleChild({ ...alpha, requesterTurnRunId });
    await spawnVisibleChild({ ...beta, requesterTurnRunId });

    agentCallGates.set(
      beta.childSessionKey,
      new Promise<void>((resolve) => {
        releaseAgentCallGate = resolve;
      }),
    );
    emitCompleted(alpha.runId, alpha.childSessionKey, "alpha complete");
    await waitForAgentCallCount(1);
    await waitForDeliveredCleanup(alpha.runId, { allowPendingRequesterSettleWake: true });
    const modelRouteChange = "Model route changed: requested/model → actual/model.";
    emitCompleted(beta.runId, beta.childSessionKey, "beta complete", modelRouteChange);
    await waitForAgentCallCount(2);

    const betaBeforeYield = registry.getSubagentRunByRunId(beta.runId);
    if (!betaBeforeYield) {
      throw new Error("expected beta run before requester yield");
    }
    betaBeforeYield.delivery = rejectRequesterWake
      ? {
          ...betaBeforeYield.delivery,
          status: "delivered",
          disposition: "delivered",
          deliveredAt: Date.now(),
        }
      : { ...betaBeforeYield.delivery, status: "in_progress" };

    const yieldTool = createSessionsYieldTool({
      sessionId: "sess-main",
      claimYield: () =>
        registry.markRequesterTurnYielded({
          requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
          requesterAgentId: "main",
          requesterTurnRunId,
        }) > 0,
      onYield: () => {},
    });
    await expect(
      yieldTool.execute("yield-requester-wake", { message: "Wait for visible children" }),
    ).resolves.toMatchObject({ details: { status: "yielded" } });

    rejectNextRequesterWake = rejectRequesterWake;
    armRequesterWakePersistenceFailure = rejectPersistence;
    const { withLocalSessionPlacementTurnSettlement } =
      await import("../../session-placement-admission.js");
    await withLocalSessionPlacementTurnSettlement(
      {
        sessionId: "sess-main",
        sessionKey: MAIN_REQUESTER_SESSION_KEY,
        agentId: "main",
        runId: requesterTurnRunId,
      },
      async () => ({
        acceptedSessionSpawns: [alpha, beta],
        meta: {
          durationMs: 1,
          yielded: true,
          executionTrace: { runner: "cli", attempts: [], fallbackUsed: false },
        },
      }),
    );
    await waitForAgentCallCount(rejectRequesterWake ? 2 : 3);
    await waitForDeliveredCleanup(alpha.runId, {
      allowPendingRequesterSettleWake: rejectPersistence,
    });
    expect(getRequesterWakeCalls()).toHaveLength(rejectRequesterWake ? 0 : 1);
    if (rejectPersistence) {
      expect(registry.getSubagentRunByRunId(alpha.runId)?.requesterSettleWake).toMatchObject({
        status: "pending",
        attemptCount: 0,
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(getRequesterWakeCalls()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await waitForDeliveredCleanup(alpha.runId);
      expect(getRequesterWakeCalls()).toHaveLength(0);
    }
    if (!rejectRequesterWake) {
      const wakeMessage = getRequesterWakeCalls()[0]?.params?.message;
      expect(wakeMessage).toContain(modelRouteChange);
      // Yielded batches must retain the same outcome/blocked boundary as
      // individual completions, not downgrade failed checks to a final update.
      expect(wakeMessage).toContain(
        "Reviews, failed checks, and other in-scope fixable blockers require continued work",
      );
      expect(wakeMessage).toContain(
        "report a blocker only when progress needs new user authority or an unavailable external decision",
      );
      expect(wakeMessage).toContain(
        "Keep this runtime-authored model-route change notice internal on this shared surface.",
      );
    }
    for (const child of [alpha, beta]) {
      expect(registry.getSubagentRunByRunId(child.runId)).toMatchObject({
        delivery: { status: "delivered" },
        requesterSettleWake: undefined,
      });
    }

    agentCallGates.delete(beta.childSessionKey);
    releaseAgentCallGate?.();
    await waitForDeliveredCleanup(alpha.runId);
    await waitForDeliveredCleanup(beta.runId);
    await registry.testing.sweepOnceForTests();
    expect(getRequesterWakeCalls()).toHaveLength(rejectRequesterWake ? 0 : 1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(registry.getSubagentRunByRunId(beta.runId)?.delivery).toMatchObject({
      status: "delivered",
      disposition: "delivered",
      payload: undefined,
      lastError: undefined,
      lastDropReason: undefined,
    });
  });

  it.each([
    { runtime: "cli", acceptNextChild: true, attachRequesterFinal: false },
    { runtime: "cli", acceptNextChild: false, attachRequesterFinal: false },
    { runtime: "native", acceptNextChild: true, attachRequesterFinal: false },
    { runtime: "cli", acceptNextChild: true, attachRequesterFinal: true },
  ] as const)(
    "preserves serial continuation without replaying an accepted wave ($runtime, next child accepted=$acceptNextChild, requester final=$attachRequesterFinal)",
    async ({ runtime, acceptNextChild, attachRequesterFinal }) => {
      vi.setSystemTime(100_000);
      const context = createGatewayContext();
      registry.initSubagentRegistry();
      registry.activateSubagentRegistry(() => context);
      const alpha = {
        runId: "run-serial-alpha",
        childSessionKey: "agent:main:subagent:serial-alpha",
        expectsCompletionMessage: true,
      };
      const beta = {
        runId: "run-serial-beta",
        childSessionKey: "agent:main:subagent:serial-beta",
        expectsCompletionMessage: true,
      };
      const { withLocalSessionPlacementTurnSettlement } =
        await import("../../session-placement-admission.js");
      const yieldTurn = async (requesterTurnRunId: string, accepted: (typeof alpha)[]) => {
        const result = await createSessionsYieldTool({
          sessionId: "sess-main",
          claimYield: () =>
            registry.markRequesterTurnYielded({
              requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
              requesterAgentId: "main",
              requesterTurnRunId,
            }) > 0,
          onYield: () => {},
        }).execute(`yield-${requesterTurnRunId}`, {});
        expect(result).toMatchObject({
          details: { status: accepted.length > 0 ? "yielded" : "error" },
        });
        if (runtime === "native") {
          const harnessSelection = await import("../../harness/selection.js");
          const { runEmbeddedAttemptWithBackend } =
            await import("../../embedded-agent-runner/run/backend.js");
          const { makeEmbeddedRunnerAttempt } =
            await import("../../test-helpers/embedded-agent-runner-e2e-fixtures.js");
          const { makeTerminalInput } =
            await import("../../embedded-agent-runner/run/terminal-resolution.test-support.js");
          const { resolveEmbeddedRunTerminal } =
            await import("../../embedded-agent-runner/run/terminal-resolution.js");
          const { AuthStorage, ModelRegistry } = await import("../../sessions/index.js");
          const admission = prepareSystemAgentRunAdmission(
            {},
            requesterTurnRunId,
            "main",
            "serial-requester-wake-test",
          );
          const harnessAttempt = vi.spyOn(harnessSelection, "runAgentHarnessAttempt");
          try {
            // Harness execution is synthetic; terminal projection and logical
            // requester settlement are real. Placement cannot repair this path afterward.
            harnessAttempt.mockResolvedValue(
              makeEmbeddedRunnerAttempt({
                agentHarnessId: "codex",
                yieldDetected: true,
                acceptedSessionSpawns: accepted,
              }),
            );
            const admittedRunContext = await admission.admit("embedded");
            const runParams = {
              sessionId: "sess-main",
              sessionKey: MAIN_REQUESTER_SESSION_KEY,
              agentId: "main",
              runId: requesterTurnRunId,
              admittedRunContext,
            };
            const input = makeTerminalInput({ runParams });
            // Keep the real attempt contract complete without reading credentials
            // or executing the mocked harness's model transport.
            const authStorage = AuthStorage.inMemory();
            const attempt = await runEmbeddedAttemptWithBackend({
              ...runParams,
              agentDir: input.runParams.agentDir,
              workspaceDir: input.runParams.workspaceDir,
              prompt: input.runParams.prompt,
              timeoutMs: input.runParams.timeoutMs,
              sessionFile: "/tmp/serial-requester-wake-test/session.jsonl",
              provider: input.provider,
              modelId: input.modelId,
              model: {
                id: input.modelId,
                name: input.modelId,
                api: "openai-responses",
                provider: input.provider,
                baseUrl: "https://example.invalid",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 16_000,
                maxTokens: 2_048,
              },
              authStorage,
              authProfileStore: input.attemptAuthProfileStore,
              modelRegistry: ModelRegistry.inMemory(authStorage),
              thinkLevel: "off",
            });
            expect(harnessAttempt).toHaveBeenCalledTimes(1);
            const terminal = await resolveEmbeddedRunTerminal(
              makeTerminalInput({ attempt, runParams, agentHarnessId: "codex" }),
            );
            expect(terminal.action).toBe("complete");
            if (terminal.action !== "complete") {
              throw new Error("yielded native requester did not complete its turn");
            }
            const { settleRequesterRun } = await import("../../requester-run-settlement.js");
            settleRequesterRun(runParams, terminal.result, admission.assertSourceCurrent);
            for (const child of accepted) {
              expect(registry.getSubagentRunByRunId(child.runId)).toMatchObject({
                requesterTurnRunId: undefined,
                requesterSettleWake: {
                  status: "pending",
                  requesterYieldBatch: true,
                  batchRunIds: accepted.map((spawn) => spawn.runId).toSorted(),
                },
              });
            }
            expect(terminal.result.meta.yielded).toBe(true);
            expect(terminal.result.requesterContinuationSettled).toBe(true);
            expect(terminal.result.acceptedSessionSpawns).toEqual(accepted);
            expect(terminal.result.payloads ?? []).toEqual([]);
            return terminal.result;
          } finally {
            harnessAttempt.mockRestore();
            admission.close();
          }
        }
        return await withLocalSessionPlacementTurnSettlement(
          {
            sessionId: "sess-main",
            sessionKey: MAIN_REQUESTER_SESSION_KEY,
            agentId: "main",
            runId: requesterTurnRunId,
          },
          async () => ({
            payloads: [],
            acceptedSessionSpawns: accepted,
            meta: {
              durationMs: 1,
              yielded: accepted.length > 0,
              executionTrace: { runner: "cli", attempts: [], fallbackUsed: false },
            },
          }),
        );
      };
      const ordinaryGatewayCall = callGatewayMock.getMockImplementation()!;
      let firstWakeReturned = false;
      let visibleFinals = 0;
      const initialRequesterTurnRunId = "requester-serial-initial";
      const append = vi.fn(() => true);
      const attachment = attachRequesterFinal
        ? registerRequesterFinalAttachment({
            requesterAgentId: "main",
            requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
            requesterSessionId: "sess-main",
            requesterTurnRunId: initialRequesterTurnRunId,
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
            timeoutMs: 600_000,
            append,
          })
        : undefined;
      try {
        await callGatewayMock.withImplementation(
          async (request) => {
            if (
              request.method !== "agent" ||
              !request.params?.idempotencyKey?.startsWith("announce:requester-settle:")
            ) {
              return await ordinaryGatewayCall(request);
            }
            if (!firstWakeReturned) {
              // Gateway preflight uses this exact idempotency key as the run ID.
              const requesterTurnRunId = request.params.idempotencyKey;
              if (acceptNextChild) {
                const firstEndedAt = registry.getSubagentRunByRunId(alpha.runId)?.execution.endedAt;
                expect(firstEndedAt).toEqual(expect.any(Number));
                vi.setSystemTime(firstEndedAt! + 1);
                await spawnVisibleChild({ ...beta, requesterTurnRunId });
                expect(registry.getSubagentRunByRunId(beta.runId)?.createdAt).toBeGreaterThan(
                  firstEndedAt!,
                );
              }
              const result = await yieldTurn(requesterTurnRunId, acceptNextChild ? [beta] : []);
              firstWakeReturned = true;
              return { runId: requesterTurnRunId, status: "ok", result };
            }
            visibleFinals += 1;
            const response = await ordinaryGatewayCall(request);
            return attachRequesterFinal
              ? {
                  ...response,
                  result: {
                    ...response.result,
                    meta: { durationMs: 1, finalAssistantVisibleText: "completion delivered" },
                  },
                }
              : response;
          },
          async () => {
            await spawnVisibleChild({ ...alpha, requesterTurnRunId: initialRequesterTurnRunId });
            await yieldTurn(initialRequesterTurnRunId, [alpha]);
            attachment?.releaseProvisional();
            emitCompleted(alpha.runId, alpha.childSessionKey, "alpha findings");
            await flushOwnedWork();
            await vi.waitFor(() => {
              expect(firstWakeReturned).toBe(true);
              if (!acceptNextChild) {
                expect(
                  registry.getSubagentRunByRunId(alpha.runId)?.requesterSettleWake,
                ).toMatchObject({
                  status: "pending",
                  attemptCount: 1,
                  nextAttemptAt: expect.any(Number),
                });
              }
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(getRequesterWakeCalls()).toHaveLength(1);
            expect(visibleFinals).toBe(0);
            expect(append).not.toHaveBeenCalled();
            if (acceptNextChild) {
              expect(registry.countActiveDescendantRuns(MAIN_REQUESTER_SESSION_KEY, "main")).toBe(
                1,
              );
              expect(registry.getSubagentRunByRunId(beta.runId)).toMatchObject({
                requesterTurnRunId: undefined,
                requesterSettleWake: {
                  status: "pending",
                  batchRunIds: [beta.runId],
                  requesterYieldBatch: true,
                },
              });
              emitCompleted(beta.runId, beta.childSessionKey, "beta findings");
            } else {
              expect(registry.getSubagentRunByRunId(beta.runId)).toBeUndefined();
            }
            // Cross both native retry deadlines; a transferred obligation must not
            // start an extra parent turn, while an empty failed handoff must recover.
            await flushOwnedWork();
            await vi.advanceTimersByTimeAsync(151_000);
            await registry.testing.sweepOnceForTests();
            await vi.advanceTimersByTimeAsync(0);
            await flushOwnedWork();
            for (const child of acceptNextChild ? [alpha, beta] : [alpha]) {
              await waitForDeliveredCleanup(child.runId);
            }
            const wakeIdentities = getRequesterWakeCalls().map((request) => ({
              sourceSessionKey: request.params?.inputProvenance?.sourceSessionKey,
              idempotencyKey: request.params?.idempotencyKey,
            }));
            expect(wakeIdentities).toEqual([
              {
                sourceSessionKey: alpha.childSessionKey,
                idempotencyKey: expect.not.stringContaining(":retry-"),
              },
              {
                sourceSessionKey: acceptNextChild ? beta.childSessionKey : alpha.childSessionKey,
                idempotencyKey: acceptNextChild
                  ? expect.not.stringContaining(":retry-")
                  : expect.stringContaining(":retry-"),
              },
            ]);
            expect(visibleFinals).toBe(1);
            expect(sendMessageMock).not.toHaveBeenCalled();
            expect(registry.countActiveDescendantRuns(MAIN_REQUESTER_SESSION_KEY, "main")).toBe(0);
            if (attachRequesterFinal) {
              expect(append).toHaveBeenCalledExactlyOnceWith("completion delivered");
            }
          },
        );
      } finally {
        attachment?.revoke();
      }
    },
  );

  registerRequesterWakeSettlementBoundaryTests({
    requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
    spawnVisibleChild,
    emitCompleted,
    waitForDeliveredCleanup,
    getRequesterWakeCalls,
    useGlobalSessionScope: () => {
      const cfg = loadConfigMock();
      loadConfigMock.mockReturnValue({ ...cfg, session: { ...cfg.session, scope: "global" } });
    },
  });
});
