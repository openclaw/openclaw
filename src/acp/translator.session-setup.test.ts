import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import type { NewSessionResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isAcpSessionKey } from "../sessions/session-key-utils.js";
import {
  createNewSessionRequest,
  createSetSessionModeRequest,
  createSetSessionConfigOptionRequest,
  createLoadSessionRequest,
  createPromptRequest,
  createToolEvent,
  createChatFinalEvent,
  expectConfigOption,
  sessionUpdatePayloads,
  expectSessionUpdate,
} from "./translator.bridge-test-helpers.js";
import type { GatewaySessionPresentationRow } from "./translator.presentation.js";
import { createPromptScenario } from "./translator.scenario.test-support.js";
import { createAcpConnection, createAcpGateway, createAcpGatewayAgent } from "./translator.test-helpers.js";

const explicitMultiAgentConfig = {
  agents: {
    ownership: "explicit",
    entries: { ops: {}, research: {} },
  },
} satisfies OpenClawConfig;

const sessionId = "bridge-session";
const row: GatewaySessionPresentationRow = {
  key: sessionId,
  derivedTitle: "Fix ACP bridge",
  kind: "direct",
  updatedAt: 1_710_000_000_000,
  thinkingLevel: "high",
  thinkingLevels: ["off", "medium", "max"].map((id) => ({ id, label: id })),
  verboseLevel: "full",
  reasoningLevel: "stream",
  responseUsage: "tokens",
  elevatedLevel: "ask",
  totalTokens: 4096,
  totalTokensFresh: true,
  contextTokens: 8192,
};

function harness(
  options: {
    row?: GatewaySessionPresentationRow;
    transcript?: () => unknown;
    sessionCreateRateLimit?: { maxRequests: number; windowMs: number };
  } = {},
) {
  const h = createPromptScenario({
    sessions: [],
    sessionCreateRateLimit: options.sessionCreateRateLimit,
    request: (method) => {
      if (method === "sessions.list" && options.row) {
        return { sessions: [options.row] };
      }
      if (method === "sessions.get" && options.transcript) {
        return options.transcript();
      }
      return { ok: true };
    },
  });
  const expectUpdate = (update: SessionUpdate) =>
    expect(h.sessionUpdate).toHaveBeenCalledWith({ sessionId, update });
  return { ...h, expectUpdate };
}

function expectModes(modes: NewSessionResponse["modes"], currentModeId: string, ids: string[]) {
  expect(modes).toMatchObject({ currentModeId, availableModes: ids.map((id) => ({ id })) });
}

it("rejects unsupported per-session MCP servers before emitting updates", async () => {
  const { agent, sessionUpdate } = harness();
  await expect(
    agent.newSession({
      ...createNewSessionRequest(),
      mcpServers: [{ name: "docs", command: "mcp-docs", args: [], env: [] }],
    }),
  ).rejects.toThrow(/does not support per-session MCP servers/i);
  expect(sessionUpdate).not.toHaveBeenCalled();
});

it("creates bridge sessions outside the runtime namespace with initial controls", async () => {
  const { agent, sessionStore } = harness();
  const result = await agent.newSession(createNewSessionRequest());
  const key = sessionStore.getSession(result.sessionId)?.sessionKey;
  expect(key).toBe(`agent:main:acp-bridge:${result.sessionId}`);
  expect(isAcpSessionKey(key)).toBe(false);
  expectModes(result.modes, "adaptive", ["off", "minimal", "low", "medium", "high", "adaptive"]);
  expectConfigOption(result.configOptions, "thought_level", {
    currentValue: "adaptive",
    category: "thought_level",
  });
  for (const id of ["verbose_level", "reasoning_level", "elevated_level"]) {
    expectConfigOption(result.configOptions, id, { currentValue: "off" });
  }
  expectConfigOption(result.configOptions, "response_usage", { currentValue: "inherit" });
});

