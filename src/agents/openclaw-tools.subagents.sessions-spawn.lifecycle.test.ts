import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRouteBinding } from "../config/types.agents.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  resetSessionsSpawnAnnounceFlowOverride,
  resetSessionsSpawnConfigOverride,
  resetSessionsSpawnHookRunnerOverride,
  setSessionsSpawnHookRunnerOverride,
  setupSessionsSpawnGatewayMock,
  setSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import {
  getLatestSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

const fastModeEnv = vi.hoisted(() => {
  const previous = process.env.OPENCLAW_TEST_FAST;
  process.env.OPENCLAW_TEST_FAST = "1";
  return { previous };
});

const hookRunnerMocks = vi.hoisted(() => ({
  runSubagentSpawning: vi.fn(async (event: unknown) => {
    const input = event as {
      threadRequested?: boolean;
    };
    if (!input.threadRequested) {
      return undefined;
    }
    return {
      status: "ok" as const,
      threadBindingReady: true,
    };
  }),
  runSubagentSpawned: vi.fn(async () => {}),
  runSubagentEnded: vi.fn(async () => {}),
}));

vi.mock("./tools/agent-step.js", () => ({
  readLatestAssistantReply: async () => "done",
}));

const callGatewayMock = getCallGatewayMock();
const RUN_TIMEOUT_SECONDS = 1;

function buildDiscordCleanupHooks(onDelete: (key: string | undefined) => void) {
  return {
    onAgentSubagentSpawn: (params: unknown) => {
      const rec = params as { channel?: string; timeout?: number } | undefined;
      expect(rec?.channel).toBe("discord");
      expect(rec?.timeout).toBe(1);
    },
    onSessionsDelete: (params: unknown) => {
      const rec = params as { key?: string } | undefined;
      onDelete(rec?.key);
    },
  };
}

const waitFor = async (label: string, predicate: () => boolean, timeoutMs = 30_000) => {
  await vi.waitFor(
    () => {
      expect(predicate(), label).toBe(true);
    },
    { timeout: timeoutMs, interval: 1 },
  );
};

async function getDiscordGroupSpawnTool() {
  return await getSessionsSpawnTool({
    agentSessionKey: "discord:group:req",
    agentChannel: "discord",
  });
}

async function executeSpawnAndExpectAccepted(params: {
  tool: Awaited<ReturnType<typeof getSessionsSpawnTool>>;
  callId: string;
  cleanup?: "delete" | "keep";
  label?: string;
  expectsCompletionMessage?: boolean;
}) {
  const result = await params.tool.execute(params.callId, {
    task: "do thing",
    runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
    ...(params.cleanup ? { cleanup: params.cleanup } : {}),
    ...(params.label ? { label: params.label } : {}),
    ...(params.expectsCompletionMessage === false ? { expectsCompletionMessage: false } : {}),
  });
  expect(result.details).toMatchObject({
    status: "accepted",
    runId: expect.any(String),
  });
  return result;
}

async function executeBoundAccountSpawn(params: {
  bindings: AgentRouteBinding[];
  context: Parameters<typeof getSessionsSpawnTool>[0];
  callId: string;
  agentId?: string;
}): Promise<string | undefined> {
  let spawnAccountId: string | undefined;
  setSessionsSpawnConfigOverride({
    session: { mainKey: "main", scope: "per-sender" },
    messages: { queue: { debounceMs: 0 } },
    agents: { defaults: { subagents: { allowAgents: ["bot-alpha"] } } },
    bindings: params.bindings,
  });
  setupSessionsSpawnGatewayMock({
    onAgentSubagentSpawn: (hookParams) => {
      const rec = hookParams as { accountId?: string } | undefined;
      spawnAccountId = rec?.accountId;
    },
  });

  const tool = await getSessionsSpawnTool(params.context);
  const result = await tool.execute(params.callId, {
    task: "do thing",
    ...(params.agentId ? { agentId: params.agentId } : {}),
    cleanup: "keep",
  });
  expect(result.details).toMatchObject({ status: "accepted", runId: expect.any(String) });
  return spawnAccountId;
}

async function emitLifecycleEndAndFlush(params: {
  runId: string;
  startedAt: number;
  endedAt: number;
}) {
  vi.useFakeTimers();
  try {
    emitAgentEvent({
      runId: params.runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: params.startedAt,
        endedAt: params.endedAt,
      },
    });

    await vi.runAllTimersAsync();
  } finally {
    vi.useRealTimers();
  }
}

