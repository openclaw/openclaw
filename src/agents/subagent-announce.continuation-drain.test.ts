// "RFC §" references herein cite docs/design/continue-work-signal-v2.md (Agent Self-Elected Turn Continuation / CONTINUE_WORK).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentAnnounceDeliveryRuntimeMock } from "./subagent-announce.test-support.js";

// Verify subagent-announce drains the child session's continue_delegate
// queue after the child settles, using the child's inherited chain state
// (not hardcoded 0) so hop labels and cost caps stay accurate for two-hop
// chains.
//
// RFC: docs/design/continue-work-signal-v2.md §3.2, §3.4

type AgentCallRequest = { method?: string; params?: Record<string, unknown> };

const agentSpy = vi.fn(async (_req: AgentCallRequest) => ({ runId: "run-main", status: "ok" }));
const callGatewayMock = vi.fn(async (_request: unknown) => ({}));
const loadSessionStoreMock = vi.fn((_storePath: string) => ({}) as Record<string, unknown>);
// #1144: controllable so a test can force the child chain-cost persist to fail
// and exercise the in-memory fallback fold. Default routes the mutator through
// the same in-memory store the drain reads.
const updateSessionStoreMock = vi.fn(
  async (storePath: string, mutator: (store: Record<string, unknown>) => unknown) =>
    await mutator(loadSessionStoreMock(storePath) as Record<string, unknown>),
);
const resolveAgentIdFromSessionKeyMock = vi.fn((sessionKey: string) => {
  return sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main";
});
const resolveStorePathMock = vi.fn((_store: unknown, _options: unknown) => "/tmp/sessions.json");
const resolveMainSessionKeyMock = vi.fn((_cfg: unknown) => "agent:main:main");
const isEmbeddedAgentRunActiveMock = vi.fn((_sessionId: string) => false);
const queueEmbeddedAgentMessageMock = vi.fn((_sessionId: string, _text: string) => false);
const waitForEmbeddedAgentRunEndMock = vi.fn(
  async (_sessionId: string, _timeoutMs?: number) => true,
);
const validTraceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

const dispatchToolDelegatesMock = vi.fn(
  async (
    _params: unknown,
  ): Promise<{
    dispatched: number;
    rejected: number;
    chainState?: {
      currentChainCount: number;
      chainStartedAt: number;
      accumulatedChainTokens: number;
    };
  }> => ({
    dispatched: 0,
    rejected: 0,
  }),
);

// In-function tool-delegate chain-hop coverage: feed consumePendingDelegates so
// runSubagentAnnounceFlow's own drain loop (sibling to drainChildContinuationQueue)
// runs, and capture the spawn it issues to assert model propagation.
type ConsumedToolDelegate = { task: string; model?: string };
const consumePendingDelegatesMock = vi.fn((_sessionKey: string): ConsumedToolDelegate[] => []);
const markPendingDelegateFailedMock = vi.fn();
// #1144: capture durable delayed-bracket delegate enqueues (replaces the old
// volatile setTimeout path).
const enqueuePendingDelegateMock = vi.fn((_sessionKey: string, _delegate: unknown) => {});
const spawnSubagentDirectMock = vi.fn(async (_params: Record<string, unknown>, _ctx: unknown) => ({
  status: "accepted" as const,
  childSessionKey: "agent:main:subagent:grandchild",
  runId: "run-grandchild",
}));
const resolveContinuationRuntimeConfigMock = vi.fn((_cfg?: unknown) => ({
  enabled: true,
  defaultDelayMs: 15_000,
  minDelayMs: 5_000,
  maxDelayMs: 300_000,
  maxChainLength: 10,
  costCapTokens: 500_000,
  maxDelegatesPerTurn: 5,
  contextPressureThreshold: undefined,
}));

let mockConfig: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: { mainKey: "main", scope: "per-sender" },
};

const { continuationTargetingMock, subagentRegistryRuntimeMock, deliverSubagentAnnouncementMock } =
  vi.hoisted(() => ({
    continuationTargetingMock: {
      CONTINUATION_DELEGATE_FANOUT_MODES: ["tree", "all"] as const,
      enqueueContinuationReturnDeliveries: vi.fn(async (_params: unknown) => ({
        enqueued: 0,
        delivered: 0,
        deliveryIds: [],
      })),
      normalizeContinuationTargetKey: (value?: string) => {
        const trimmed = value?.trim();
        return trimmed || undefined;
      },
      normalizeContinuationTargetKeys: (values?: readonly string[]) => {
        const seen = new Set<string>();
        const keys: string[] = [];
        for (const value of values ?? []) {
          const trimmed = value.trim();
          if (!trimmed || seen.has(trimmed)) {
            continue;
          }
          seen.add(trimmed);
          keys.push(trimmed);
        }
        return keys;
      },
      hasContinuationDelegateTargeting: () => false,
      resolveContinuationReturnTargetSessionKeys: vi.fn((params: Record<string, unknown>) => {
        if (Array.isArray(params.targetSessionKeys)) {
          return params.targetSessionKeys;
        }
        if (typeof params.targetSessionKey === "string") {
          return [params.targetSessionKey];
        }
        if (Array.isArray(params.treeSessionKeys)) {
          return params.treeSessionKeys;
        }
        if (Array.isArray(params.allSessionKeys)) {
          return params.allSessionKeys;
        }
        return typeof params.defaultSessionKey === "string" ? [params.defaultSessionKey] : [];
      }),
    },
    subagentRegistryRuntimeMock: {
      shouldIgnorePostCompletionAnnounceForSession: vi.fn(() => false),
      isSubagentSessionRunActive: vi.fn(() => true),
      countActiveDescendantRuns: vi.fn(() => 0),
      countPendingDescendantRuns: vi.fn(() => 0),
      countPendingDescendantRunsExcludingRun: vi.fn(() => 0),
      listAncestorSessionKeys: vi.fn(() => []),
      listSubagentRunsForRequester: vi.fn(() => []),
      replaceSubagentRunAfterSteer: vi.fn(() => true),
      resolveRequesterForChildSession: vi.fn(() => null),
    },
    deliverSubagentAnnouncementMock: vi.fn(async () => ({ delivered: true, path: "direct" })),
  }));

