import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { QueuedSessionDelivery } from "../infra/session-delivery-queue-storage.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";
import { withTempDir } from "../test-helpers/temp-dir.js";

const runtimeLogMock = vi.hoisted(() => vi.fn());
const runtimeErrorMock = vi.hoisted(() => vi.fn());
const requestHeartbeatNowMock = vi.hoisted(() => vi.fn());

const registryRuntimeMock = vi.hoisted(() => ({
  shouldIgnorePostCompletionAnnounceForSession: vi.fn(() => false),
  isSubagentSessionRunActive: vi.fn(() => true),
  countActiveDescendantRuns: vi.fn(() => 0),
  countPendingDescendantRuns: vi.fn(() => 0),
  countPendingDescendantRunsExcludingRun: vi.fn(() => 0),
  listAncestorSessionKeys: vi.fn(() => []),
  listSubagentRunsForRequester: vi.fn(() => []),
  replaceSubagentRunAfterSteer: vi.fn(() => true),
  resolveRequesterForChildSession: vi.fn(() => null),
}));

let mockConfig: OpenClawConfig = {
  agents: { defaults: { continuation: { enabled: true } } },
  session: { mainKey: "main", scope: "per-sender" },
};

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: (...args: unknown[]) => runtimeLogMock(...args),
    error: (...args: unknown[]) => runtimeErrorMock(...args),
  },
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
}));

vi.mock("./subagent-announce.runtime.js", () => ({
  callGateway: vi.fn(async () => ({})),
  getRuntimeConfig: () => mockConfig,
  isEmbeddedPiRunActive: () => false,
  loadSessionStore: () => ({}),
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
  }),
  resolveStorePath: () => "/tmp/sessions.json",
  waitForEmbeddedPiRunEnd: vi.fn(async () => true),
}));

vi.mock("./subagent-announce-delivery.js", () => ({
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

vi.mock("./subagent-announce.registry.runtime.js", () => registryRuntimeMock);

const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");

describe("subagent announce targeted continuation return integration", () => {
  beforeEach(() => {
    runtimeLogMock.mockReset();
    runtimeErrorMock.mockReset();
    requestHeartbeatNowMock.mockReset();
    resetSystemEventsForTest();
    mockConfig = {
      agents: { defaults: { continuation: { enabled: true } } },
      session: { mainKey: "main", scope: "per-sender" },
    };
    registryRuntimeMock.shouldIgnorePostCompletionAnnounceForSession
      .mockReset()
      .mockReturnValue(false);
    registryRuntimeMock.isSubagentSessionRunActive.mockReset().mockReturnValue(true);
    registryRuntimeMock.countPendingDescendantRuns.mockReset().mockReturnValue(0);
    registryRuntimeMock.listAncestorSessionKeys.mockReset().mockReturnValue([]);
    registryRuntimeMock.listSubagentRunsForRequester.mockReset().mockReturnValue([]);
    registryRuntimeMock.resolveRequesterForChildSession.mockReset().mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetSystemEventsForTest();
  });

  it("writes queue file, logs targeted-return, and drains the recipient System context", async () => {
    await withTempDir({ prefix: "openclaw-targeted-return-runtime-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const nonce = "TARGETED-RUNTIME-PATH-NONCE-580";
      const targetSessionKey = "agent:main:recipient-runtime";

      const didAnnounce = await runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:runtime-path",
        childRunId: "run-targeted-runtime-path",
        requesterSessionKey: "agent:main:dispatcher-runtime",
        requesterDisplayKey: "dispatcher-runtime",
        task: `[continuation:chain-hop:1] targeted return ${nonce}`,
        timeoutMs: 100,
        cleanup: "keep",
        waitForCompletion: false,
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
        roundOneReply: `delegate completed with ${nonce}`,
        silentAnnounce: true,
        wakeOnReturn: true,
        continuationTargetSessionKey: targetSessionKey,
      });

      expect(runtimeErrorMock.mock.calls).toEqual([]);
      expect(didAnnounce).toBe(true);

      const queueDir = path.join(stateDir, "session-delivery-queue");
      const entries = await fs.readdir(queueDir);
      const jsonFiles = entries.filter((entry) => entry.endsWith(".json"));
      expect(jsonFiles).toHaveLength(1);

      const persisted = JSON.parse(
        await fs.readFile(path.join(queueDir, jsonFiles[0]), "utf-8"),
      ) as QueuedSessionDelivery;
      if (persisted.kind !== "systemEvent") {
        throw new Error(`expected systemEvent delivery, received ${persisted.kind}`);
      }
      expect(persisted.sessionKey).toBe(targetSessionKey);
      expect(persisted.text).toContain(nonce);

      expect(runtimeLogMock).toHaveBeenCalledWith(
        expect.stringContaining(`[continuation:targeted-return] Delivered to ${targetSessionKey}`),
      );

      expect(peekSystemEventEntries(targetSessionKey)).toHaveLength(1);
      const promptContext = await drainFormattedSystemEvents({
        cfg: mockConfig,
        sessionKey: targetSessionKey,
        isMainSession: false,
        isNewSession: false,
      });
      expect(promptContext).toContain("System:");
      expect(promptContext).toContain("[Internal task completion event]");
      expect(promptContext).toContain(nonce);
      expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: targetSessionKey,
          reason: "delegate-return",
          parentRunId: "run-targeted-runtime-path",
        }),
      );
    });
  });
});
