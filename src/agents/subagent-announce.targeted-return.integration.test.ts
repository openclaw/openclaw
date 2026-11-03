import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureContinuationQueueContext } from "../auto-reply/continuation/queue-context.js";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import type { ContinuationRecipientAuthorityBinding } from "../config/sessions/session-recipient-authority-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPendingSessionDeliveries } from "../infra/session-delivery-queue-storage.js";
import type { QueuedSessionDelivery } from "../infra/session-delivery-queue-storage.js";
import { resolveSystemEventQueueKey } from "../infra/system-event-ownership.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";
import { withTestDir } from "../test-helpers/temp-dir.js";

const runtimeLogMock = vi.hoisted(() => vi.fn());
const runtimeErrorMock = vi.hoisted(() => vi.fn());
const requestContinuationWakeMock = vi.hoisted(() => vi.fn());
const allSessionKeysMock = vi.hoisted(() => vi.fn(() => [] as string[]));
const requesterDepthMock = vi.hoisted(() => vi.fn(() => 0));

const registryRuntimeMock = vi.hoisted(() => ({
  shouldIgnorePostCompletionAnnounceForSession: vi.fn((_sessionKey: string) => false),
  // The announce flow and its requester-settle-wake owner read these three; a
  // full module factory must provide every export production touches.
  getLatestSubagentRunByChildSessionKey: vi.fn(() => undefined),
  getLatestLiveSubagentRunByChildSessionKey: vi.fn(() => undefined),
  hasDescendantRunAwaitingSettle: vi.fn(() => false),
  isSubagentSessionRunActive: vi.fn(() => true),
  countActiveDescendantRuns: vi.fn(() => 0),
  countPendingDescendantRuns: vi.fn(() => 0),
  countPendingDescendantRunsExcludingRun: vi.fn(() => 0),
  listSubagentRunsForRequester: vi.fn(() => []),
  replaceSubagentRunAfterSteer: vi.fn(() => true),
  resolveRequesterForChildSession: vi.fn(() => null),
}));

let mockConfig: OpenClawConfig = {
  agents: { defaults: { continuation: { enabled: true } } },
  session: { mainKey: "main", scope: "per-sender" },
};
let mockCrossSessionTargeting: "disabled" | "enabled" = "disabled";

// mock-isolation: Runtime log and error lines are captured instead of writing to the terminal.
vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: (...args: unknown[]) => runtimeLogMock(...args),
    error: (...args: unknown[]) => runtimeErrorMock(...args),
  },
}));

// mock-isolation: Continuation wakes are recorded without running the session-event handoff.
vi.mock("../auto-reply/continuation/continuation-wake.js", () => ({
  requestContinuationWake: (...args: unknown[]) => requestContinuationWakeMock(...args),
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    listSessionEntriesCore: () =>
      allSessionKeysMock().map((sessionKey: string) => ({ sessionKey, entry: {} })),
  };
});

// mock-isolation: Session store targets are fixed test paths, never the operator's state dir.
vi.mock("../config/sessions/targets.js", () => ({
  resolveAllAgentSessionStoreTargetsSync: () => [
    { agentId: "main", storePath: "/tmp/targeted-return-all.sqlite" },
  ],
}));

// mock-isolation: Gateway, config and session reads are scripted; the real runtime calls the Gateway and opens session stores.
vi.mock("./subagents/announce/subagent-announce.runtime.js", () => ({
  callGateway: vi.fn(async () => ({})),
  callSubagentLifecycleGateway: vi.fn(async () => ({})),
  dispatchGatewayMethodInProcess: vi.fn(async () => ({})),
  getRuntimeConfig: () => mockConfig,
  isEmbeddedAgentRunActive: () => false,
  loadSessionStore: () => ({}),
  readSessionMessagesAsync: vi.fn(async () => []),
  readSubagentSessionEntry: () => undefined,
  resolveAgentIdFromSessionKey: (sessionKey: string) =>
    sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main",
  resolveContinuationRuntimeConfig: (_cfg?: unknown) => ({
    enabled: true,
    defaultDelayMs: 15_000,
    minDelayMs: 5_000,
    maxDelayMs: 300_000,
    maxChainLength: 10,
    costCapTokens: 500_000,
    maxDelegatesPerTurn: 5,
    contextPressureThreshold: undefined,
    crossSessionTargeting: mockCrossSessionTargeting,
  }),
  resolveSessionStorePathCore: () => "/tmp/sessions.json",
  waitForEmbeddedAgentRunEnd: vi.fn(async () => true),
}));

