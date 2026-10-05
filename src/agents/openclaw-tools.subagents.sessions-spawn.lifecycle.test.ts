import assert from "node:assert/strict";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { setSessionMcpRuntimeScheduler } from "./agent-bundle-mcp-manager-api.js";
import {
  getOrCreateSessionMcpRuntime,
  unopenedMcpConfig,
} from "./agent-bundle-mcp-manager.test-support.js";
import { testing as bundleMcpRuntimeTesting } from "./agent-bundle-mcp-runtime.js";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  resetSessionsSpawnAnnounceFlowOverride,
  resetSessionsSpawnConfigOverride,
  resetSessionsSpawnHookRunnerOverride,
  setSessionsSpawnHookRunnerOverride,
  setSessionsSpawnAnnounceFlowOverride,
  setupSessionsSpawnGatewayMock,
  setSessionsSpawnConfigOverride,
  waitForSessionsSpawnEvent,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { getLatestSubagentRunByChildSessionKey } from "./subagents/registry/subagent-registry-read.js";
import { observeRootWork } from "./subagents/registry/subagent-registry.browser-cleanup.test-support.js";
import { resetSubagentRegistryForTests } from "./subagents/registry/subagent-registry.test-helpers.js";

const fastModeEnv = vi.hoisted(() => {
  const previous = process.env.OPENCLAW_TEST_FAST;
  process.env.OPENCLAW_TEST_FAST = "1";
  return { previous };
});
const hookRunnerMocks = vi.hoisted(() => ({
  runSubagentSpawned: vi.fn(async () => {}),
  runSubagentProgress: vi.fn(async () => {}),
  runSubagentEnded: vi.fn(async () => {}),
}));
const mainContext = { agentSessionKey: "agent:main:main", agentChannel: "whatsapp" };
const discordContext = { agentSessionKey: "agent:main:discord:group:req", agentChannel: "discord" };
async function spawn(context = discordContext, args: Record<string, unknown> = {}) {
  const tool = await getSessionsSpawnTool(context);
  const result = await tool.execute("spawn", { task: "do thing", ...args });
  expect(result.details).toMatchObject({ status: "accepted", runId: expect.any(String) });
}
async function waitForCleanup(childSessionKey: string) {
  await waitForSessionsSpawnEvent(
    "run cleanup bookkeeping",
    () => getLatestSubagentRunByChildSessionKey(childSessionKey)?.cleanupCompletedAt != null,
  );
}

