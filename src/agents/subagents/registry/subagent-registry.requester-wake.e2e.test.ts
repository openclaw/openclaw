import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig, type OpenClawConfig } from "../../../config/config.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import {
  loadExactSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { readDescendantSubagentFallbackReply } from "../../../cron/isolated-agent/subagent-followup.js";
import { callGateway } from "../../../gateway/call.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { getAgentEventLifecycleGeneration, onAgentEvent } from "../../../infra/agent-events.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { captureSessionTarget } from "../../../sessions/session-controller.target.js";
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
import { testing as subagentAnnounceDeliveryTesting } from "../announce/subagent-announce-delivery.test-support.js";
import { testing as subagentAnnounceOutputTesting } from "../announce/subagent-announce-output.test-support.js";
import { announceTesting as subagentAnnounceTesting } from "../announce/subagent-announce-overrides.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import * as completionStore from "../completion/subagent-completion-admission.store.js";
import { registerRequesterFinalAttachment } from "../requester-final-attachment.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { buildScopedSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type {
  GatewayRequest,
  SessionStoreEntry,
} from "./subagent-registry.lifecycle-fixture.test-support.js";
import { createLifecycleWaits } from "./subagent-registry.lifecycle-waits.test-support.js";
import {
  createRequesterYieldTool,
  registerRequesterWakeReceiptBoundaryTests,
  visibleChild,
} from "./subagent-registry.requester-wake-receipts.test-support.js";
import {
  createGatewayContext,
  createRequesterWakeSessionFixture,
  holdRequesterWakeResponses,
} from "./subagent-registry.requester-wake-session.test-support.js";
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
let releaseWakeReceipts: (() => void) | undefined;
let requesterHistoryGate:
  | {
      entered: ReturnType<typeof createDeferred<void>>;
      release: ReturnType<typeof createDeferred<void>>;
    }
  | undefined;

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
    if (request.params?.sessionKey === MAIN_REQUESTER_SESSION_KEY && requesterHistoryGate) {
      requesterHistoryGate.entered.resolve();
      await requesterHistoryGate.release.promise;
    }
    return { messages: chatHistoryBySessionKey.get(request.params?.sessionKey ?? "") ?? [] };
  }
  if (request.method === "agent") {
    agentCallObserved.resolve();
    agentCallObserved = createDeferred();
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
  // Subagent settlement below still uses its real SQLite store.
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

// mock-isolation: Wake fixtures supply requester depth without opening a session database.
vi.mock("../spawn/subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
  getSubagentDepthFromSessionStoreInWorker: async () => 0,
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
    const config: OpenClawConfig = {
      agents: {
        defaults: { subagents: { archiveAfterMinutes: 0 } },
        entries: { main: {}, research: {} },
      },
      session: { mainKey: "main", scope: "per-sender" },
    };
    setRuntimeConfigSnapshot(config);
    loadConfigMock.mockReset().mockReturnValue(config);
    callGatewayMock.mockClear();
    vi.mocked(callGateway).mockImplementation(callGatewayMock as typeof callGateway);
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReset();
    vi.mocked(onAgentEvent).mockImplementation((handler) => {
      lifecycleHandler = handler;
      return () => {};
    });
    agentCallGates = new Map();
    agentCallObserved = createDeferred();
    requesterHistoryGate = undefined;
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
    const settle = completionStore.mutateRequesterCompletionBatch;
    vi.spyOn(completionStore, "mutateRequesterCompletionBatch").mockImplementation(
      async (params) => {
        if (params.operation.kind === "settle" && rejectNextRequesterWakePersistence) {
          rejectNextRequesterWakePersistence = false;
          throw new Error("database is locked");
        }
        return settle(params);
      },
    );
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
        target: captureSessionTarget({
          storeScope: sessionStorePath,
          sessionKey: requesterSessionKey,
          incarnation: sessionStore[requesterSessionKey]?.sessionId,
        }),
        isActive: false,
      }),
    });
    subagentAnnounceOutputTesting.setDepsForTest({
      callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
      getRuntimeConfig: loadConfigMock,
      readSubagentSessionEntry: (_storePath, sessionKey) => sessionStore[sessionKey],
      resolveSessionStorePathCore: () => sessionStorePath,
    });
    holdRequesterWakeResponses(agentCallGates, () => emptyGatedAgentReply);
  });

  afterEach(async () => {
    // Failed assertions must also release the delivery owned by this test.
    releaseAgentCallGate?.();
    releaseAgentCallGate = undefined;
    requesterHistoryGate?.release.resolve();
    requesterHistoryGate = undefined;
    releaseWakeReceipts?.();
    releaseWakeReceipts = undefined;
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
      await registry.resetSubagentRegistryForTests({ persist: false });
      vi.useRealTimers();
      vi.restoreAllMocks();
      if (previousFastTestEnv === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
      }
      await testState.cleanup();
      clearRuntimeConfigSnapshot();
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

  const { prepareChildSession, spawnVisibleChild, settleTurn } = createRequesterWakeSessionFixture({
    requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
    getSessionStore: () => sessionStore,
    getSessionStorePath: () => sessionStorePath,
  });

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

  const requesterFixture = {
    requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
    prepareChildSession,
    spawnVisibleChild,
    settleTurn,
    getFixture: () => ({ testState, sessionStore, sessionStorePath }),
    createGatewayContext,
    getLifecycleHandler: () => lifecycleHandler,
    emitCompleted,
    flushOwnedWork,
    waitForDeliveredCleanup,
    waitForAgentCallCount,
    getRequesterWakeCalls,
    getAgentCalls,
    wakeRequester,
  };

  it.each([
    ...["alpha", "beta"].flatMap((firstCompleted) =>
      ["same", "distinct", "mixed-unbound", "yielded"].map((mode) => ({
        firstCompleted,
        binding: mode === "yielded" ? "same" : mode,
        yieldedParent: mode === "yielded" ? "alpha" : undefined,
        rawChild: false,
      })),
    ),
    { firstCompleted: "alpha", binding: "same", yieldedParent: "alpha", rawChild: true },
  ])(
    "settles overlapping caller turns with $firstCompleted first ($binding ownership, yielded=$yieldedParent, raw=$rawChild)",
    async ({ firstCompleted, binding, yieldedParent, rawChild }) => {
      vi.setSystemTime(100_000);
      const context = createGatewayContext();
      const otherContext = createGatewayContext();
      await registry.initSubagentRegistry();
      const activate = async () => {
        // Standalone registration can be wholly unbound, but cannot mix ambient
        // routing with a captured owner. Restored rows have a separate activation gate.
        if (binding !== "mixed-unbound") {
          await registry.activateSubagentRegistry(() => context);
        }
      };
      await activate();
      const children = ["alpha", "beta"].map((name) => ({
        name,
        runId: `run-${name}`,
        childSessionKey: rawChild && name === "alpha" ? "global" : `agent:main:subagent:${name}`,
      }));
      const resolvers: Array<GatewayRequestContext["resolveGatewayContext"]> = [];
      for (const child of children) {
        const sessionEntry = await prepareChildSession(child.childSessionKey, `sess-${child.name}`);
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
                  childAgentId: "main",
                  sessionEntry,
                  requesterTurnRunId,
                  requesterAgentId: "main",
                  expectsCompletionMessage: true,
                  gatewayContextResolver,
                }),
              );
            },
          );
          if (child.name === yieldedParent) {
            await createRequesterYieldTool(MAIN_REQUESTER_SESSION_KEY, requesterTurnRunId).execute(
              `yield-${child.name}`,
              {},
            );
          }
          await registry.settleRequesterAfterSessionSpawns({
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
      await activate();
      await activate();
      children.forEach((child, index) => {
        expect(getGatewayContextResolver(registry.getSubagentRunByRunId(child.runId)!)).toBe(
          resolvers[index],
        );
      });
      const completionOrder = firstCompleted === "alpha" ? children : children.toReversed();
      const first = completionOrder[0]!;
      const second = completionOrder[1]!;
      emitCompleted(first.runId, first.childSessionKey, `${first.name} complete`);
      await flushOwnedWork();
      await waitForDeliveredCleanup(first.runId, {
        allowPendingRequesterSettleWake: first.name !== yieldedParent,
      });
      if (rawChild) {
        const settled = registry.getSubagentRunByRunId(first.runId);
        expect(settled).toMatchObject({
          childAgentId: "main",
          childSessionIdentity: { sessionId: "sess-alpha", lifecycleRevision: "original" },
          execution: { status: "terminal" },
          delivery: { status: "delivered" },
        });
        expect(settled?.execution.suppressSessionEffects).not.toBe(true);
        expect(settled?.requesterSettleWake).toBeUndefined();
        expect(settled?.cleanupCompletedAt).toBeTypeOf("number");
        expect(settled?.browserCleanupDispatchedAt).toBeTypeOf("number");
      }
      expect(registry.getSubagentRunByRunId(second.runId)).toMatchObject({
        execution: { status: "running" },
        delivery: { status: "pending" },
      });
      expect(getRequesterWakeCalls()).toHaveLength(first.name === yieldedParent ? 1 : 0);
      if (first.name === yieldedParent) {
        const wake = getRequesterWakeCalls()[0]?.params;
        expect(wake?.inputProvenance?.sourceSessionKey).toBe(first.childSessionKey);
        expect(wake?.message).toContain(`${first.name} complete`);
        expect(wake?.message).not.toContain(`${second.name} complete`);
        const completed = registry.getSubagentRunByRunId(first.runId)!;
        expect(completed.execution.status).toBe("terminal");
        expect(getGatewayContextResolver(completed)).toBeUndefined();
      }
      await activate();
      await activate();
      children.forEach((child, index) => {
        const row = registry.getSubagentRunByRunId(child.runId)!;
        if (child === first) {
          // Ordinary delivered singletons release their source just like yielded batches.
          expect(getGatewayContextResolver(row)).toBeUndefined();
        } else {
          expect(getGatewayContextResolver(row)).toBe(resolvers[index]);
        }
        expect(row.requesterTurnRunId).toBeUndefined();
      });
      emitCompleted(second.runId, second.childSessionKey, `${second.name} complete`);
      await flushOwnedWork();
      await waitForDeliveredCleanup(second.runId, { allowPendingRequesterSettleWake: true });
      await activate();
      await registry.testing.sweepOnceForTests();
      await vi.advanceTimersByTimeAsync(30_000);
      await flushOwnedWork();
      // Separately delivered singletons do not mint a redundant aggregate continuation.
      expect(getRequesterWakeCalls()).toHaveLength(yieldedParent ? 1 : 0);
      for (const child of children) {
        const entry = registry.getSubagentRunByRunId(child.runId);
        expect(entry).toMatchObject({
          delivery: { status: "delivered" },
        });
        expect(entry?.requesterSettleWake).toBeUndefined();
      }
      if (rawChild) {
        const retained = loadSubagentRegistryFromSqlite().get(first.runId);
        expect(retained).toMatchObject({
          childSessionKey: "global",
          childAgentId: "main",
          delivery: { status: "delivered" },
        });
        expect(retained?.execution.suppressSessionEffects).not.toBe(true);
        expect(retained?.requesterSettleWake).toBeUndefined();
        expect(retained?.cleanupCompletedAt).toBeTypeOf("number");
        expect(retained?.browserCleanupDispatchedAt).toBeTypeOf("number");
        expect(
          loadExactSessionEntryReadOnly({
            agentId: "main",
            storePath: sessionStorePath,
            sessionKey: "global",
          })?.entry,
        ).toMatchObject({ sessionId: "sess-alpha", lifecycleRevision: "original" });
      }
    },
  );

  registerRequesterWakeReceiptBoundaryTests({
    ...requesterFixture,
    sendMessageMock,
    setEmptyReply: (value) => {
      emptyGatedAgentReply = value;
    },
    setWakeRefusal: (wake, persistence) => {
      rejectNextRequesterWake = wake;
      armRequesterWakePersistenceFailure = persistence;
    },
    holdAgentCall: (sessionKey) => {
      agentCallGates.set(
        sessionKey,
        new Promise<void>((resolve) => {
          releaseAgentCallGate = resolve;
        }),
      );
    },
    releaseAgentCall: (sessionKey) => {
      agentCallGates.delete(sessionKey);
      releaseAgentCallGate?.();
    },
    onReceiptsHeld: (release) => {
      releaseWakeReceipts = release;
    },
  });

  it.each([
    { runtime: "cli", attachRequesterFinal: false },
    { runtime: "native", attachRequesterFinal: false },
    { runtime: "cli", attachRequesterFinal: true },
  ] as const)(
    "preserves serial continuation without replaying an accepted wave ($runtime, requester final=$attachRequesterFinal)",
    async ({ runtime, attachRequesterFinal }) => {
      vi.setSystemTime(100_000);
      const context = createGatewayContext();
      await registry.initSubagentRegistry();
      await registry.activateSubagentRegistry(() => context);
      const alpha = visibleChild("serial-alpha");
      const beta = visibleChild("serial-beta");
      const yieldTurn = async (requesterTurnRunId: string, accepted: (typeof alpha)[]) => {
        const result = await createRequesterYieldTool(
          MAIN_REQUESTER_SESSION_KEY,
          requesterTurnRunId,
        ).execute(`yield-${requesterTurnRunId}`, {});
        expect(result).toMatchObject({
          details: { status: accepted.length > 0 ? "yielded" : "nothing_pending" },
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
            const terminal = await resolveEmbeddedRunTerminal(
              makeTerminalInput({ attempt, runParams, agentHarnessId: "codex" }),
            );
            expect(terminal.action).toBe("complete");
            if (terminal.action !== "complete") {
              throw new Error("yielded native requester did not complete its turn");
            }
            const { settleRequesterRun } = await import("../../requester-run-settlement.js");
            await settleRequesterRun(runParams, terminal.result, admission.assertSourceCurrent);
            for (const child of accepted) {
              expect(registry.getSubagentRunByRunId(child.runId)).toMatchObject({
                requesterTurnRunId: undefined,
                requesterSettleWake: {
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
        return settleTurn(requesterTurnRunId, accepted, accepted.length > 0);
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
              const firstEndedAt = registry.getSubagentRunByRunId(alpha.runId)?.execution.endedAt;
              expect(firstEndedAt).toEqual(expect.any(Number));
              vi.setSystemTime(firstEndedAt! + 1);
              await spawnVisibleChild({ ...beta, requesterTurnRunId });
              expect(registry.getSubagentRunByRunId(beta.runId)?.createdAt).toBeGreaterThan(
                firstEndedAt!,
              );
              const result = await yieldTurn(requesterTurnRunId, [beta]);
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
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(getRequesterWakeCalls()).toHaveLength(1);
            expect(visibleFinals).toBe(0);
            expect(append).not.toHaveBeenCalled();
            expect(
              buildScopedSubagentRunReadIndexFromRuns(
                subagentRuns,
                MAIN_REQUESTER_SESSION_KEY,
                "main",
              ).countActiveDescendantRuns(MAIN_REQUESTER_SESSION_KEY),
            ).toBe(1);
            expect(registry.getSubagentRunByRunId(beta.runId)).toMatchObject({
              requesterTurnRunId: undefined,
              requesterSettleWake: {
                batchRunIds: [beta.runId],
                requesterYieldBatch: true,
              },
            });
            emitCompleted(beta.runId, beta.childSessionKey, "beta findings");
            // A transferred obligation must not start an extra parent turn later.
            await flushOwnedWork();
            await vi.advanceTimersByTimeAsync(151_000);
            await registry.testing.sweepOnceForTests();
            await vi.advanceTimersByTimeAsync(0);
            await flushOwnedWork();
            for (const child of [alpha, beta]) {
              await waitForDeliveredCleanup(child.runId);
            }
            expect(
              getRequesterWakeCalls().map(
                (request) => request.params?.inputProvenance?.sourceSessionKey,
              ),
            ).toEqual([alpha.childSessionKey, beta.childSessionKey]);
            expect(visibleFinals).toBe(1);
            expect(sendMessageMock).not.toHaveBeenCalled();
            expect(
              buildScopedSubagentRunReadIndexFromRuns(
                subagentRuns,
                MAIN_REQUESTER_SESSION_KEY,
                "main",
              ).countActiveDescendantRuns(MAIN_REQUESTER_SESSION_KEY),
            ).toBe(0);
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

  it.each([
    { archiveAfterMinutes: 1, retiredAfterMs: 60_000, restart: false },
    // Without an archive deadline, settled delete rows fall back to the five-minute run TTL.
    { archiveAfterMinutes: 0, retiredAfterMs: 5 * 60_000 + 1, restart: true },
  ])(
    "keeps a cron run's delete-cleanup child readable after its settle wake (archive=$archiveAfterMinutes, restart=$restart)",
    async ({ archiveAfterMinutes, retiredAfterMs, restart }) => {
      vi.setSystemTime(100_000);
      const cronRunSessionKey = "agent:main:cron:job-spawn-only:run:sess-cron";
      const child = { runId: "run-cron-child", childSessionKey: "agent:main:subagent:cron-child" };
      const cfg = loadConfigMock();
      loadConfigMock.mockReturnValue({
        ...cfg,
        agents: { ...cfg.agents, defaults: { subagents: { archiveAfterMinutes } } },
      });
      sessionStore[cronRunSessionKey] = { sessionId: "sess-cron", updatedAt: 1 };
      await replaceSessionEntry(
        { storePath: sessionStorePath, sessionKey: cronRunSessionKey },
        sessionStore[cronRunSessionKey],
      );
      const context = createGatewayContext();
      await registry.initSubagentRegistry();
      await registry.activateSubagentRegistry(() => context);
      const sessionEntry = await prepareChildSession(child.childSessionKey, "sess-cron-child");
      await registry.registerSubagentRun(
        createSubagentRunParams({
          ...child,
          sessionEntry,
          requesterSessionKey: cronRunSessionKey,
          requesterDisplayKey: "cron",
          cleanup: "delete",
          expectsCompletionMessage: true,
        }),
      );

      emitCompleted(child.runId, child.childSessionKey, "CRON CHILD ANSWER");
      await flushOwnedWork();
      await vi.waitFor(() => {
        expect(maybeWakeRequesterAfterAllChildrenSettled).toHaveBeenCalledWith(
          expect.objectContaining({
            settledEntry: expect.objectContaining({ runId: child.runId }),
          }),
        );
        expect(registry.getSubagentRunByRunId(child.runId)?.requesterSettleWake).toBeUndefined();
      });
      await flushOwnedWork();
      // Delete cleanup removed the child session; the cron run reads the captured result.
      chatHistoryBySessionKey.delete(child.childSessionKey);
      if (restart) {
        await registry.resetSubagentRegistryForTests({ persist: false });
        await registry.initSubagentRegistry();
        await registry.activateSubagentRegistry(() => context);
        await flushOwnedWork();
      }

      await expect(
        readDescendantSubagentFallbackReply({ sessionKey: cronRunSessionKey, runStartedAt: 0 }),
      ).resolves.toBe("CRON CHILD ANSWER");
      expect(getAgentCalls()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(retiredAfterMs);
      await flushOwnedWork();
      await registry.testing.sweepOnceForTests();
      await flushOwnedWork();
      expect(registry.getSubagentRunByRunId(child.runId)).toBeUndefined();
      expect(getAgentCalls()).toHaveLength(0);
    },
  );

  it("retires a delivered wave while a yielded cohort settles during its evaluation", async () => {
    vi.setSystemTime(100_000);
    const context = createGatewayContext();
    await registry.initSubagentRegistry();
    await registry.activateSubagentRegistry(() => context);
    const wave = ["wave-a", "wave-b"].map(visibleChild);
    const cohort = visibleChild("cohort");
    for (const child of wave) {
      await spawnVisibleChild({ ...child, requesterTurnRunId: "requester-wave" });
    }
    await settleTurn("requester-wave", wave, false);
    await spawnVisibleChild({ ...cohort, requesterTurnRunId: "requester-cohort" });
    await createRequesterYieldTool(MAIN_REQUESTER_SESSION_KEY, "requester-cohort").execute(
      "yield-cohort",
      {},
    );
    await settleTurn("requester-cohort", [cohort], true);
    // Let both results reach the wave before either singleton can retire.
    const alphaPending = createDeferred();
    const releaseAlpha = createDeferred();
    const evaluated = createDeferred<boolean>();
    const release = createDeferred();
    let heldAlpha = false;
    let held = false;
    vi.mocked(maybeWakeRequesterAfterAllChildrenSettled).mockImplementation(async (params) => {
      if (params.settledEntry.runId === wave[0]!.runId && !heldAlpha) {
        heldAlpha = true;
        alphaPending.resolve();
        await releaseAlpha.promise;
      }
      const woke = await wakeRequester(params);
      if (wave.some((child) => child.runId === params.settledEntry.runId) && !held) {
        held = true;
        evaluated.resolve(woke);
        await release.promise;
      }
      return woke;
    });
    try {
      emitCompleted(wave[0]!.runId, wave[0]!.childSessionKey, "wave alpha findings");
      await alphaPending.promise;
      // Hold the grouped evaluation after its delivered wave retires.
      emitCompleted(wave[1]!.runId, wave[1]!.childSessionKey, "wave beta findings");
      await waitForDeliveredCleanup(wave[1]!.runId, { allowPendingRequesterSettleWake: true });
      // Members share one evaluation slot; either member may own the grouped read.
      releaseAlpha.resolve();
      await expect(evaluated.promise).resolves.toBe(false);
      emitCompleted(cohort.runId, cohort.childSessionKey, "cohort findings");
      // The cohort's own wake settles while the wave's evaluation is still held.
      await vi.waitFor(() => {
        expect(registry.getSubagentRunByRunId(cohort.runId)?.requesterSettleWake).toBeUndefined();
        expect(getRequesterWakeCalls()).toHaveLength(1);
      });
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      releaseAlpha.resolve();
      release.resolve();
    }
    await flushOwnedWork();
    expect(
      getRequesterWakeCalls().map((request) => request.params?.inputProvenance?.sourceSessionKey),
    ).toEqual([cohort.childSessionKey]);
    for (const child of wave) {
      expect(registry.getSubagentRunByRunId(child.runId)?.requesterSettleWake).toBeUndefined();
    }
  });

  registerRequesterWakeSettlementBoundaryTests({
    ...requesterFixture,
    callGatewayMock,
    flushAsync,
    setReleaseAgentCallGate: (release) => {
      releaseAgentCallGate = release;
    },
    useGlobalSessionScope: () => {
      const cfg = loadConfigMock();
      loadConfigMock.mockReturnValue({ ...cfg, session: { ...cfg.session, scope: "global" } });
    },
  });
});