// mock-isolation: Delivery and requester lookups are scripted; the real module reads the session store and delivers to channels.
vi.mock("./subagents/announce/subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: async () => ({ delivered: true, path: "direct" }),
  loadRequesterSessionEntry: (sessionKey: string) => ({
    entry: {
      sessionId: `session-${sessionKey}`,
      updatedAt: Date.now(),
    },
  }),
  loadSessionEntryByKey: (sessionKey: string) => ({
    sessionId: `session-${sessionKey}`,
    updatedAt: Date.now(),
  }),
  resolveAnnounceOrigin: (
    _entry: unknown,
    requesterOrigin?: { channel?: string; to?: string; accountId?: string; threadId?: string },
  ) => requesterOrigin ?? {},
  resolveSubagentCompletionOrigin: async (params: { requesterOrigin?: unknown }) =>
    params.requesterOrigin,
  resolveSubagentAnnounceTimeoutMs: () => 10_000,
  runAnnounceDeliveryWithRetry: async <T>(params: { run: () => Promise<T> }) => await params.run(),
}));

// mock-isolation: Registry reads come from the test; the real reader opens the shared-state worker.
vi.mock("./subagents/registry/subagent-registry-read.js", () => registryRuntimeMock);
// The descendant wake loads the registry module directly (the runtime barrel is
// gone); only the steer replacement this suite stubbed there is intercepted.
vi.mock("./subagents/registry/subagent-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagents/registry/subagent-registry.js")>()),
  replaceSubagentRunAfterSteerCore: registryRuntimeMock.replaceSubagentRunAfterSteer,
}));

// mock-isolation: Subagent depth is fixed by the test instead of read from the session store.
vi.mock("./subagents/spawn/subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => requesterDepthMock(),
  getSubagentDepthFromSessionStoreInWorker: async () => requesterDepthMock(),
}));

const { runSubagentAnnounceFlow } = await import("./subagents/announce/subagent-announce.js");

async function readQueuedSystemEventDeliveries(stateDir: string): Promise<QueuedSessionDelivery[]> {
  return loadPendingSessionDeliveries(captureContinuationQueueContext(stateDir));
}