it("replays transcript text and thinking with current session controls and usage", async () => {
  const { agent, sessionUpdate, expectUpdate } = harness({
    row,
    transcript: () => ({
      messages: [
        { role: "user", content: [{ type: "text", text: "Question" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Internal loop about NO_REPLY" },
            { type: "text", text: "Answer" },
          ],
        },
      ],
    }),
  });
  const result = await agent.loadSession(createLoadSessionRequest(sessionId));
  expectModes(result.modes, "high", ["off", "medium", "max", "high"]);
  for (const [id, currentValue] of Object.entries({
    thought_level: "high",
    verbose_level: "full",
    reasoning_level: "stream",
    response_usage: "tokens",
    elevated_level: "ask",
  })) {
    expectConfigOption(result.configOptions, id, { currentValue });
  }
  for (const [kind, text] of [
    ["user_message_chunk", "Question"],
    ["agent_thought_chunk", "Internal loop about NO_REPLY"],
    ["agent_message_chunk", "Answer"],
  ] as const) {
    expectUpdate({ sessionUpdate: kind, content: { type: "text", text } });
  }
  expectSessionUpdate(sessionUpdate, sessionId, "available_commands_update");
  expectUpdate({
    sessionUpdate: "session_info_update",
    title: "Fix ACP bridge",
    updatedAt: "2024-03-09T16:00:00.000Z",
    _meta: { sessionKey: sessionId, kind: "direct" },
  });
  expectUpdate({
    sessionUpdate: "usage_update",
    used: 4096,
    size: 8192,
    _meta: { source: "gateway-session-store", approximate: true },
  });
});

it("loads controls with an empty transcript when sessions.get fails", async () => {
  const { agent, sessionUpdate } = harness({
    row: { ...row, derivedTitle: undefined, thinkingLevel: "adaptive" },
    transcript: () => {
      throw new Error("sessions.get unavailable");
    },
  });
  const result = await agent.loadSession(createLoadSessionRequest(sessionId));
  expect(result.modes?.currentModeId).toBe("adaptive");
  expectSessionUpdate(sessionUpdate, sessionId, "available_commands_update");
  expect(sessionUpdatePayloads(sessionUpdate, "user_message_chunk")).toEqual([]);
});

it("rate limits new session IDs without counting loadSession refreshes", async () => {
  const { agent } = harness({ sessionCreateRateLimit: { maxRequests: 1, windowMs: 60_000 } });
  await agent.loadSession(createLoadSessionRequest(sessionId));
  await agent.loadSession(createLoadSessionRequest(sessionId));
  await expect(agent.loadSession(createLoadSessionRequest("new-session"))).rejects.toThrow(
    /session creation rate limit exceeded/i,
  );
});

it("streams partial tool output and retains file locations through completion", async () => {
  const { agent, sessionUpdate, expectUpdate } = harness();
  await agent.loadSession(createLoadSessionRequest(sessionId));
  sessionUpdate.mockClear();
  const prompt = agent.prompt(createPromptRequest(sessionId, "Inspect app.ts"));
  const tool = { sessionKey: sessionId, toolCallId: "tool-1", name: "read" };
  const args = { path: "src/app.ts", line: 12.9 };
  const output = (text: string) => ({
    content: [{ type: "text", text }],
    details: { path: "src/app.ts" },
  });
  const partial = output("partial output");
  const result = output("FILE:src/app.ts");
  await agent.handleGatewayEvent(createToolEvent({ ...tool, phase: "start", args }));
  await agent.handleGatewayEvent(
    createToolEvent({ ...tool, phase: "update", partialResult: partial }),
  );
  await agent.handleGatewayEvent(createToolEvent({ ...tool, phase: "result", result }));
  await agent.handleGatewayEvent(createChatFinalEvent(sessionId));
  await prompt;
  expectUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "read: path: src/app.ts, line: 12.9",
    status: "in_progress",
    rawInput: args,
    kind: "read",
    locations: [{ path: "src/app.ts", line: 12 }],
  });
  for (const [rawOutput, status, text] of [
    [partial, "in_progress", "partial output"],
    [result, "completed", "FILE:src/app.ts"],
  ] as const) {
    expectUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status,
      rawOutput,
      content: [{ type: "content", content: { type: "text", text } }],
      locations: [{ path: "src/app.ts", line: 12 }],
    });
  }
});
async function configFixture() {
  const { agent, request, sessionUpdate } = harness({
    row: {
      key: "session",
      kind: "direct",
      updatedAt: 1_710_000_000_000,
      thinkingLevel: "minimal",
      responseUsage: "tokens",
    },
  });
  await agent.loadSession(createLoadSessionRequest("session"));
  sessionUpdate.mockClear();
  request.mockClear();
  return {
    request,
    sessionUpdate,
    setMode: () => agent.setSessionMode(createSetSessionModeRequest("session", "high")),
    setOption: (id: string, value: string | boolean) =>
      agent.setSessionConfigOption(createSetSessionConfigOptionRequest("session", id, value)),
  };
}