describe("sessions_spawn lifecycle", () => {
  let scheduler: ReturnType<typeof createTestGatewayScheduler>;
  beforeEach(async () => {
    await bundleMcpRuntimeTesting.resetSessionMcpRuntimeManager();
    scheduler = createTestGatewayScheduler();
    await setSessionMcpRuntimeScheduler(scheduler);
    resetSessionsSpawnAnnounceFlowOverride();
    resetSessionsSpawnHookRunnerOverride();
    resetSessionsSpawnConfigOverride();
    setSessionsSpawnConfigOverride({
      session: { mainKey: "main", scope: "per-sender" },
      messages: { queue: {} },
      agents: { defaults: { subagents: { runTimeoutSeconds: 1 } } },
    });
    await resetSubagentRegistryForTests({ persist: false });
    hookRunnerMocks.runSubagentSpawned.mockClear();
    hookRunnerMocks.runSubagentProgress.mockClear();
    hookRunnerMocks.runSubagentEnded.mockClear();
    setSessionsSpawnHookRunnerOverride({
      hasHooks: (name: string) =>
        name === "subagent_spawned" || name === "subagent_progress" || name === "subagent_ended",
      ...hookRunnerMocks,
    });
    getCallGatewayMock().mockClear();
  });
  afterEach(async () => {
    resetSessionsSpawnAnnounceFlowOverride();
    resetSessionsSpawnHookRunnerOverride();
    resetSessionsSpawnConfigOverride();
    await resetSubagentRegistryForTests({ persist: false });
    await bundleMcpRuntimeTesting.resetSessionMcpRuntimeManager();
    await scheduler.stop();
  });
  afterAll(() => {
    if (fastModeEnv.previous === undefined) {
      delete process.env.OPENCLAW_TEST_FAST;
    } else {
      process.env.OPENCLAW_TEST_FAST = fastModeEnv.previous;
    }
  });

  it("gives native child startup enough gateway request time", async () => {
    const ctx = setupSessionsSpawnGatewayMock({
      includeChatHistory: true,
      agentWaitResult: { status: "ok", startedAt: 1000, endedAt: 2000 },
    });
    setSessionsSpawnConfigOverride({
      session: { mainKey: "main", scope: "per-sender" },
      messages: { queue: {} },
      agents: { defaults: { subagents: { runTimeoutSeconds: 120 } } },
    });
    await spawn(mainContext);
    const child = ctx.getChild();
    assert(child.sessionKey);
    try {
      expect(ctx.calls.find((call) => call.method === "agent")).toMatchObject({
        timeoutMs: 125_000,
        params: { lane: "subagent" },
      });
    } finally {
      await waitForCleanup(child.sessionKey);
    }
  });

  it("retires the child's bundle MCP runtime after run-mode cleanup", async () => {
    const settleRootWork = observeRootWork();
    const started = createDeferred();
    const gate = createDeferred<"delivered">();
    setSessionsSpawnAnnounceFlowOverride(async () => {
      started.resolve();
      return await gate.promise;
    });
    const ctx = setupSessionsSpawnGatewayMock({
      includeChatHistory: true,
      agentWaitResult: { status: "ok", startedAt: 3000, endedAt: 4000 },
    });
    try {
      await spawn(mainContext, { cleanup: "keep" });
      const child = ctx.getChild();
      assert(child.sessionKey);
      await started.promise;
      await getOrCreateSessionMcpRuntime({
        sessionId: "session:subagent:mcp-retire",
        sessionKey: child.sessionKey,
        workspaceDir: "/tmp/openclaw-subagent-mcp-retire",
        cfg: unopenedMcpConfig,
      });
      expect(bundleMcpRuntimeTesting.getCachedSessionIds()).toContain(
        "session:subagent:mcp-retire",
      );
    } finally {
      gate.resolve("delivered");
      const key = ctx.getChild().sessionKey;
      try {
        if (key) {
          await waitForCleanup(key);
        }
      } finally {
        await settleRootWork();
      }
    }
    await waitForSessionsSpawnEvent(
      "bundle MCP runtime retirement",
      () => !bundleMcpRuntimeTesting.getCachedSessionIds().includes("session:subagent:mcp-retire"),
    );
  });

  it("runs cleanup via a child lifecycle event", async () => {
    const settleRootWork = observeRootWork();
    let deletedKey: string | undefined;
    const ctx = setupSessionsSpawnGatewayMock({
      onSessionsDelete: (params) => {
        deletedKey = (params as { key?: string } | undefined)?.key;
      },
    });
    try {
      await spawn(discordContext, { cleanup: "delete" });
      const child = ctx.getChild();
      assert(child.runId);
      assert(child.sessionKey);
      emitAgentEvent({
        runId: child.runId,
        stream: "lifecycle",
        data: { phase: "end", startedAt: 1234, endedAt: 2345 },
      });
      await waitForSessionsSpawnEvent(
        "lifecycle cleanup",
        () =>
          ctx.calls.filter((call) => call.method === "agent").length >= 2 &&
          deletedKey === child.sessionKey,
      );
      expect(deletedKey).toBe(child.sessionKey);
      const target = {
        sessionId: `sess-${child.sessionKey}`,
        lifecycleRevision: `revision-${child.runId}`,
      };
      expect(ctx.calls.find((call) => call.method === "sessions.delete")?.params).toMatchObject({
        key: child.sessionKey,
        expectedSessionId: target.sessionId,
        expectedLifecycleRevision: target.lifecycleRevision,
      });
      await waitForCleanup(child.sessionKey);
      expect(getLatestSubagentRunByChildSessionKey(child.sessionKey)).toMatchObject({
        deleteCleanupTarget: target,
        deleteCleanupDispatchedAt: expect.any(Number),
        cleanupCompletedAt: expect.any(Number),
      });
      expect(ctx.waitCalls.find((call) => call.runId === child.runId)?.timeoutMs).toBe(1000);
    } finally {
      await settleRootWork();
    }
  });

  it("records timeout when agent.wait and the child session are terminal", async () => {
    const ctx = setupSessionsSpawnGatewayMock({
      includeChatHistory: true,
      chatHistoryText: "still working",
      agentWaitResult: { status: "timeout", startedAt: 6000, endedAt: 7000 },
      subagentSessionEntryPatch: { status: "timeout", endedAt: 7000 },
    });
    await spawn(discordContext, { cleanup: "keep", expectsCompletionMessage: false });
    const child = ctx.getChild();
    assert(child.runId);
    assert(child.sessionKey);
    await waitForCleanup(child.sessionKey);
    expect(ctx.waitCalls.find((call) => call.runId === child.runId)?.timeoutMs).toBe(1000);
    expect(getLatestSubagentRunByChildSessionKey(child.sessionKey)?.execution.outcome?.status).toBe(
      "timeout",
    );
  });

  it("uses the target agent's bound account for a Matrix room", async () => {
    const room = "!exampleRoomId:example.org";
    setSessionsSpawnConfigOverride({
      session: { mainKey: "main", scope: "per-sender" },
      messages: { queue: {} },
      agents: {
        defaults: { subagents: { allowAgents: ["bot-alpha"] } },
        entries: { main: {}, "bot-alpha": {} },
      },
      bindings: [
        {
          type: "route",
          agentId: "bot-alpha",
          match: { channel: "matrix", peer: { kind: "channel", id: room }, accountId: "bot-alpha" },
        },
      ],
    });
    let accountId: string | undefined;
    const ctx = setupSessionsSpawnGatewayMock({
      onAgentSubagentSpawn: (params) => {
        accountId = (params as { accountId?: string } | undefined)?.accountId;
      },
    });
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "matrix",
      agentAccountId: "bot-beta",
      agentTo: room,
    });
    const result = await tool.execute("bound-account", {
      task: "do thing",
      agentId: "bot-alpha",
      cleanup: "keep",
    });
    const key = ctx.getChild().sessionKey;
    try {
      expect(result.details).toMatchObject({ status: "accepted", runId: expect.any(String) });
      expect(accountId).toBe("bot-alpha");
    } finally {
      if (key) {
        await waitForCleanup(key);
      }
    }
  });
});
