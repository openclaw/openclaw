import type {
  LoadSessionRequest,
  NewSessionRequest,
  PromptRequest,
  SetSessionModeRequest,
} from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

function createNewSessionRequest(cwd = "/tmp"): NewSessionRequest {
  return {
    cwd,
    mcpServers: [],
    _meta: {},
  } as unknown as NewSessionRequest;
}

function createLoadSessionRequest(sessionId: string, cwd = "/tmp"): LoadSessionRequest {
  return {
    sessionId,
    cwd,
    mcpServers: [],
    _meta: {},
  } as unknown as LoadSessionRequest;
}

function createPromptRequest(
  sessionId: string,
  text: string,
  meta: Record<string, unknown> = {},
): PromptRequest {
  return {
    sessionId,
    prompt: [{ type: "text", text }],
    _meta: meta,
  } as unknown as PromptRequest;
}

function createSetSessionModeRequest(sessionId: string, modeId: string): SetSessionModeRequest {
  return {
    sessionId,
    modeId,
    _meta: {},
  } as unknown as SetSessionModeRequest;
}

async function expectOversizedPromptRejected(params: { sessionId: string; text: string }) {
  const request = vi.fn(async () => ({ ok: true })) as GatewayClient["request"];
  const sessionStore = createInMemorySessionStore();
  const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(request), {
    sessionStore,
  });
  await agent.loadSession(createLoadSessionRequest(params.sessionId));

  await expect(agent.prompt(createPromptRequest(params.sessionId, params.text))).rejects.toThrow(
    /maximum allowed size/i,
  );
  expect(request).not.toHaveBeenCalledWith("chat.send", expect.anything(), expect.anything());
  const session = sessionStore.getSession(params.sessionId);
  expect(session?.activeRunId).toBeNull();
  expect(session?.abortController).toBeNull();

  sessionStore.clearAllSessionsForTest();
}

describe("acp session creation rate limit", () => {
  it("rate limits excessive newSession bursts", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      sessionStore,
      sessionCreateRateLimit: {
        maxRequests: 2,
        windowMs: 60_000,
      },
    });

    await agent.newSession(createNewSessionRequest());
    await agent.newSession(createNewSessionRequest());
    await expect(agent.newSession(createNewSessionRequest())).rejects.toThrow(
      /session creation rate limit exceeded/i,
    );

    sessionStore.clearAllSessionsForTest();
  });

  it("does not count loadSession refreshes for an existing session ID", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      sessionStore,
      sessionCreateRateLimit: {
        maxRequests: 1,
        windowMs: 60_000,
      },
    });

    await agent.loadSession(createLoadSessionRequest("shared-session"));
    await agent.loadSession(createLoadSessionRequest("shared-session"));
    await expect(agent.loadSession(createLoadSessionRequest("new-session"))).rejects.toThrow(
      /session creation rate limit exceeded/i,
    );

    sessionStore.clearAllSessionsForTest();
  });
});

describe("acp unsupported bridge session setup", () => {
  it("rejects per-session MCP servers on newSession", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = vi.spyOn(connection, "sessionUpdate");
    const agent = new AcpGatewayAgent(connection, createAcpGateway(), {
      sessionStore,
    });

    await expect(
      agent.newSession({
        ...createNewSessionRequest(),
        mcpServers: [{ name: "docs", command: "mcp-docs" }] as never[],
      }),
    ).rejects.toThrow(/does not support per-session MCP servers/i);

    expect(sessionStore.hasSession("docs-session")).toBe(false);
    expect(sessionUpdate).not.toHaveBeenCalled();
    sessionStore.clearAllSessionsForTest();
  });

  it("rejects per-session MCP servers on loadSession", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = vi.spyOn(connection, "sessionUpdate");
    const agent = new AcpGatewayAgent(connection, createAcpGateway(), {
      sessionStore,
    });

    await expect(
      agent.loadSession({
        ...createLoadSessionRequest("docs-session"),
        mcpServers: [{ name: "docs", command: "mcp-docs" }] as never[],
      }),
    ).rejects.toThrow(/does not support per-session MCP servers/i);

    expect(sessionStore.hasSession("docs-session")).toBe(false);
    expect(sessionUpdate).not.toHaveBeenCalled();
    sessionStore.clearAllSessionsForTest();
  });
});

