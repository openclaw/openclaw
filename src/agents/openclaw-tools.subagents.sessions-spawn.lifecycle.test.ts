import assert from "node:assert/strict";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { disposeAllSessionMcpRuntimes } from "./agent-bundle-mcp-manager-api.js";
import {
  bindSessionMcpRuntimeTestScheduler,
  getOrCreateSessionMcpRuntime,
  getSessionMcpRuntimeTestManager,
  unopenedMcpConfig,
} from "./agent-bundle-mcp-manager.test-support.js";
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
import {
  getLatestLiveSubagentRunByChildSessionKey,
  getLatestSubagentRunByChildSessionKey,
} from "./subagents/registry/subagent-registry-read.js";
import { observeRootWork } from "./subagents/registry/subagent-registry.browser-cleanup.test-support.js";
import { resetSubagentRegistryForTests } from "./subagents/registry/subagent-registry.test-helpers.js";

const fastModeEnv = vi.hoisted(() => {
  const previous = process.env.OPENCLAW_TEST_FAST;
  process.env.OPENCLAW_TEST_FAST = "1";
  return { previous };
});
const mainContext = { agentSessionKey: "agent:main:main", agentChannel: "whatsapp" };
const discordContext = { agentSessionKey: "agent:main:discord:group:req", agentChannel: "discord" };
async function spawn(
  context: Parameters<typeof getSessionsSpawnTool>[0] = discordContext,
  args: Record<string, unknown> = {},
) {
  const tool = await getSessionsSpawnTool(context);
  const result = await tool.execute("spawn", { task: "do thing", ...args });
  expect(result.details).toMatchObject({ status: "accepted", runId: expect.any(String) });
}
function childOf(ctx: ReturnType<typeof setupSessionsSpawnGatewayMock>) {
  const child = ctx.getChild();
  assert(child.sessionKey && child.runId);
  return { sessionKey: child.sessionKey, runId: child.runId };
}
async function waitForCleanup(childSessionKey: string) {
  await waitForSessionsSpawnEvent(
    "run cleanup bookkeeping",
    () => getLatestLiveSubagentRunByChildSessionKey(childSessionKey)?.cleanupCompletedAt != null,
  );
}

beforeEach(async () => {
  await disposeAllSessionMcpRuntimes();
  await bindSessionMcpRuntimeTestScheduler();
  resetSessionsSpawnAnnounceFlowOverride();
  resetSessionsSpawnHookRunnerOverride();
  resetSessionsSpawnConfigOverride();
  const config = {
    session: { mainKey: "main", scope: "per-sender" },
    messages: { queue: {} },
    agents: { defaults: { subagents: { runTimeoutSeconds: 1 } } },
  } satisfies Parameters<typeof setSessionsSpawnConfigOverride>[0];
  setSessionsSpawnConfigOverride(config);
  setRuntimeConfigSnapshot(config);
  await resetSubagentRegistryForTests({ persist: false });
  setSessionsSpawnHookRunnerOverride({
    hasHooks: (name: string) =>
      name === "subagent_spawned" || name === "subagent_progress" || name === "subagent_ended",
    runSubagentSpawned: async () => {},
    runSubagentProgress: async () => {},
    runSubagentEnded: async () => {},
  });
  getCallGatewayMock().mockClear();
});
afterEach(async () => {
  resetSessionsSpawnAnnounceFlowOverride();
  resetSessionsSpawnHookRunnerOverride();
  resetSessionsSpawnConfigOverride();
  await resetSubagentRegistryForTests({ persist: false });
  await disposeAllSessionMcpRuntimes();
  clearRuntimeConfigSnapshot();
});
afterAll(() => {
  if (fastModeEnv.previous === undefined) {
    delete process.env.OPENCLAW_TEST_FAST;
  } else {
    process.env.OPENCLAW_TEST_FAST = fastModeEnv.previous;
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
  let childSessionId: string | undefined;
  try {
    await spawn(mainContext, { cleanup: "keep" });
    const child = childOf(ctx);
    await started.promise;
    childSessionId = getLatestLiveSubagentRunByChildSessionKey(child.sessionKey)
      ?.childSessionIdentity?.sessionId;
    assert(childSessionId);
    await getOrCreateSessionMcpRuntime({
      sessionId: childSessionId,
      sessionKey: child.sessionKey,
      workspaceDir: "/tmp/openclaw-subagent-mcp-retire",
      cfg: unopenedMcpConfig,
    });
    expect(getSessionMcpRuntimeTestManager().listSessionIds()).toContain(childSessionId);
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
  assert(childSessionId);
  await waitForSessionsSpawnEvent(
    "bundle MCP runtime retirement",
    () => !getSessionMcpRuntimeTestManager().listSessionIds().includes(childSessionId),
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
    const child = childOf(ctx);
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
  const child = childOf(ctx);
  await waitForCleanup(child.sessionKey);
  expect(ctx.waitCalls.find((call) => call.runId === child.runId)?.timeoutMs).toBe(1000);
  expect(
    (await getLatestSubagentRunByChildSessionKey(child.sessionKey))?.execution.outcome?.status,
  ).toBe("timeout");
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
  await spawn(
    {
      agentSessionKey: "agent:main:main",
      agentChannel: "matrix",
      agentAccountId: "bot-beta",
      agentTo: room,
    },
    {
      agentId: "bot-alpha",
      cleanup: "keep",
    },
  );
  const key = ctx.getChild().sessionKey;
  try {
    expect(accountId).toBe("bot-alpha");
  } finally {
    if (key) {
      await waitForCleanup(key);
    }
  }
});