vi.mock("./subagent-announce.runtime.js", () => ({
  callGateway: (request: unknown) => callGatewayMock(request),
  dispatchGatewayMethodInProcess: vi.fn(),
  getRuntimeConfig: () => mockConfig,
  isEmbeddedAgentRunActive: (sessionId: string) => isEmbeddedAgentRunActiveMock(sessionId),
  loadConfig: () => mockConfig,
  loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
  readSessionMessagesAsync: vi.fn(async () => []),
  readSessionEntry: (storePath: string, sessionKey: string) => {
    const store = loadSessionStoreMock(storePath) as Record<string, unknown> | undefined;
    return store?.[sessionKey];
  },
  resolveContinuationRuntimeConfig: (cfg?: unknown) => resolveContinuationRuntimeConfigMock(cfg),
  queueEmbeddedAgentMessage: (sessionId: string, text: string) =>
    queueEmbeddedAgentMessageMock(sessionId, text),
  resolveAgentIdFromSessionKey: (sessionKey: string) =>
    resolveAgentIdFromSessionKeyMock(sessionKey),
  resolveMainSessionKey: (cfg: unknown) => resolveMainSessionKeyMock(cfg),
  resolveStorePath: (store: unknown, options: unknown) => resolveStorePathMock(store, options),
  waitForEmbeddedAgentRunEnd: (sessionId: string, timeoutMs?: number) =>
    waitForEmbeddedAgentRunEndMock(sessionId, timeoutMs),
}));

vi.mock("./subagent-announce-delivery.runtime.js", () =>
  createSubagentAnnounceDeliveryRuntimeMock({
    callGateway: (request: unknown) => callGatewayMock(request),
    dispatchGatewayMethodInProcess: vi.fn(),
    getRuntimeConfig: () => mockConfig,
    loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
    resolveAgentIdFromSessionKey: (sessionKey: string) =>
      resolveAgentIdFromSessionKeyMock(sessionKey),
    resolveMainSessionKey: (cfg: unknown) => resolveMainSessionKeyMock(cfg),
    resolveStorePath: (store: unknown, options: unknown) => resolveStorePathMock(store, options),
    isEmbeddedAgentRunActive: (sessionId: string) => isEmbeddedAgentRunActiveMock(sessionId),
    queueEmbeddedAgentMessageWithOutcome: (sessionId: string, text: string) => {
      const queued = queueEmbeddedAgentMessageMock(sessionId, text);
      return queued
        ? {
            queued: true as const,
            sessionId,
            target: "reply_run" as const,
            gatewayHealth: "live" as const,
          }
        : {
            queued: false as const,
            sessionId,
            reason: "no_active_run" as const,
            gatewayHealth: "live" as const,
          };
    },
  }),
);

vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: deliverSubagentAnnouncementMock,
  loadRequesterSessionEntry: (sessionKey: string) => {
    const store = loadSessionStoreMock("/tmp/sessions.json");
    return { entry: store?.[sessionKey] };
  },
  loadSessionEntryByKey: (sessionKey: string) => {
    const store = loadSessionStoreMock("/tmp/sessions.json");
    return store?.[sessionKey];
  },
  resolveAnnounceOrigin: (
    _entry: unknown,
    requesterOrigin?: { channel?: string; to?: string; accountId?: string; threadId?: string },
  ) => requesterOrigin ?? {},
  resolveSubagentCompletionOrigin: async (params: { requesterOrigin?: unknown }) =>
    params.requesterOrigin,
  resolveSubagentAnnounceTimeoutMs: () => 10_000,
  runAnnounceDeliveryWithRetry: async <T>(params: { run: () => Promise<T> }) => await params.run(),
}));

vi.mock("./subagent-announce.registry.runtime.js", () => subagentRegistryRuntimeMock);

vi.mock("../auto-reply/continuation/delegate-dispatch.js", () => ({
  dispatchToolDelegates: (params: unknown) => dispatchToolDelegatesMock(params),
}));