describe("acp session UX bridge behavior", () => {
  it("returns initial modes and thought-level config options for new sessions", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      sessionStore,
    });

    const result = await agent.newSession(createNewSessionRequest());

    expect(result.modes?.currentModeId).toBe("adaptive");
    expect(result.modes?.availableModes.map((mode) => mode.id)).toContain("adaptive");
    expect(result.configOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "thought_level",
          currentValue: "adaptive",
          category: "thought_level",
        }),
        expect.objectContaining({
          id: "verbose_level",
          currentValue: "off",
        }),
        expect.objectContaining({
          id: "reasoning_level",
          currentValue: "off",
        }),
        expect.objectContaining({
          id: "response_usage",
          currentValue: "off",
        }),
        expect.objectContaining({
          id: "elevated_level",
          currentValue: "off",
        }),
      ]),
    );

    sessionStore.clearAllSessionsForTest();
  });

  it("replays user text, assistant text, and hidden assistant thinking on loadSession", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          ts: Date.now(),
          path: "/tmp/sessions.json",
          count: 1,
          defaults: {
            modelProvider: null,
            model: null,
            contextTokens: null,
          },
          sessions: [
            {
              key: "agent:main:work",
              label: "main-work",
              displayName: "Main work",
              derivedTitle: "Fix ACP bridge",
              kind: "direct",
              updatedAt: 1_710_000_000_000,
              thinkingLevel: "high",
              modelProvider: "openai",
              model: "gpt-5.4",
              verboseLevel: "full",
              reasoningLevel: "stream",
              responseUsage: "tokens",
              elevatedLevel: "ask",
              totalTokens: 4096,
              totalTokensFresh: true,
              contextTokens: 8192,
            },
          ],
        };
      }
      if (method === "sessions.get") {
        return {
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
        };
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    const result = await agent.loadSession(createLoadSessionRequest("agent:main:work"));

    expect(result.modes?.currentModeId).toBe("high");
    expect(result.modes?.availableModes.map((mode) => mode.id)).toEqual(
      listThinkingLevels("openai", "gpt-5.4"),
    );
    expect(result.configOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "thought_level",
          currentValue: "high",
        }),
        expect.objectContaining({
          id: "verbose_level",
          currentValue: "full",
        }),
        expect.objectContaining({
          id: "reasoning_level",
          currentValue: "stream",
        }),
        expect.objectContaining({
          id: "response_usage",
          currentValue: "tokens",
        }),
        expect.objectContaining({
          id: "elevated_level",
          currentValue: "ask",
        }),
      ]),
    );
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Question" },
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Internal loop about NO_REPLY" },
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Answer" },
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: expect.objectContaining({
        sessionUpdate: "available_commands_update",
      }),
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: {
        sessionUpdate: "session_info_update",
        title: "Fix ACP bridge",
        updatedAt: "2024-03-09T16:00:00.000Z",
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: {
        sessionUpdate: "usage_update",
        used: 4096,
        size: 8192,
        _meta: {
          source: "gateway-session-store",
          approximate: true,
        },
      },
    });

    sessionStore.clearAllSessionsForTest();
  });

  it("falls back to an empty transcript when sessions.get fails during loadSession", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          ts: Date.now(),
          path: "/tmp/sessions.json",
          count: 1,
          defaults: {
            modelProvider: null,
            model: null,
            contextTokens: null,
          },
          sessions: [
            {
              key: "agent:main:recover",
              label: "recover",
              displayName: "Recover session",
              kind: "direct",
              updatedAt: 1_710_000_000_000,
              thinkingLevel: "adaptive",
              modelProvider: "openai",
              model: "gpt-5.4",
            },
          ],
        };
      }
      if (method === "sessions.get") {
        throw new Error("sessions.get unavailable");
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    const result = await agent.loadSession(createLoadSessionRequest("agent:main:recover"));

    expect(result.modes?.currentModeId).toBe("adaptive");
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:recover",
      update: expect.objectContaining({
        sessionUpdate: "available_commands_update",
      }),
    });
    expect(sessionUpdate).not.toHaveBeenCalledWith({
      sessionId: "agent:main:recover",
      update: expect.objectContaining({
        sessionUpdate: "user_message_chunk",
      }),
    });

    sessionStore.clearAllSessionsForTest();
  });
});

describe("acp setSessionMode bridge behavior", () => {
  it("surfaces gateway mode patch failures instead of succeeding silently", async () => {
    const sessionStore = createInMemorySessionStore();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        throw new Error("gateway rejected mode");
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("mode-session"));

    await expect(
      agent.setSessionMode(createSetSessionModeRequest("mode-session", "high")),
    ).rejects.toThrow(/gateway rejected mode/i);

    sessionStore.clearAllSessionsForTest();
  });
});

describe("acp prompt size hardening", () => {
  it("rejects oversized prompt blocks without leaking active runs", async () => {
    await expectOversizedPromptRejected({
      sessionId: "prompt-limit-oversize",
      text: "a".repeat(2 * 1024 * 1024 + 1),
    });
  });

  it("rejects oversize final messages from cwd prefix without leaking active runs", async () => {
    await expectOversizedPromptRejected({
      sessionId: "prompt-limit-prefix",
      text: "a".repeat(2 * 1024 * 1024),
    });
  });
});
