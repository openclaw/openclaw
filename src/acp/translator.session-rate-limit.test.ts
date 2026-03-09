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