it("surfaces gateway mode patch failures instead of succeeding silently", async () => {
  const { setMode, request } = await configFixture();
  request.mockRejectedValueOnce(new Error("gateway rejected mode"));
  await expect(setMode()).rejects.toThrow(/gateway rejected mode/i);
});

it.each([
  { route: "mode", id: "thought_level", value: "high", patch: { thinkingLevel: "high" } },
  { route: "config", id: "thought_level", value: "minimal", patch: { thinkingLevel: "minimal" } },
  { route: "config", id: "fast_mode", value: "on", patch: { fastMode: true } },
  { route: "config", id: "response_usage", value: "inherit", patch: { responseUsage: null } },
  { route: "config", id: "response_usage", value: "off", patch: { responseUsage: "off" } },
])("patches $id=$value via $route and refreshes controls", async ({ route, id, value, patch }) => {
  const { setMode, setOption, request, sessionUpdate } = await configFixture();
  if (route === "mode") {
    await expect(setMode()).resolves.toEqual({});
  } else {
    const result = await setOption(id, value);
    expectConfigOption(result.configOptions, id, { currentValue: value });
  }
  expect(request).toHaveBeenCalledWith("sessions.patch", { key: "session", ...patch });
  expectConfigOption(
    expectSessionUpdate(sessionUpdate, "session", "config_option_update").configOptions,
    id,
    { currentValue: value },
  );
  if (id === "thought_level") {
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "session",
      update: { sessionUpdate: "current_mode_update", currentModeId: value },
    });
  }
});

it("accepts forwarded timeout config options without patching Gateway sessions", async () => {
  const { setOption, request } = await configFixture();
  const result = await setOption("timeout", "180");
  expect(Array.isArray(result.configOptions)).toBe(true);
  expect(request.mock.calls.some(([method]) => method === "sessions.patch")).toBe(false);
});

it("rejects non-string ACP config option values", async () => {
  const { setOption, request } = await configFixture();
  await expect(setOption("thought_level", false)).rejects.toThrow(
    'ACP bridge does not support non-string session config option values for "thought_level".',
  );
  expect(request.mock.calls.some(([method]) => method === "sessions.patch")).toBe(false);
});