// Feed the in-function tool-delegate drain (subagent-announce.ts) and capture
// its spawn. `consumePendingDelegates` is mocked on the canonical store module
// (not the barrel shim) because the forks pool does not intercept barrel
// re-exports; the shim forwards the canonical binding.
vi.mock("../auto-reply/continuation/delegate-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auto-reply/continuation/delegate-store.js")>()),
  consumePendingDelegates: (sessionKey: string) => consumePendingDelegatesMock(sessionKey),
  markPendingDelegateFailed: (...args: unknown[]) => markPendingDelegateFailedMock(...args),
  enqueuePendingDelegate: (sessionKey: string, delegate: unknown) =>
    enqueuePendingDelegateMock(sessionKey, delegate),
}));

vi.mock("./subagent-spawn.js", () => ({
  spawnSubagentDirect: (params: Record<string, unknown>, ctx: unknown) =>
    spawnSubagentDirectMock(params, ctx),
}));

vi.mock("../auto-reply/continuation/config.js", () => ({
  resolveContinuationRuntimeConfig: (cfg?: unknown) => resolveContinuationRuntimeConfigMock(cfg),
}));

vi.mock("../auto-reply/continuation/targeting.js", () => continuationTargetingMock);

vi.mock("../config/sessions/targets.js", () => ({
  resolveAllAgentSessionStoreTargetsSync: () => [{ storePath: "/tmp/sessions.json" }],
}));

vi.mock("../config/sessions/store-load.js", () => ({
  loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
}));

// #1144: the settle-time chain-token accumulation persists the child's own run
// cost into the child entry's durable `continuationChainTokens` via
// `updateSessionStore` (from the `../config/sessions.js` barrel). Route it
// through the same in-memory store the drain reads so the persisted post-run
// cost basis is observable end-to-end. Only the accumulation block calls this,
// and only when the child spent tokens, so tests without child token data are
// unaffected.
vi.mock("../config/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions.js")>()),
  updateSessionStore: (storePath: string, mutator: (store: Record<string, unknown>) => unknown) =>
    updateSessionStoreMock(storePath, mutator),
}));

import { runSubagentAnnounceFlow } from "./subagent-announce.js";

