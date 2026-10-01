import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { isAcpSessionKey } from "../sessions/session-key-utils.js";
import {
  createNewSessionRequest,
  createLoadSessionRequest,
  createPromptRequest,
  createToolEvent,
  createChatFinalEvent,
  expectConfigOption,
  sessionUpdatePayloads,
  expectSessionUpdate,
} from "./translator.bridge-test-helpers.js";
import type { GatewaySessionPresentationRow } from "./translator.presentation.js";
import {
  createAcpConnection,
  createAcpGateway,
  createAcpGatewayAgent,
} from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({ getAvailableCommands: () => [] }));

const sessionId = "bridge-session";
const row: GatewaySessionPresentationRow = {
  key: sessionId,
  label: "main-work",
  displayName: "Main work",
  derivedTitle: "Fix ACP bridge",
  kind: "direct",
  updatedAt: 1_710_000_000_000,
  thinkingLevel: "high",
  modelProvider: "openai",
  model: "gpt-5.4",
  thinkingLevels: [
    { id: "off", label: "off" },
    { id: "medium", label: "medium" },
    { id: "max", label: "max" },
  ],
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
  const sessionStore = createInMemorySessionStore();
  const connection = createAcpConnection();
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.list" && options.row) {
      return { sessions: [options.row] };
    }
    if (method === "sessions.get" && options.transcript) {
      return options.transcript();
    }
    if (method === "chat.send") {
      return new Promise<never>(() => {});
    }
    return { ok: true };
  }) as GatewayClient["request"];
  const agent = createAcpGatewayAgent(connection, createAcpGateway(request), {
    sessionStore,
    sessionCreateRateLimit: options.sessionCreateRateLimit,
  });
  return { agent, sessionStore, sessionUpdate: connection["__sessionUpdateMock"] };
}

describe("ACP session bridge", () => {
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
    expect(key).toMatch(/^acp-bridge:/);
    expect(isAcpSessionKey(key)).toBe(false);
    expect(result.modes?.currentModeId).toBe("adaptive");
    expect(result.modes?.availableModes.map((mode) => mode.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "adaptive",
    ]);
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
    const { agent, sessionUpdate } = harness({
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
          { role: "system", content: [{ type: "text", text: "ignore me" }] },
          { role: "assistant", content: [{ type: "image", image: "skip" }] },
        ],
      }),
    });
    const result = await agent.loadSession(createLoadSessionRequest(sessionId));
    expect(result.modes?.currentModeId).toBe("high");
    expect(result.modes?.availableModes.map((mode) => mode.id)).toEqual([
      "off",
      "medium",
      "max",
      "high",
    ]);
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
    ]) {
      expect(sessionUpdate).toHaveBeenCalledWith({
        sessionId,
        update: { sessionUpdate: kind, content: { type: "text", text } },
      });
    }
    expectSessionUpdate(sessionUpdate, sessionId, "available_commands_update");
    expectSessionUpdate(sessionUpdate, sessionId, "session_info_update");
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title: "Fix ACP bridge",
        updatedAt: "2024-03-09T16:00:00.000Z",
        _meta: { sessionKey: sessionId, kind: "direct" },
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: 4096,
        size: 8192,
        _meta: { source: "gateway-session-store", approximate: true },
      },
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

  it("settles and clears the active run when the completion snapshot cannot be delivered", async () => {
    const { agent, sessionStore, sessionUpdate } = harness({ row });
    await agent.loadSession(createLoadSessionRequest(sessionId));
    sessionUpdate.mockClear();
    sessionUpdate.mockRejectedValueOnce(new Error("session update transport failed"));
    const prompt = agent.prompt(createPromptRequest(sessionId, "hello"));
    await agent.handleGatewayEvent(createChatFinalEvent(sessionId));
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
    expect(sessionStore.getSession(sessionId)?.activeRunId).toBeNull();
    expect(sessionStore.getSession(sessionId)?.abortController).toBeNull();
  });

  it("streams partial tool output and retains file locations through completion", async () => {
    const { agent, sessionUpdate } = harness();
    await agent.loadSession(createLoadSessionRequest(sessionId));
    sessionUpdate.mockClear();
    const prompt = agent.prompt(createPromptRequest(sessionId, "Inspect app.ts"));
    const tool = { sessionKey: sessionId, toolCallId: "tool-1", name: "read" };
    const args = { path: "src/app.ts", line: 12 };
    const partial = {
      content: [{ type: "text", text: "partial output" }],
      details: { path: "src/app.ts" },
    };
    const result = {
      content: [{ type: "text", text: "FILE:src/app.ts" }],
      details: { path: "src/app.ts" },
    };
    await agent.handleGatewayEvent(createToolEvent({ ...tool, phase: "start", args }));
    await agent.handleGatewayEvent(
      createToolEvent({ ...tool, phase: "update", partialResult: partial }),
    );
    await agent.handleGatewayEvent(createToolEvent({ ...tool, phase: "result", result }));
    await agent.handleGatewayEvent(createChatFinalEvent(sessionId));
    await prompt;
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "read: path: src/app.ts, line: 12",
        status: "in_progress",
        rawInput: args,
        kind: "read",
        locations: [args],
      },
    });
    for (const [rawOutput, status, text] of [
      [partial, "in_progress", "partial output"],
      [result, "completed", "FILE:src/app.ts"],
    ]) {
      expect(sessionUpdate).toHaveBeenCalledWith({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status,
          rawOutput,
          content: [{ type: "content", content: { type: "text", text } }],
          locations: [args],
        },
      });
    }
  });
});