async function waitForRunCleanup(childSessionKey: string) {
  await waitFor("run cleanup bookkeeping", () => {
    const run = getLatestSubagentRunByChildSessionKey(childSessionKey);
    return run?.cleanupCompletedAt != null;
  });
}

describe("openclaw-tools: subagents (sessions_spawn lifecycle)", () => {
  beforeEach(() => {
    resetSessionsSpawnAnnounceFlowOverride();
    resetSessionsSpawnHookRunnerOverride();
    resetSessionsSpawnConfigOverride();
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      messages: {
        queue: {
          debounceMs: 0,
        },
      },
    });
    resetSubagentRegistryForTests({ persist: false });
    hookRunnerMocks.runSubagentSpawning.mockClear();
    hookRunnerMocks.runSubagentSpawned.mockClear();
    hookRunnerMocks.runSubagentEnded.mockClear();
    setSessionsSpawnHookRunnerOverride({
      hasHooks: (hookName: string) =>
        hookName === "subagent_spawning" ||
        hookName === "subagent_spawned" ||
        hookName === "subagent_ended",
      runSubagentSpawning: hookRunnerMocks.runSubagentSpawning,
      runSubagentSpawned: hookRunnerMocks.runSubagentSpawned,
      runSubagentEnded: hookRunnerMocks.runSubagentEnded,
    });
    callGatewayMock.mockClear();
  });

  afterEach(() => {
    resetSessionsSpawnAnnounceFlowOverride();
    resetSessionsSpawnHookRunnerOverride();
    resetSessionsSpawnConfigOverride();
    resetSubagentRegistryForTests({ persist: false });
  });

  afterAll(() => {
    if (fastModeEnv.previous === undefined) {
      delete process.env.OPENCLAW_TEST_FAST;
      return;
    }
    process.env.OPENCLAW_TEST_FAST = fastModeEnv.previous;
  });

  it("sessions_spawn runs cleanup flow after subagent completion", async () => {
    const patchCalls: Array<{ key?: string; label?: string }> = [];

    const ctx = setupSessionsSpawnGatewayMock({
      includeSessionsList: true,
      includeChatHistory: true,
      onSessionsPatch: (params) => {
        const rec = params as { key?: string; label?: string } | undefined;
        patchCalls.push({ key: rec?.key, label: rec?.label });
      },
    });

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });

    await executeSpawnAndExpectAccepted({
      tool,
      callId: "call2",
      label: "my-task",
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    await waitFor(
      "subagent wait, label patch, and main agent trigger",
      () =>
        ctx.waitCalls.some((call) => call.runId === child.runId) &&
        patchCalls.some((call) => call.label === "my-task") &&
        ctx.calls.filter((call) => call.method === "agent").length >= 2,
    );
    if (!child.sessionKey) {
      throw new Error("missing child sessionKey");
    }
    await waitForRunCleanup(child.sessionKey);

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);
    // Cleanup should patch the label
    const labelPatch = patchCalls.find((call) => call.label === "my-task");
    expect(labelPatch?.key).toBe(child.sessionKey);
    expect(labelPatch?.label).toBe("my-task");

    // Two agent calls: subagent spawn + main agent trigger
    const agentCalls = ctx.calls.filter((c) => c.method === "agent");
    expect(agentCalls).toHaveLength(2);

    // First call: subagent spawn
    const first = agentCalls[0]?.params as { lane?: string } | undefined;
    expect(first?.lane).toBe("subagent");

    // Second call: main agent trigger (not "Sub-agent announce step." anymore)
    const second = agentCalls[1]?.params as { sessionKey?: string; message?: string } | undefined;
    expect(second?.sessionKey).toBe("agent:main:main");
    expect(second?.message).toContain("subagent task");

    // No direct send to external channel (main agent handles delivery)
    const sendCalls = ctx.calls.filter((c) => c.method === "send");
    expect(sendCalls.length).toBe(0);
    expect(child.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn runs cleanup via lifecycle events", async () => {
    let deletedKey: string | undefined;
    const ctx = setupSessionsSpawnGatewayMock({
      ...buildDiscordCleanupHooks((key) => {
        deletedKey = key;
      }),
    });

    const tool = await getDiscordGroupSpawnTool();
    await executeSpawnAndExpectAccepted({
      tool,
      callId: "call1",
      cleanup: "delete",
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    await emitLifecycleEndAndFlush({
      runId: child.runId,
      startedAt: 1234,
      endedAt: 2345,
    });

    await waitFor(
      "lifecycle cleanup",
      () => ctx.calls.filter((call) => call.method === "agent").length >= 2 && Boolean(deletedKey),
    );

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);

    const agentCalls = ctx.calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(2);

    const first = agentCalls[0]?.params as
      | {
          lane?: string;
          deliver?: boolean;
          sessionKey?: string;
          channel?: string;
        }
      | undefined;
    expect(first?.lane).toBe("subagent");
    expect(first?.deliver).toBe(false);
    expect(first?.channel).toBe("discord");
    expect(first?.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);
    expect(child.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);

    const second = agentCalls[1]?.params as
      | {
          sessionKey?: string;
          message?: string;
          deliver?: boolean;
        }
      | undefined;
    expect(second?.sessionKey).toBe("agent:main:discord:group:req");
    expect(second?.deliver).toBe(false);
    expect(second?.message).toContain("subagent task");

    const sendCalls = ctx.calls.filter((c) => c.method === "send");
    expect(sendCalls.length).toBe(0);

    expect(deletedKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn deletes session when cleanup=delete via agent.wait", async () => {
    let deletedKey: string | undefined;
    const ctx = setupSessionsSpawnGatewayMock({
      includeChatHistory: true,
      ...buildDiscordCleanupHooks((key) => {
        deletedKey = key;
      }),
      agentWaitResult: { status: "ok", startedAt: 3000, endedAt: 4000 },
    });

    const tool = await getDiscordGroupSpawnTool();
    await executeSpawnAndExpectAccepted({
      tool,
      callId: "call1b",
      cleanup: "delete",
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    await waitFor("agent.wait called for child run", () =>
      ctx.waitCalls.some((call) => call.runId === child.runId),
    );
    await waitFor(
      "main agent cleanup trigger",
      () => ctx.calls.filter((call) => call.method === "agent").length >= 2,
    );
    await waitFor("delete cleanup", () => Boolean(deletedKey));

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);
    expect(child.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);

    // Two agent calls: subagent spawn + main agent trigger
    const agentCalls = ctx.calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(2);

    // First call: subagent spawn
    const first = agentCalls[0]?.params as { lane?: string } | undefined;
    expect(first?.lane).toBe("subagent");

    // Second call: main agent trigger
    const second = agentCalls[1]?.params as { sessionKey?: string; deliver?: boolean } | undefined;
    expect(second?.sessionKey).toBe("agent:main:discord:group:req");
    expect(second?.deliver).toBe(false);

    // No direct send to external channel (main agent handles delivery)
    const sendCalls = ctx.calls.filter((c) => c.method === "send");
    expect(sendCalls.length).toBe(0);

    // Session should be deleted
    expect(deletedKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn records timeout when agent.wait returns timeout", async () => {
    const ctx = setupSessionsSpawnGatewayMock({
      includeChatHistory: true,
      chatHistoryText: "still working",
      agentWaitResult: { status: "timeout", startedAt: 6000, endedAt: 7000 },
    });

    const tool = await getDiscordGroupSpawnTool();
    await executeSpawnAndExpectAccepted({
      tool,
      callId: "call-timeout",
      cleanup: "keep",
      expectsCompletionMessage: false,
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    if (!child.sessionKey) {
      throw new Error("missing child sessionKey");
    }
    const childSessionKey = child.sessionKey;

    await waitFor(
      "timeout outcome",
      () =>
        ctx.waitCalls.some((call) => call.runId === child.runId) &&
        getLatestSubagentRunByChildSessionKey(childSessionKey)?.outcome?.status === "timeout",
      20_000,
    );
    await waitForRunCleanup(childSessionKey);

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);
    expect(getLatestSubagentRunByChildSessionKey(childSessionKey)?.outcome?.status).toBe("timeout");
  });

  it("sessions_spawn uses the target agent's bound account for a Matrix room-bound route", async () => {
    const boundRoom = "!exampleRoomId:example.org";
    expect(
      await executeBoundAccountSpawn({
        callId: "call-bound-account",
        agentId: "bot-alpha",
        context: {
          agentSessionKey: "main",
          agentChannel: "matrix",
          agentAccountId: "bot-beta",
          agentTo: boundRoom,
        },
        bindings: [
          {
            type: "route",
            agentId: "bot-alpha",
            match: {
              channel: "matrix",
              peer: {
                kind: "channel",
                id: boundRoom,
              },
              accountId: "bot-alpha",
            },
          },
        ],
      }),
    ).toBe("bot-alpha");
  });

  it("sessions_spawn prefers peer-specific binding over channel-only binding", async () => {
    const targetRoom = "!roomA:example.org";
    expect(
      await executeBoundAccountSpawn({
        callId: "call-peer-specific",
        agentId: "bot-alpha",
        context: {
          agentSessionKey: "main",
          agentChannel: "matrix",
          agentAccountId: "bot-beta",
          agentTo: targetRoom,
        },
        bindings: [
          {
            type: "route",
            agentId: "bot-alpha",
            match: { channel: "matrix", accountId: "bot-alpha-default" },
          },
          {
            type: "route",
            agentId: "bot-alpha",
            match: {
              channel: "matrix",
              peer: { kind: "channel", id: targetRoom },
              accountId: "bot-alpha-room-a",
            },
          },
        ],
      }),
    ).toBe("bot-alpha-room-a");
  });

  it("sessions_spawn falls back to channel-only binding when peer does not match", async () => {
    const otherRoom = "!roomB:example.org";
    expect(
      await executeBoundAccountSpawn({
        callId: "call-fallback",
        agentId: "bot-alpha",
        context: {
          agentSessionKey: "main",
          agentChannel: "matrix",
          agentAccountId: "bot-beta",
          agentTo: otherRoom,
        },
        bindings: [
          {
            type: "route",
            agentId: "bot-alpha",
            match: { channel: "matrix", accountId: "bot-alpha-default" },
          },
          {
            type: "route",
            agentId: "bot-alpha",
            match: {
              channel: "matrix",
              peer: { kind: "channel", id: "!roomA:example.org" },
              accountId: "bot-alpha-room-a",
            },
          },
        ],
      }),
    ).toBe("bot-alpha-default");
  });

  it("sessions_spawn treats a wildcard peer binding as match-any and beats channel-only", async () => {
    const callerRoom = "!anyRoom:example.org";
    expect(
      await executeBoundAccountSpawn({
        callId: "call-wildcard-peer",
        agentId: "bot-alpha",
        context: {
          agentSessionKey: "main",
          agentChannel: "matrix",
          agentAccountId: "bot-beta",
          agentTo: callerRoom,
        },
        bindings: [
          {
            type: "route",
            agentId: "bot-alpha",
            match: { channel: "matrix", accountId: "bot-alpha-default" },
          },
          {
            type: "route",
            agentId: "bot-alpha",
            match: {
              channel: "matrix",
              peer: { kind: "channel", id: "*" },
              accountId: "bot-alpha-wildcard",
            },
          },
        ],
      }),
    ).toBe("bot-alpha-wildcard");
  });

  it("sessions_spawn prefers exact peer binding over wildcard peer binding", async () => {
    const exactRoom = "!roomA:example.org";
    expect(
      await executeBoundAccountSpawn({
        callId: "call-exact-over-wildcard",
        agentId: "bot-alpha",
        context: {
          agentSessionKey: "main",
          agentChannel: "matrix",
          agentAccountId: "bot-beta",
          agentTo: exactRoom,
        },
        bindings: [
          {
            type: "route",
            agentId: "bot-alpha",
            match: {
              channel: "matrix",
              peer: { kind: "channel", id: "*" },
              accountId: "bot-alpha-wildcard",
            },
          },
          {
            type: "route",
            agentId: "bot-alpha",
            match: {
              channel: "matrix",
              peer: { kind: "channel", id: exactRoom },
              accountId: "bot-alpha-room-a",
            },
          },
        ],
      }),
    ).toBe("bot-alpha-room-a");
  });

  it("sessions_spawn uses requester roles for role-scoped target-agent accounts", async () => {
    expect(
      await executeBoundAccountSpawn({
        callId: "call-role-scoped-account",
        agentId: "bot-alpha",
        context: {
          agentSessionKey: "main",
          agentChannel: "discord",
          agentAccountId: "bot-beta",
          agentTo: "channel:ops",
          agentGroupSpace: "guild-current",
          agentMemberRoleIds: ["admin"],
        },
        bindings: [
          {
            type: "route",
            agentId: "bot-alpha",
            match: { channel: "discord", accountId: "bot-alpha-default" },
          },
          {
            type: "route",
            agentId: "bot-alpha",
            match: {
              channel: "discord",
              guildId: "guild-current",
              roles: ["admin"],
              peer: { kind: "channel", id: "channel:ops" },
              accountId: "bot-alpha-admin",
            },
          },
        ],
      }),
    ).toBe("bot-alpha-admin");
  });

  it("sessions_spawn strips channel-side prefixes from agentTo before bound-account lookup", async () => {
    const rawRoomId = "!exampleRoomId:example.org";
    // agentTo arrives in delivery-target format (room:<id>), while the binding
    // stores the raw id. Without prefix normalization the exact peer match
    // would silently fail and the caller account would leak to the child.
    expect(
      await executeBoundAccountSpawn({
        callId: "call-prefixed-to",
        agentId: "bot-alpha",
        context: {
          agentSessionKey: "main",
          agentChannel: "matrix",
          agentAccountId: "bot-beta",
          agentTo: `room:${rawRoomId}`,
        },
        bindings: [
          {
            type: "route",
            agentId: "bot-alpha",
            match: {
              channel: "matrix",
              peer: { kind: "channel", id: rawRoomId },
              accountId: "bot-alpha",
            },
          },
        ],
      }),
    ).toBe("bot-alpha");
  });

  it("sessions_spawn peels channel prefix then kind prefix for <channel>:<kind>:<id> targets", async () => {
    const rawGroupId = "U123example";
    // LINE emits its originatingTo as `line:group:<id>`. Without peeling the
    // channel prefix first and looping, a naive strip would leave `group:<id>`
    // (or `line:<id>`) and the exact peer-id binding would not match.
    expect(
      await executeBoundAccountSpawn({
        callId: "call-line-nested-prefix",
        agentId: "bot-alpha",
        context: {
          agentSessionKey: "main",
          agentChannel: "line",
          agentAccountId: "bot-beta",
          agentTo: `line:group:${rawGroupId}`,
        },
        bindings: [
          // Wildcard peer binding with a conflicting kind (direct) must be
          // skipped because the inferred kind is `group`.
          {
            type: "route",
            agentId: "bot-alpha",
            match: {
              channel: "line",
              peer: { kind: "direct", id: "*" },
              accountId: "bot-alpha-line-dm",
            },
          },
          {
            type: "route",
            agentId: "bot-alpha",
            match: {
              channel: "line",
              peer: { kind: "group", id: rawGroupId },
              accountId: "bot-alpha-line",
            },
          },
        ],
      }),
    ).toBe("bot-alpha-line");
  });

  it("sessions_spawn classifies Matrix room:@user targets as direct, not channel", async () => {
    const rawUserId = "@other-user:example.org";
    // Matrix thread delivery encodes per-user DM targets as `room:@user:server`.
    // The `room:` prefix must not override the embedded `@` direct-peer marker.
    expect(
      await executeBoundAccountSpawn({
        callId: "call-room-at-user",
        agentId: "bot-alpha",
        context: {
          agentSessionKey: "main",
          agentChannel: "matrix",
          agentAccountId: "bot-beta",
          agentTo: `room:${rawUserId}`,
        },
        bindings: [
          // A conflicting channel-kinded binding on the same peer id must not
          // match because the embedded `@` marker identifies a direct peer.
          {
            type: "route",
            agentId: "bot-alpha",
            match: {
              channel: "matrix",
              peer: { kind: "channel", id: rawUserId },
              accountId: "bot-alpha-wrong-kind",
            },
          },
          {
            type: "route",
            agentId: "bot-alpha",
            match: {
              channel: "matrix",
              peer: { kind: "direct", id: rawUserId },
              accountId: "bot-alpha-dm",
            },
          },
        ],
      }),
    ).toBe("bot-alpha-dm");
  });

  it("sessions_spawn strips only the Teams conversation: wrapper", async () => {
    const rawConversationId = "a:1:example-conversation@thread.v2";
    // Teams inbound context sets OriginatingTo to `conversation:<id>`. The
    // Teams id itself may start with another token-colon segment, so extraction
    // must stop after the known wrapper instead of peeling arbitrary prefixes.
    expect(
      await executeBoundAccountSpawn({
        callId: "call-teams-conversation",
        agentId: "bot-alpha",
        context: {
          agentSessionKey: "main",
          agentChannel: "msteams",
          agentAccountId: "bot-beta",
          agentTo: `conversation:${rawConversationId}`,
        },
        bindings: [
          {
            type: "route",
            agentId: "bot-alpha",
            match: {
              channel: "msteams",
              peer: { kind: "channel", id: rawConversationId },
              accountId: "bot-alpha-teams",
            },
          },
        ],
      }),
    ).toBe("bot-alpha-teams");
  });

  it("sessions_spawn preserves the caller's account for same-agent subagent spawns", async () => {
    const room = "!someRoom:example.org";
    // Spawn a child of the same agent (no explicit agentId), so the caller's
    // active account must win over any configured binding for that same agent.
    expect(
      await executeBoundAccountSpawn({
        callId: "call-same-agent",
        context: {
          agentSessionKey: "agent:bot-alpha:session:main",
          agentChannel: "matrix",
          agentAccountId: "bot-alpha-adhoc",
          agentTo: room,
        },
        bindings: [
          {
            type: "route",
            agentId: "bot-alpha",
            match: { channel: "matrix", accountId: "bot-alpha-default" },
          },
        ],
      }),
    ).toBe("bot-alpha-adhoc");
  });

  it("sessions_spawn announces with requester accountId", async () => {
    const ctx = setupSessionsSpawnGatewayMock({});

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
      agentAccountId: "kev",
    });

    await executeSpawnAndExpectAccepted({
      tool,
      callId: "call-announce-account",
      cleanup: "keep",
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    if (!child.sessionKey) {
      throw new Error("missing child sessionKey");
    }
    await emitLifecycleEndAndFlush({
      runId: child.runId,
      startedAt: 1000,
      endedAt: 2000,
    });

    await waitFor(
      "account-aware lifecycle announce",
      () => ctx.calls.filter((call) => call.method === "agent").length >= 2,
    );
    await waitForRunCleanup(child.sessionKey);

    const agentCalls = ctx.calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(2);
    const announceParams = agentCalls[1]?.params as
      | { accountId?: string; channel?: string; deliver?: boolean }
      | undefined;
    expect(announceParams?.deliver).toBe(false);
    expect(announceParams?.channel).toBeUndefined();
    expect(announceParams?.accountId).toBeUndefined();
  });
});