describe("subagent-announce continuation drain (F7)", () => {
  beforeEach(() => {
    agentSpy.mockClear();
    callGatewayMock.mockReset().mockImplementation(async () => ({}));
    dispatchToolDelegatesMock.mockReset().mockResolvedValue({ dispatched: 0, rejected: 0 });
    resolveContinuationRuntimeConfigMock.mockReset().mockImplementation((_cfg?: unknown) => ({
      enabled: true,
      defaultDelayMs: 15_000,
      minDelayMs: 5_000,
      maxDelayMs: 300_000,
      maxChainLength: 10,
      costCapTokens: 500_000,
      maxDelegatesPerTurn: 5,
      contextPressureThreshold: undefined,
    }));
    loadSessionStoreMock.mockReset().mockImplementation(() => ({}));
    updateSessionStoreMock
      .mockReset()
      .mockImplementation(
        async (storePath: string, mutator: (store: Record<string, unknown>) => unknown) =>
          await mutator(loadSessionStoreMock(storePath) as Record<string, unknown>),
      );
    resolveAgentIdFromSessionKeyMock.mockReset().mockImplementation(() => "main");
    resolveStorePathMock.mockReset().mockImplementation(() => "/tmp/sessions.json");
    resolveMainSessionKeyMock.mockReset().mockImplementation(() => "agent:main:main");
    isEmbeddedAgentRunActiveMock.mockReset().mockReturnValue(false);
    queueEmbeddedAgentMessageMock.mockReset().mockReturnValue(false);
    waitForEmbeddedAgentRunEndMock.mockReset().mockResolvedValue(true);
    mockConfig = {
      agents: { defaults: { continuation: { enabled: true } } },
      session: { mainKey: "main", scope: "per-sender" },
    };
    subagentRegistryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession
      .mockReset()
      .mockReturnValue(false);
    subagentRegistryRuntimeMock.isSubagentSessionRunActive.mockReset().mockReturnValue(true);
    subagentRegistryRuntimeMock.countPendingDescendantRuns.mockReset().mockReturnValue(0);
    subagentRegistryRuntimeMock.listAncestorSessionKeys.mockReset().mockReturnValue([]);
    subagentRegistryRuntimeMock.listSubagentRunsForRequester.mockReset().mockReturnValue([]);
    subagentRegistryRuntimeMock.resolveRequesterForChildSession.mockReset().mockReturnValue(null);
    continuationTargetingMock.enqueueContinuationReturnDeliveries.mockReset().mockResolvedValue({
      enqueued: 0,
      delivered: 0,
      deliveryIds: [],
    });
    continuationTargetingMock.resolveContinuationReturnTargetSessionKeys
      .mockReset()
      .mockImplementation((params: Record<string, unknown>) => {
        if (Array.isArray(params.targetSessionKeys)) {
          return params.targetSessionKeys;
        }
        if (typeof params.targetSessionKey === "string") {
          return [params.targetSessionKey];
        }
        if (Array.isArray(params.treeSessionKeys)) {
          return params.treeSessionKeys;
        }
        if (Array.isArray(params.allSessionKeys)) {
          return params.allSessionKeys;
        }
        return typeof params.defaultSessionKey === "string" ? [params.defaultSessionKey] : [];
      });
    deliverSubagentAnnouncementMock
      .mockReset()
      .mockResolvedValue({ delivered: true, path: "direct" });
    consumePendingDelegatesMock.mockReset().mockReturnValue([]);
    markPendingDelegateFailedMock.mockReset();
    enqueuePendingDelegateMock.mockReset();
    spawnSubagentDirectMock.mockReset().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:grandchild",
      runId: "run-grandchild",
    });
  });

  it("drains the child session's continue_delegate queue using inherited chain state", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:test": {
            sessionId: "session-child",
            updatedAt: Date.now(),
            continuationChainCount: 1,
            continuationChainStartedAt: 1_700_000_000_000,
            continuationChainTokens: 5_000,
          },
          "agent:main:main": {
            sessionId: "session-main",
            updatedAt: Date.now(),
          },
        }) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-chain-hop",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "chain hop task",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    expect(dispatchToolDelegatesMock).toHaveBeenCalledTimes(1);
    const call = dispatchToolDelegatesMock.mock.calls[0]?.[0] as {
      sessionKey?: string;
      chainState?: {
        currentChainCount?: number;
        chainStartedAt?: number;
        accumulatedChainTokens?: number;
      };
      ctx?: { sessionKey?: string };
      maxChainLength?: number;
    };

    // Dispatch targets the CHILD session's queue so delegates the subagent
    // enqueued via continue_delegate during its turn are consumed.
    expect(call?.sessionKey).toBe("agent:main:subagent:test");
    expect(call?.ctx?.sessionKey).toBe("agent:main:subagent:test");

    // Chain state must be inherited from the child session entry — NOT
    // hardcoded zero. Hop labels depend on this to stay sequential.
    expect(call?.chainState?.currentChainCount).toBe(1);
    expect(call?.chainState?.chainStartedAt).toBe(1_700_000_000_000);
    expect(call?.chainState?.accumulatedChainTokens).toBe(5_000);
    expect(call?.maxChainLength).toBe(10);
  });

  it("defaults chain state to 0 when child session has no chain fields", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:leaf": {
            sessionId: "session-leaf",
            updatedAt: Date.now(),
          },
          "agent:main:main": {
            sessionId: "session-main",
            updatedAt: Date.now(),
          },
        }) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:leaf",
      childRunId: "run-leaf",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "leaf task",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    expect(dispatchToolDelegatesMock).toHaveBeenCalledTimes(1);
    const call = dispatchToolDelegatesMock.mock.calls[0]?.[0] as {
      chainState?: { currentChainCount?: number; accumulatedChainTokens?: number };
    };
    expect(call?.chainState?.currentChainCount).toBe(0);
    expect(call?.chainState?.accumulatedChainTokens).toBe(0);
  });

  it("does not dispatch when continuation is disabled", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
    };
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:test": {
            sessionId: "session-child",
            updatedAt: Date.now(),
            continuationChainCount: 1,
          },
        }) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-disabled",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "test",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    expect(dispatchToolDelegatesMock).not.toHaveBeenCalled();
  });

  it("does not fail the announce when dispatch throws", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:test": {
            sessionId: "session-child",
            updatedAt: Date.now(),
          },
          "agent:main:main": {
            sessionId: "session-main",
            updatedAt: Date.now(),
          },
        }) as Record<string, unknown>,
    );
    dispatchToolDelegatesMock.mockRejectedValueOnce(new Error("spawn failed"));

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-dispatch-error",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "test",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    expect(dispatchToolDelegatesMock).toHaveBeenCalledTimes(1);
    // Dispatch failure must not break the announce path — it is best-effort.
    expect(didAnnounce).toBe(true);
  });

  it("persists advanced child chain state after delegates dispatched", async () => {
    // `drainChildContinuationQueue` must consume
    // the `chainState` returned by `dispatchToolDelegates` (advanced past
    // the dispatched hops) and write it back to both the in-memory child
    // entry AND the durable session store. Without this, the next drain
    // reloads stale counters and `maxChainLength` enforcement breaks.
    const childEntry = {
      sessionId: "session-child",
      updatedAt: Date.now(),
      continuationChainCount: 1,
      continuationChainStartedAt: 1_700_000_000_000,
      continuationChainTokens: 5_000,
    };
    const store: Record<string, Record<string, unknown>> = {
      "agent:main:subagent:test": childEntry,
      "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
    };
    loadSessionStoreMock.mockImplementation(() => store as unknown as Record<string, unknown>);

    dispatchToolDelegatesMock.mockResolvedValueOnce({
      dispatched: 2,
      rejected: 0,
      chainState: {
        currentChainCount: 3,
        chainStartedAt: 1_700_000_000_000,
        accumulatedChainTokens: 12_500,
      },
    });

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-persist",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persist test",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    // In-memory child entry must reflect the advanced chain state so any
    // post-drain readers (e.g. a second drain on the same entry) see fresh
    // counters rather than the pre-dispatch snapshot.
    expect(childEntry.continuationChainCount).toBe(3);
    expect(childEntry.continuationChainStartedAt).toBe(1_700_000_000_000);
    expect(childEntry.continuationChainTokens).toBe(12_500);
  });

  it("skips persist when no delegates dispatched", async () => {
    // Negative case: when `dispatched` is 0, the chain state is unchanged
    // and we must not re-write the entry (avoid spurious `updatedAt` churn
    // and unnecessary store I/O).
    const childEntry = {
      sessionId: "session-child",
      updatedAt: Date.now(),
      continuationChainCount: 1,
      continuationChainStartedAt: 1_700_000_000_000,
      continuationChainTokens: 5_000,
    };
    const store: Record<string, Record<string, unknown>> = {
      "agent:main:subagent:test": childEntry,
      "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
    };
    loadSessionStoreMock.mockImplementation(() => store as unknown as Record<string, unknown>);

    dispatchToolDelegatesMock.mockResolvedValueOnce({
      dispatched: 0,
      rejected: 0,
      chainState: {
        currentChainCount: 1,
        chainStartedAt: 1_700_000_000_000,
        accumulatedChainTokens: 5_000,
      },
    });

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-no-dispatch",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "no dispatch test",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    // Counter unchanged — no advance to persist.
    expect(childEntry.continuationChainCount).toBe(1);
    expect(childEntry.continuationChainTokens).toBe(5_000);
  });

  it("threads targeted returns through the session-delivery fanout helper", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:test": {
            sessionId: "session-child",
            updatedAt: Date.now(),
          },
          "agent:main:main": {
            sessionId: "session-main",
            updatedAt: Date.now(),
          },
        }) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-targeted",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] targeted task",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "targeted result",
      continuationTargetSessionKeys: ["agent:main:root", "agent:main:sibling"],
    });

    expect(
      continuationTargetingMock.resolveContinuationReturnTargetSessionKeys,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultSessionKey: "agent:main:main",
        targetSessionKeys: ["agent:main:root", "agent:main:sibling"],
      }),
    );
    expect(continuationTargetingMock.enqueueContinuationReturnDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionKeys: ["agent:main:root", "agent:main:sibling"],
        idempotencyKeyBase: expect.stringContaining("continuation-return:"),
        wakeRecipients: true,
        childRunId: "run-targeted",
      }),
    );
  });

  // Regression test for the targeted-return branch-entry path:
  // continue_delegate({ targetSessionKey: "agent:main:main", mode: "silent-wake" })
  // must route the return to the named single target, not to the dispatcher.
  // Plural `continuationTargetSessionKeys` form is exercised above; this test
  // pins the singular form's path through the same announce-return seam.
  //
  // This test pins the branch-entry contract. The I/O-level
  // enqueue-without-immediate-ack contract is pinned by
  // `cross-session-targeting.test.ts` against the real
  // `enqueueContinuationReturnDeliveries` with mocked deps.
  it("routes singular continuationTargetSessionKey to the named recipient (not dispatcher)", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:test": {
            sessionId: "session-child",
            updatedAt: Date.now(),
          },
          "agent:main:test:channel:CHANNEL_A": {
            sessionId: "session-dispatcher",
            updatedAt: Date.now(),
          },
          "agent:main:main": {
            sessionId: "session-target",
            updatedAt: Date.now(),
          },
        }) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-singular-targeted",
      requesterSessionKey: "agent:main:test:channel:CHANNEL_A",
      requesterDisplayKey: "discord-channel",
      task: "[continuation:chain-hop:1] OV-1 fire-1 reproduction",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "received delegate at agent:main:main",
      silentAnnounce: true,
      wakeOnReturn: true,
      continuationTargetSessionKey: "agent:main:main",
    });

    // The resolver must see the singular targetSessionKey (not the
    // dispatcher's session) and the dispatcher only as the fallback default.
    expect(
      continuationTargetingMock.resolveContinuationReturnTargetSessionKeys,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultSessionKey: "agent:main:test:channel:CHANNEL_A",
        targetSessionKey: "agent:main:main",
      }),
    );
    // The enqueue must target the named recipient ONLY — not the dispatcher.
    expect(continuationTargetingMock.enqueueContinuationReturnDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionKeys: ["agent:main:main"],
        wakeRecipients: true,
        childRunId: "run-singular-targeted",
      }),
    );
    const enqueueCall =
      continuationTargetingMock.enqueueContinuationReturnDeliveries.mock.calls[0]?.[0];
    expect((enqueueCall as { targetSessionKeys: string[] })?.targetSessionKeys).not.toContain(
      "agent:main:test:channel:CHANNEL_A",
    );
    // Idempotency-key shape carries an index + sessionKey suffix per RFC §6.7
    // so the durable session-delivery-queue file under the recipient's key
    // resolves to a stable hash that the recovery loop can replay
    // post-restart. The actual file-write + ack-skip behavior is exercised
    // against the real `enqueueContinuationReturnDeliveries` in
    // `cross-session-targeting.test.ts`.
    expect((enqueueCall as { idempotencyKeyBase: string })?.idempotencyKeyBase).toMatch(
      /^continuation-return:/,
    );
  });

  it("fanoutMode=all spends one chain step per completion, not per recipient", async () => {
    const knownSessionKeys = [
      "agent:main:main",
      "agent:main:subagent:test",
      ...Array.from({ length: 48 }, (_, index) => `agent:main:recipient-${index}`),
    ];
    loadSessionStoreMock.mockImplementation(
      () =>
        Object.fromEntries(
          knownSessionKeys.map((sessionKey) => [
            sessionKey,
            {
              sessionId: `session-${sessionKey}`,
              updatedAt: Date.now(),
            },
          ]),
        ) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-fanout",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] fanout task",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "fanout result",
      continuationFanoutMode: "all",
      traceparent: validTraceparent,
    });

    const call = continuationTargetingMock.enqueueContinuationReturnDeliveries.mock
      .calls[0]?.[0] as
      | {
          targetSessionKeys?: string[];
          fanoutMode?: string;
          chainStepRemaining?: number;
          traceparent?: string;
        }
      | undefined;
    expect(call?.targetSessionKeys).toHaveLength(50);
    expect(call?.fanoutMode).toBe("all");
    expect(call?.chainStepRemaining).toBe(9);
    expect(call?.traceparent).toBe(validTraceparent);
  });

  it("drops return traceparent once the completion exhausts chain-step budget", async () => {
    resolveContinuationRuntimeConfigMock.mockImplementation((_cfg?: unknown) => ({
      enabled: true,
      defaultDelayMs: 15_000,
      minDelayMs: 5_000,
      maxDelayMs: 300_000,
      maxChainLength: 2,
      costCapTokens: 500_000,
      maxDelegatesPerTurn: 5,
      contextPressureThreshold: undefined,
    }));
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:test": {
            sessionId: "session-child",
            updatedAt: Date.now(),
          },
          "agent:main:main": {
            sessionId: "session-main",
            updatedAt: Date.now(),
          },
        }) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-capped",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:2] capped targeted task",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "targeted result",
      continuationTargetSessionKeys: ["agent:main:root", "agent:main:sibling"],
      traceparent: validTraceparent,
    });

    expect(continuationTargetingMock.enqueueContinuationReturnDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionKeys: ["agent:main:root", "agent:main:sibling"],
        chainStepRemaining: 0,
      }),
    );
    expect(continuationTargetingMock.enqueueContinuationReturnDeliveries).toHaveBeenCalledWith(
      expect.not.objectContaining({ traceparent: expect.any(String) }),
    );
  });

  // #989-P2: the trigger minted on the direct-announce path must distinguish an
  // ordinary inter-session subagent completion from an actual continuation-chain
  // hop. Ordinary completions are external turn-entries and must reset the
  // chain budget downstream; only `[continuation:chain-hop:N]` returns are
  // mid-chain wakes that preserve the runaway leash.
  it("tags an ordinary subagent completion with continuationTrigger=subagent-return", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:ordinary": {
            sessionId: "session-child",
            updatedAt: Date.now(),
            inputTokens: 0,
            outputTokens: 0,
          },
          "agent:main:main": {
            sessionId: "session-main",
            updatedAt: Date.now(),
          },
        }) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:ordinary",
      childRunId: "run-ordinary",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "ordinary inter-session subagent task",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    expect(deliverSubagentAnnouncementMock).toHaveBeenCalledWith(
      expect.objectContaining({ continuationTriggerOverride: "subagent-return" }),
    );
  });

  it("tags an in-chain continuation-chain-hop return with continuationTrigger=delegate-return", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:hop": {
            sessionId: "session-child",
            updatedAt: Date.now(),
            inputTokens: 0,
            outputTokens: 0,
          },
          "agent:main:main": {
            sessionId: "session-main",
            updatedAt: Date.now(),
          },
        }) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:hop",
      childRunId: "run-hop",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Delegated from sub-agent: keep working",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    expect(deliverSubagentAnnouncementMock).toHaveBeenCalledWith(
      expect.objectContaining({ continuationTriggerOverride: "delegate-return" }),
    );
  });

  it("persists the settled child's run tokens into the child's durable chain cost before dispatch (#1144)", async () => {
    // A chain-hop child that spent tokens this turn must have those tokens
    // folded into its OWN durable `continuationChainTokens` BEFORE queued child
    // delegates spawn — persisted to the child entry, not just held in memory.
    // The child is the durable owner of any delayed delegate it queues, so
    // restart recovery re-drives that delegate from this persisted value; a
    // stale (pre-run) basis would let a child run that already blew past
    // costCapTokens launch another hop after a restart.
    const childEntry = {
      sessionId: "session-child",
      updatedAt: Date.now(),
      continuationChainCount: 1,
      continuationChainStartedAt: 1_700_000_000_000,
      continuationChainTokens: 5_000,
      // The child's just-completed run cost (input + output).
      inputTokens: 300_000,
      outputTokens: 250_000,
    };
    const store: Record<string, Record<string, unknown>> = {
      "agent:main:subagent:cost": childEntry,
      "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
    };
    loadSessionStoreMock.mockImplementation(() => store as unknown as Record<string, unknown>);

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:cost",
      childRunId: "run-cost",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Delegated from sub-agent: keep working",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    // The child's own run cost is folded into the CHILD entry's durable chain
    // total: 5_000 inherited + (300_000 + 250_000) run = 555_000. Restart
    // recovery re-drives child-queued delegates from this persisted value.
    expect(childEntry.continuationChainTokens).toBe(555_000);

    // The live drain reads that same persisted basis (no separate in-memory
    // fold), so the dispatcher sees 555_000 — over costCapTokens (500_000) — and
    // the real dispatcher would reject the hop.
    expect(dispatchToolDelegatesMock).toHaveBeenCalledTimes(1);
    const call = dispatchToolDelegatesMock.mock.calls[0]?.[0] as {
      chainState?: { accumulatedChainTokens?: number };
    };
    expect(call?.chainState?.accumulatedChainTokens).toBe(555_000);
    expect(call?.chainState?.accumulatedChainTokens).toBeGreaterThan(500_000);
  });

  it("folds the child run cost into the live drain basis when the durable persist fails (#1144)", async () => {
    // If the durable child chain-cost persist throws, the drain must NOT fall
    // through to the stale persisted basis. The run cost is folded into the
    // drain's in-memory cost basis instead so the cost cap still enforces
    // against the post-run total (fails closed).
    const childEntry = {
      sessionId: "session-child",
      updatedAt: Date.now(),
      continuationChainCount: 1,
      continuationChainStartedAt: 1_700_000_000_000,
      continuationChainTokens: 5_000,
      inputTokens: 300_000,
      outputTokens: 250_000,
    };
    const store: Record<string, Record<string, unknown>> = {
      "agent:main:subagent:cost-fail": childEntry,
      "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
    };
    loadSessionStoreMock.mockImplementation(() => store as unknown as Record<string, unknown>);
    // Force every chain-cost persist (parent + child) to fail.
    updateSessionStoreMock.mockRejectedValue(new Error("session store write failed"));

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:cost-fail",
      childRunId: "run-cost-fail",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Delegated from sub-agent: keep working",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    // Persist failed, so the durable child entry is unchanged (stale pre-run).
    expect(childEntry.continuationChainTokens).toBe(5_000);
    // But the live drain still enforces against the post-run total via the
    // in-memory fallback fold: 5_000 + (300_000 + 250_000) = 555_000.
    expect(dispatchToolDelegatesMock).toHaveBeenCalledTimes(1);
    const call = dispatchToolDelegatesMock.mock.calls[0]?.[0] as {
      chainState?: { accumulatedChainTokens?: number };
      dispatchQueuedRegardlessOfDelay?: boolean;
    };
    expect(call?.chainState?.accumulatedChainTokens).toBe(555_000);
    expect(call?.chainState?.accumulatedChainTokens).toBeGreaterThan(500_000);
    // Persist failed → force-dispatch queued delegates immediately so a delayed
    // one is not left durably queued to recover on the stale child basis.
    expect(call?.dispatchQueuedRegardlessOfDelay).toBe(true);
  });

  it("routes a delayed bracket delegate through the durable pending store, not a volatile timer (#1144)", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:bracket": {
            sessionId: "session-child",
            updatedAt: Date.now(),
            continuationChainCount: 1,
            continuationChainStartedAt: 1_700_000_000_000,
            continuationChainTokens: 1_000,
          },
          "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
        }) as Record<string, unknown>,
    );

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:bracket",
      childRunId: "run-bracket",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Delegated from sub-agent: keep working",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      // A delayed bracket delegate (+30s) emitted by the settled child.
      roundOneReply: "Research result.\n[[CONTINUE_DELEGATE: keep working +30s]]",
    });

    // The delayed bracket delegate is persisted under the CHILD session (same
    // queue + chain-state owner as tool delegates) with its delay — it survives
    // a restart before the delay elapses and preserves the child's hop/cost.
    expect(enqueuePendingDelegateMock).toHaveBeenCalledTimes(1);
    const [enqueueSessionKey, enqueued] = enqueuePendingDelegateMock.mock.calls[0] as [
      string,
      { task: string; delayMs?: number },
    ];
    expect(enqueueSessionKey).toBe("agent:main:subagent:bracket");
    expect(enqueued.task).toBe("keep working");
    expect(enqueued.delayMs).toBe(30_000);

    // It must NOT be spawned immediately via a volatile in-process path.
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("spawns a delayed bracket delegate immediately (no durable enqueue) when the child chain-cost persist fails (#1144)", async () => {
    const store: Record<string, Record<string, unknown>> = {
      "agent:main:subagent:bracket-fail": {
        sessionId: "session-child",
        updatedAt: Date.now(),
        continuationChainCount: 1,
        continuationChainStartedAt: 1_700_000_000_000,
        continuationChainTokens: 1_000,
        inputTokens: 10_000,
        outputTokens: 20_000,
      },
      "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
    };
    loadSessionStoreMock.mockImplementation(() => store as unknown as Record<string, unknown>);
    // The child chain-cost persist throws, so the run-cost fallback lives only in
    // memory for this drain and cannot survive a restart.
    updateSessionStoreMock.mockRejectedValue(new Error("session store write failed"));

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:bracket-fail",
      childRunId: "run-bracket-fail",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Delegated from sub-agent: keep working",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "Research result.\n[[CONTINUE_DELEGATE: keep working +30s]]",
    });

    // Fail closed: a durable delayed delegate would recover from the stale child
    // entry and under-enforce the cost cap, so the hop is spawned immediately via
    // the in-process path (correct live folded cost basis) and NOT enqueued
    // durably where restart recovery could re-drive it on stale cost.
    expect(enqueuePendingDelegateMock).not.toHaveBeenCalled();
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a bracket delegate when the parent chain-cost persist fails and the folded basis exceeds the cap (#1144)", async () => {
    const store: Record<string, Record<string, unknown>> = {
      "agent:main:subagent:bracket-guard": {
        sessionId: "session-child",
        updatedAt: Date.now(),
        continuationChainCount: 1,
        continuationChainStartedAt: 1_700_000_000_000,
        continuationChainTokens: 1_000,
        inputTokens: 150_000,
        outputTokens: 100_000,
      },
      // Parent chain cost is UNDER the cap without the run fold, OVER with it.
      "agent:main:main": {
        sessionId: "session-main",
        updatedAt: Date.now(),
        continuationChainTokens: 300_000,
      },
    };
    loadSessionStoreMock.mockImplementation(() => store as unknown as Record<string, unknown>);
    // Parent-entry persist throws, so the guard's requester basis stays stale.
    updateSessionStoreMock.mockRejectedValue(new Error("session store write failed"));

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:bracket-guard",
      childRunId: "run-bracket-guard",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Delegated from sub-agent: keep working",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "Research result.\n[[CONTINUE_DELEGATE: keep working +30s]]",
    });

    // Parent persist failed → the guard folds the run cost: 300_000 + (150_000 +
    // 100_000) = 550_000 > costCapTokens (500_000) → rejected. The bracket must
    // NOT spawn (immediate) or enqueue (durable) on the stale pre-run basis.
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(enqueuePendingDelegateMock).not.toHaveBeenCalled();
  });

  // The in-function tool-delegate chain-hop (sibling to the chainSignal hop that
  // already propagates model) must forward an explicit continue_delegate model
  // override to the grandchild spawn so a tool-delegated hop honors the requested
  // provider/model instead of silently inheriting the parent's.
  it("propagates a tool-delegate model override into the in-function chain-hop spawn", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:test": { sessionId: "session-child", updatedAt: Date.now() },
          "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
        }) as Record<string, unknown>,
    );
    consumePendingDelegatesMock.mockReturnValue([
      { task: "investigate the failing shard", model: "github-copilot/claude-sonnet-4.6" },
    ]);

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-chain-hop",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Tool-delegated from sub-agent (depth 1): prior hop",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    // The chain-hop spawn is fire-and-forget inside the drain loop; flush the
    // microtask/timer queue so the spawn lands before asserting.
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(consumePendingDelegatesMock).toHaveBeenCalledWith("agent:main:subagent:test");
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    const spawnParams = spawnSubagentDirectMock.mock.calls[0]?.[0];
    expect(spawnParams.task).toEqual(
      expect.stringContaining("[continuation:chain-hop:2] Tool-delegated from sub-agent"),
    );
    expect(spawnParams.drainsContinuationDelegateQueue).toBe(true);
    expect(spawnParams.model).toBe("github-copilot/claude-sonnet-4.6");
  });

  it("omits model from the in-function chain-hop spawn when the tool delegate has none", async () => {
    loadSessionStoreMock.mockImplementation(
      () =>
        ({
          "agent:main:subagent:test": { sessionId: "session-child", updatedAt: Date.now() },
          "agent:main:main": { sessionId: "session-main", updatedAt: Date.now() },
        }) as Record<string, unknown>,
    );
    consumePendingDelegatesMock.mockReturnValue([{ task: "inherit the parent model" }]);

    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-chain-hop",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "[continuation:chain-hop:1] Tool-delegated from sub-agent (depth 1): prior hop",
      timeoutMs: 100,
      cleanup: "delete",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
      roundOneReply: "done",
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    const spawnParams = spawnSubagentDirectMock.mock.calls[0]?.[0];
    expect(spawnParams.task).toEqual(
      expect.stringContaining("[continuation:chain-hop:2] Tool-delegated from sub-agent"),
    );
    // Backward-compat: omitted model => no key => grandchild inherits parent model.
    expect("model" in spawnParams).toBe(false);
  });
});