describe("subagent announce targeted continuation return integration", () => {
  beforeEach(() => {
    runtimeLogMock.mockReset();
    runtimeErrorMock.mockReset();
    requestContinuationWakeMock.mockReset();
    requesterDepthMock.mockReset().mockReturnValue(0);
    resetSystemEventsForTest();
    mockConfig = {
      agents: { defaults: { continuation: { enabled: true } } },
      session: { mainKey: "main", scope: "per-sender" },
    };
    mockCrossSessionTargeting = "disabled";
    allSessionKeysMock.mockReset().mockReturnValue([]);
    registryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession
      .mockReset()
      .mockReturnValue(false);
    registryRuntimeMock.isSubagentSessionRunActive.mockReset().mockReturnValue(true);
    registryRuntimeMock.countPendingDescendantRuns.mockReset().mockReturnValue(0);
    registryRuntimeMock.listSubagentRunsForRequester.mockReset().mockReturnValue([]);
    registryRuntimeMock.resolveRequesterForChildSession.mockReset().mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetSystemEventsForTest();
  });

  it("owner-binds a main child return to its explicit helper recipient", async () => {
    await withTestDir({ prefix: "openclaw-targeted-return-runtime-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const nonce = "TARGETED-RUNTIME-PATH-NONCE-580";
      const targetSessionKey = "agent:helper:recipient-runtime";

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:runtime-path",
        childAgentId: "main",
        childRunId: "run-targeted-runtime-path",
        requesterSessionKey: "agent:main:dispatcher-runtime",
        task: `[continuation:chain-hop:1] targeted return ${nonce}`,
        timeoutMs: 100,
        cleanup: "keep",
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
        roundOneReply: `delegate completed with ${nonce}`,
        silentAnnounce: true,
        wakeOnReturn: true,
        continuationTargetSessionKey: targetSessionKey,
      });

      expect(runtimeErrorMock.mock.calls).toEqual([]);
      expect(didAnnounce).toBe("delivered");

      const queuedDeliveries = await loadPendingSessionDeliveries(
        captureContinuationQueueContext(stateDir),
      );
      expect(queuedDeliveries).toHaveLength(1);

      const persisted = expectDefined(queuedDeliveries.at(0), "queued delivery");
      if (persisted.kind !== "systemEvent") {
        throw new Error(`expected systemEvent delivery, received ${persisted.kind}`);
      }
      expect(persisted.sessionKey).toBe(targetSessionKey);
      expect(persisted.agentId).toBe("helper");
      expect(persisted.text).toContain(nonce);

      expect(runtimeLogMock).toHaveBeenCalledWith(
        expect.stringContaining(`[continuation:targeted-return] Delivered to ${targetSessionKey}`),
      );

      const queuedEvents = peekSystemEventEntries(
        resolveSystemEventQueueKey(targetSessionKey, "helper"),
      );
      expect(queuedEvents.length).toBeGreaterThan(0);
      // Ownership is the agent-qualified queue key: main cannot derive a queue for this recipient.
      expect(() => resolveSystemEventQueueKey(targetSessionKey, "main")).toThrow(
        "System event owner does not match its session key.",
      );
      const promptContext = await drainFormattedSystemEvents({
        cfg: mockConfig,
        agentId: "helper",
        sessionKey: targetSessionKey,
        isMainSession: false,
        isNewSession: false,
      });
      expect(promptContext).toContain("System:");
      expect(promptContext).toContain("[Internal task completion event]");
      expect(promptContext).toContain(nonce);
      expect(requestContinuationWakeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "helper",
          sessionKey: targetSessionKey,
          reason: "delegate-return",
          parentRunId: "run-targeted-runtime-path",
        }),
      );
    });
  });

  it("routes an explicit return past an inactive cleaned internal requester", async () => {
    await withTestDir(
      { prefix: "openclaw-targeted-return-inactive-explicit-" },
      async (stateDir) => {
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        const nonce = "TARGETED-INACTIVE-EXPLICIT-NONCE-581";
        // A cron key is unambiguously internal without relying on depth-store
        // fixture state, so this executes the inactive-requester guard.
        const requesterSessionKey = "agent:main:cron:cleaned-explicit-requester";
        const targetSessionKey = "agent:main:recipient-explicit-after-cleanup";
        registryRuntimeMock.isSubagentSessionRunActive.mockReturnValueOnce(false);
        registryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession.mockImplementation(
          (sessionKey: string) => sessionKey === requesterSessionKey,
        );

        const didAnnounce = await runSubagentAnnounceFlow({
          childSessionKey: "agent:main:subagent:explicit-after-cleanup",
          childRunId: "run-targeted-inactive-explicit",
          requesterSessionKey,
          task: `[continuation:chain-hop:1] explicit return ${nonce}`,
          timeoutMs: 100,
          cleanup: "keep",
          startedAt: 10,
          endedAt: 20,
          outcome: { status: "ok" },
          roundOneReply: `delegate completed with ${nonce}`,
          silentAnnounce: true,
          wakeOnReturn: true,
          continuationTargetSessionKey: targetSessionKey,
        });

        expect(didAnnounce).toBe("delivered");
        const queued = await loadPendingSessionDeliveries(
          captureContinuationQueueContext(stateDir),
        );
        expect(queued).toHaveLength(1);
        expect(queued.at(0)).toEqual(expect.objectContaining({ sessionKey: targetSessionKey }));
        expect(peekSystemEventEntries(requesterSessionKey)).toHaveLength(0);
        expect(peekSystemEventEntries(targetSessionKey)).toHaveLength(1);
      },
    );
  });

  it("delivers fanoutMode=tree returns after its inactive intermediate requester was cleaned up", async () => {
    await withTestDir({ prefix: "openclaw-targeted-return-tree-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const nonce = "TREE-TARGETED-RETURN-NONCE-641";
      const requesterSessionKey = "agent:main:subagent:dispatcher-tree";
      const rootSessionKey = "agent:main:root-tree";
      registryRuntimeMock.isSubagentSessionRunActive.mockReturnValueOnce(false);
      registryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession.mockImplementation(
        (sessionKey: string) => sessionKey === requesterSessionKey,
      );

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:tree-return",
        childRunId: "run-tree-targeted-return",
        requesterSessionKey,
        task: `[continuation:chain-hop:1] tree return ${nonce}`,
        timeoutMs: 100,
        cleanup: "keep",
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
        roundOneReply: `delegate completed with ${nonce}`,
        silentAnnounce: true,
        wakeOnReturn: true,
        continuationTargetSessionKeys: [requesterSessionKey, rootSessionKey],
        continuationFanoutMode: "tree",
      });

      expect(runtimeErrorMock.mock.calls).toEqual([]);
      expect(didAnnounce).toBe("delivered");
      expect(registryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession).toHaveBeenCalledWith(
        requesterSessionKey,
      );
      expect(registryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession).toHaveBeenCalledWith(
        rootSessionKey,
      );

      const persisted = await readQueuedSystemEventDeliveries(stateDir);
      expect(persisted).toHaveLength(1);
      expect(persisted.map((entry) => entry.sessionKey)).toEqual([rootSessionKey]);
      for (const entry of persisted) {
        expect(entry.kind).toBe("systemEvent");
        if (entry.kind === "systemEvent") {
          expect(entry.text).toContain(nonce);
        }
      }

      for (const sessionKey of [rootSessionKey]) {
        expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
        expect(
          expectDefined(peekSystemEventEntries(sessionKey).at(0), "system event").text,
        ).toContain(nonce);
      }
      expect(requestContinuationWakeMock).toHaveBeenCalledTimes(1);
      expect(requestContinuationWakeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: rootSessionKey,
          reason: "delegate-return",
          parentRunId: "run-tree-targeted-return",
        }),
      );
      expect(runtimeLogMock).toHaveBeenCalledWith(
        expect.stringContaining(`[continuation:targeted-return] Delivered to ${rootSessionKey}`),
      );
    });
  });

  it("does not reopen a cleaned explicit return target", async () => {
    await withTestDir(
      { prefix: "openclaw-targeted-return-explicit-cleaned-" },
      async (stateDir) => {
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        const requesterSessionKey = "agent:main:subagent:explicit-cleaned";
        registryRuntimeMock.isSubagentSessionRunActive.mockReturnValueOnce(false);
        registryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession.mockImplementation(
          (sessionKey: string) => sessionKey === requesterSessionKey,
        );

        const didAnnounce = await runSubagentAnnounceFlow({
          childSessionKey: "agent:main:subagent:explicit-cleaned-child",
          childRunId: "run-explicit-cleaned-return",
          requesterSessionKey,
          task: "[continuation:chain-hop:1] explicit cleaned target",
          timeoutMs: 100,
          cleanup: "keep",
          startedAt: 10,
          endedAt: 20,
          outcome: { status: "ok" },
          roundOneReply: "delegate completed",
          silentAnnounce: true,
          wakeOnReturn: true,
          continuationTargetSessionKey: requesterSessionKey,
        });

        expect(didAnnounce).toBe("delivered");
        expect(await readQueuedSystemEventDeliveries(stateDir)).toHaveLength(0);
        expect(peekSystemEventEntries(requesterSessionKey)).toHaveLength(0);
        expect(requestContinuationWakeMock).not.toHaveBeenCalled();
      },
    );
  });

  it("does not reopen cleaned recipients from an all-fanout return", async () => {
    await withTestDir({ prefix: "openclaw-targeted-return-all-cleaned-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const requesterSessionKey = "agent:main:subagent:all-cleaned";
      const liveSessionKey = "agent:main:root:all-live";
      allSessionKeysMock.mockReturnValue([requesterSessionKey, liveSessionKey]);
      // Exercise the same inactive internal-requester admission gate as the
      // live cleaned-intermediary failure: the live all-recipient must still
      // be routed while the cleaned requester stays closed.
      registryRuntimeMock.isSubagentSessionRunActive.mockReturnValueOnce(false);
      registryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession.mockImplementation(
        (sessionKey: string) => sessionKey === requesterSessionKey,
      );

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:all-cleaned-child",
        childRunId: "run-all-cleaned-return",
        requesterSessionKey,
        task: "[continuation:chain-hop:1] all cleaned target",
        timeoutMs: 100,
        cleanup: "keep",
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
        roundOneReply: "delegate completed",
        silentAnnounce: true,
        wakeOnReturn: true,
        continuationFanoutMode: "all",
      });

      expect(didAnnounce).toBe("delivered");
      expect(
        (await readQueuedSystemEventDeliveries(stateDir)).map((entry) => entry.sessionKey),
      ).toEqual([liveSessionKey]);
      expect(peekSystemEventEntries(requesterSessionKey)).toEqual([]);
      expect(peekSystemEventEntries(liveSessionKey)).toHaveLength(1);
      expect(requestContinuationWakeMock).toHaveBeenCalledTimes(1);
      expect(requestContinuationWakeMock).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: liveSessionKey }),
      );
    });
  });

  it("freezes completion-time all recipients and reuses them on retry", async () => {
    await withTestDir({ prefix: "openclaw-targeted-return-all-authority-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const firstRecipient = "agent:main:all-authority-first";
      const secondRecipient = "agent:main:all-authority-second";
      allSessionKeysMock.mockReturnValue([firstRecipient, secondRecipient]);
      let selectedBinding: ContinuationRecipientAuthorityBinding | undefined;
      const persistBinding = vi.fn((binding: ContinuationRecipientAuthorityBinding) => {
        selectedBinding = binding;
        return true;
      });
      const baseParams = {
        childSessionKey: "agent:main:subagent:all-authority-child",
        requesterSessionKey: "agent:main:all-authority-requester",
        requesterDisplayKey: "all-authority-requester",
        task: "[continuation:chain-hop:1] all authority",
        timeoutMs: 100,
        cleanup: "keep" as const,
        waitForCompletion: false,
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" as const },
        roundOneReply: "delegate completed",
        silentAnnounce: true,
        wakeOnReturn: true,
        continuationFanoutMode: "all" as const,
      };

      const firstResult = await runSubagentAnnounceFlow({
        ...baseParams,
        childRunId: "run-all-authority-first",
        continuationRecipientAuthorityBinding: {
          version: 1,
          selection: "pending",
          fanoutMode: "all",
        },
        persistContinuationRecipientAuthorityBinding: persistBinding,
      });

      expect(firstResult).toBe("delivered");
      expect(selectedBinding).toEqual({
        version: 1,
        selection: "selected",
        recipients: [
          {
            sessionKey: firstRecipient,
            authority: expect.objectContaining({ state: "bound", epoch: expect.any(String) }),
          },
          {
            sessionKey: secondRecipient,
            authority: expect.objectContaining({ state: "bound", epoch: expect.any(String) }),
          },
        ],
      });
      allSessionKeysMock.mockImplementation(() => {
        throw new Error("retry must not enumerate current recipients");
      });

      const retryResult = await runSubagentAnnounceFlow({
        ...baseParams,
        childRunId: "run-all-authority-retry",
        continuationRecipientAuthorityBinding: selectedBinding,
        persistContinuationRecipientAuthorityBinding: persistBinding,
      });

      expect(retryResult).toBe("delivered");
      expect(persistBinding).toHaveBeenCalledTimes(1);
      expect(
        (await readQueuedSystemEventDeliveries(stateDir))
          .map((entry) => entry.sessionKey)
          .toSorted(),
      ).toEqual([firstRecipient, firstRecipient, secondRecipient, secondRecipient]);
    });
  });

  it("does not reopen a cleaned requester on the default silent-return path", async () => {
    await withTestDir({ prefix: "openclaw-targeted-return-default-cleaned-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const requesterSessionKey = "agent:main:subagent:default-cleaned";
      // The untargeted path must still take the inactive internal-requester
      // early gate, then leave the cleaned recipient closed with no wake.
      registryRuntimeMock.isSubagentSessionRunActive.mockReturnValueOnce(false);
      registryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession.mockImplementation(
        (sessionKey: string) => sessionKey === requesterSessionKey,
      );

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:default-cleaned-child",
        childRunId: "run-default-cleaned-return",
        requesterSessionKey,
        task: "ordinary silent return",
        timeoutMs: 100,
        cleanup: "keep",
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
        roundOneReply: "delegate completed",
        silentAnnounce: true,
        wakeOnReturn: true,
      });

      expect(didAnnounce).toBe("delivered");
      expect(await readQueuedSystemEventDeliveries(stateDir)).toEqual([]);
      expect(peekSystemEventEntries(requesterSessionKey)).toEqual([]);
      expect(requestContinuationWakeMock).not.toHaveBeenCalled();
    });
  });

  it.each(["filtered", "refused for stale recipient authority"])(
    "does not fall back to the requester or log a delivery when every tree recipient is %s",
    async (emptied) => {
      await withTestDir({ prefix: "openclaw-targeted-return-empty-tree-" }, async (stateDir) => {
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        const requesterSessionKey = "agent:main:subagent:cleaned-tree";
        if (emptied === "filtered") {
          registryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession.mockReturnValueOnce(
            true,
          );
        }

        const didAnnounce = await runSubagentAnnounceFlow({
          childSessionKey: "agent:main:subagent:empty-tree-return",
          childRunId: "run-empty-tree-targeted-return",
          requesterSessionKey,
          task: "[continuation:chain-hop:1] empty filtered tree",
          timeoutMs: 100,
          cleanup: "keep",
          startedAt: 10,
          endedAt: 20,
          outcome: { status: "ok" },
          roundOneReply: "delegate completed",
          silentAnnounce: true,
          wakeOnReturn: true,
          continuationTargetSessionKeys: [requesterSessionKey],
          continuationFanoutMode: "tree",
          // An epoch no session holds: the recipient's authority is not current.
          ...(emptied === "filtered"
            ? {}
            : {
                continuationRecipientAuthorityBinding: {
                  version: 1 as const,
                  selection: "selected" as const,
                  recipients: [
                    {
                      sessionKey: requesterSessionKey,
                      authority: { state: "bound" as const, epoch: crypto.randomUUID() },
                    },
                  ],
                },
              }),
        });

        expect(didAnnounce).toBe("delivered");
        expect(await readQueuedSystemEventDeliveries(stateDir)).toEqual([]);
        expect(peekSystemEventEntries(requesterSessionKey)).toEqual([]);
        expect(requestContinuationWakeMock).not.toHaveBeenCalled();
        expect(runtimeLogMock).not.toHaveBeenCalledWith(
          expect.stringContaining("[continuation:targeted-return] Delivered to"),
        );
      });
    },
  );

  it("delivers post-compaction fanoutMode=tree returns like normal tree returns", async () => {
    await withTestDir({ prefix: "openclaw-post-compaction-tree-return-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const nonce = "POST-COMPACTION-TREE-RETURN-NONCE-642";
      const requesterSessionKey = "agent:main:post-compacted";
      const rootSessionKey = "agent:main:post-root";

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:post-compaction-tree",
        childRunId: "run-post-compaction-tree-return",
        requesterSessionKey,
        task:
          `[continuation:post-compaction] ` +
          `[continuation:chain-hop:1] carry compacted state ${nonce}`,
        timeoutMs: 100,
        cleanup: "keep",
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
        roundOneReply: `post-compaction delegate completed with ${nonce}`,
        silentAnnounce: true,
        wakeOnReturn: true,
        continuationTargetSessionKeys: [requesterSessionKey, rootSessionKey],
        continuationFanoutMode: "tree",
      });

      expect(runtimeErrorMock.mock.calls).toEqual([]);
      expect(didAnnounce).toBe("delivered");

      const persisted = await readQueuedSystemEventDeliveries(stateDir);
      expect(persisted).toHaveLength(2);
      expect(persisted.map((entry) => entry.sessionKey).toSorted()).toEqual([
        requesterSessionKey,
        rootSessionKey,
      ]);
      for (const sessionKey of [requesterSessionKey, rootSessionKey]) {
        expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
        expect(
          expectDefined(peekSystemEventEntries(sessionKey).at(0), "system event").text,
        ).toContain(nonce);
      }
      expect(requestContinuationWakeMock).toHaveBeenCalledTimes(2);
    });
  });
});