describe("acp session UX bridge behavior", () => {
  it("scopes generated bridge sessions to the selected agent without reusing keys", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = createAcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      agentId: "ops",
      config: explicitMultiAgentConfig,
      sessionStore,
    });

    const first = await agent.newSession(createNewSessionRequest());
    const second = await agent.newSession(createNewSessionRequest());
    const firstKey = sessionStore.getSession(first.sessionId)?.sessionKey;
    const secondKey = sessionStore.getSession(second.sessionId)?.sessionKey;

    expect(firstKey).toMatch(/^agent:ops:acp-bridge:/);
    expect(secondKey).toMatch(/^agent:ops:acp-bridge:/);
    expect(secondKey).not.toBe(firstKey);
    expect(isAcpSessionKey(firstKey)).toBe(false);
  });

  it("rejects generated sessions when an explicit multi-agent fleet has no owner", async () => {
    const agent = createAcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      config: explicitMultiAgentConfig,
    });

    await expect(agent.newSession(createNewSessionRequest())).rejects.toThrow(
      /ACP bridge session has no explicit owner.*--agent <id>/i,
    );
  });

  it.each([
    { storeOwner: "ops", systemOwner: undefined, selected: undefined, owner: undefined },
    { storeOwner: "ops", systemOwner: "research", selected: undefined, owner: undefined },
    { storeOwner: "retired", systemOwner: "research", selected: undefined, owner: undefined },
    { storeOwner: "ops", systemOwner: undefined, selected: "research", owner: "research" },
  ])(
    "preserves fixed-store routing with store=$storeOwner system=$systemOwner selected=$selected",
    async ({ storeOwner, systemOwner, selected, owner }) => {
      const sessionStore = createInMemorySessionStore();
      const agent = createAcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
        agentId: selected,
        config: {
          session: { store: "/tmp/shared.sqlite" },
          agents: {
            ...explicitMultiAgentConfig.agents,
            defaults: {
              sessionStore: { agentId: storeOwner },
              ...(systemOwner ? { systemAgent: { agentId: systemOwner } } : {}),
            },
          },
        },
        sessionStore,
      });

      const result = await agent.newSession(createNewSessionRequest());

      // Bare keys preserve Gateway fixed-store ownership, including retired-owner refusal.
      expect(sessionStore.getSession(result.sessionId)?.sessionKey).toBe(
        `${owner ? `agent:${owner}:` : ""}acp-bridge:${result.sessionId}`,
      );
    },
  );

  it("rejects an unknown explicitly selected agent", async () => {
    const agent = createAcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      agentId: "missing",
      config: explicitMultiAgentConfig,
    });

    await expect(agent.newSession(createNewSessionRequest())).rejects.toThrow(
      'Unknown agent id "missing"',
    );
  });

  it("scopes generated sessions to a remote-only owner without a local roster entry", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = createAcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      agentId: "remote-only",
      skipAgentOwnerRosterValidation: true,
      config: explicitMultiAgentConfig,
      sessionStore,
    });

    const result = await agent.newSession(createNewSessionRequest());

    expect(sessionStore.getSession(result.sessionId)?.sessionKey).toMatch(
      /^agent:remote-only:acp-bridge:/,
    );
  });

  it("keeps the bare bridge key for remote targets with an ambiguous local roster", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = createAcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      skipAgentOwnerRosterValidation: true,
      config: explicitMultiAgentConfig,
      sessionStore,
    });

    const result = await agent.newSession(createNewSessionRequest());

    // The remote Gateway owns owner resolution here: its sole agent may be
    // neither `main` nor any local entry, so the key must stay unscoped.
    expect(sessionStore.getSession(result.sessionId)?.sessionKey).toMatch(/^acp-bridge:/);
  });

  it("keeps the bare bridge key when the local sole owner is absent from a remote Gateway", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = createAcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      skipAgentOwnerRosterValidation: true,
      // The client's only agent is `ops`, but the remote Gateway may run a
      // different roster (or a sole owner such as `research`), so the client
      // must not prefix the key with a local identity.
      config: {
        agents: { ownership: "explicit", entries: { ops: {} } },
      } satisfies OpenClawConfig,
      sessionStore,
    });

    const result = await agent.newSession(createNewSessionRequest());

    expect(sessionStore.getSession(result.sessionId)?.sessionKey).toMatch(/^acp-bridge:/);
  });

  it("preserves explicit session routing without an ambient owner", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = createAcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      config: explicitMultiAgentConfig,
      defaultSessionKey: "agent:research:default",
      sessionStore,
    });

    const result = await agent.newSession({
      ...createNewSessionRequest(),
      _meta: { sessionKey: "agent:ops:override" },
    });

    expect(sessionStore.getSession(result.sessionId)?.sessionKey).toBe("agent:ops:override");
  });

  it("keeps explicit session routing precedence when --agent is not in the local roster", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = createAcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      agentId: "missing",
      config: explicitMultiAgentConfig,
      defaultSessionKey: "agent:research:default",
      sessionStore,
    });

    const result = await agent.newSession(createNewSessionRequest());

    expect(sessionStore.getSession(result.sessionId)?.sessionKey).toBe("agent:research:default");
  });
});
