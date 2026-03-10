import { describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

const runSessionsSendA2AFlowMock = vi.fn();
vi.mock("./tools/sessions-send-tool.a2a.js", () => ({
  runSessionsSendA2AFlow: (params: unknown) => runSessionsSendA2AFlowMock(params),
}));

let mockConfig: Record<string, unknown> = {
  session: { mainKey: "main", scope: "per-sender" },
};
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => mockConfig,
    resolveGatewayPort: () => 18789,
  };
});

import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

function getTool(
  name: "sessions_list" | "sessions_history" | "sessions_send",
  options?: { sandboxed?: boolean; agentSessionKey?: string; agentChannel?: "discord" | "webchat" },
) {
  const tool = createOpenClawTools({
    agentSessionKey: options?.agentSessionKey ?? "main",
    agentChannel: options?.agentChannel,
    sandboxed: options?.sandboxed,
  }).find((candidate) => candidate.name === name);
  expect(tool).toBeDefined();
  if (!tool) {
    throw new Error(`missing ${name} tool`);
  }
  return tool;
}

function mockGatewayWithHistory(
  extra?: (req: { method?: string; params?: Record<string, unknown> }) => unknown,
) {
  callGatewayMock.mockClear();
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const req = opts as { method?: string; params?: Record<string, unknown> };
    const handled = extra?.(req);
    if (handled !== undefined) {
      return handled;
    }
    if (req.method === "chat.history") {
      return { messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] };
    }
    return {};
  });
}

describe("sessions tools visibility", () => {
  it("defaults to tree visibility (self + spawned) for sessions_history", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: { agentToAgent: { enabled: false } },
    };
    mockGatewayWithHistory((req) => {
      if (req.method === "sessions.list" && req.params?.spawnedBy === "main") {
        return { sessions: [{ key: "subagent:child-1" }] };
      }
      if (req.method === "sessions.resolve") {
        const key = typeof req.params?.key === "string" ? String(req.params?.key) : "";
        return { key };
      }
      return undefined;
    });

    const tool = getTool("sessions_history");

    const denied = await tool.execute("call1", {
      sessionKey: "agent:main:discord:direct:someone-else",
    });
    expect(denied.details).toMatchObject({ status: "forbidden" });

    const allowed = await tool.execute("call2", { sessionKey: "subagent:child-1" });
    expect(allowed.details).toMatchObject({
      sessionKey: "subagent:child-1",
    });
  });

  it("allows broader access when tools.sessions.visibility=all", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: false } },
    };
    mockGatewayWithHistory();
    const tool = getTool("sessions_history");

    const result = await tool.execute("call3", {
      sessionKey: "agent:main:discord:direct:someone-else",
    });
    expect(result.details).toMatchObject({
      sessionKey: "agent:main:discord:direct:someone-else",
    });
  });

  it("clamps sandboxed sessions to tree when agents.defaults.sandbox.sessionToolsVisibility=spawned", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true, allow: ["*"] } },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
    };
    mockGatewayWithHistory((req) => {
      if (req.method === "sessions.list" && req.params?.spawnedBy === "main") {
        return { sessions: [] };
      }
      return undefined;
    });

    const tool = getTool("sessions_history", { sandboxed: true });

    const denied = await tool.execute("call4", {
      sessionKey: "agent:other:main",
    });
    expect(denied.details).toMatchObject({ status: "forbidden" });
  });

  it("includes creator-owned ACP sessions in sessions_list when owned ACP visibility is enabled", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "tree", ownedAcp: { enabled: true } },
        agentToAgent: { enabled: false },
      },
    };
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const req = opts as { method?: string; params?: Record<string, unknown> };
      if (req.method === "sessions.list" && req.params?.spawnedBy === "main") {
        return { sessions: [{ key: "agent:ops:acp:owned" }] };
      }
      if (req.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            { key: "main", kind: "direct", sessionId: "s-main" },
            { key: "agent:ops:acp:other", kind: "direct", sessionId: "s-other" },
          ],
        };
      }
      return {};
    });

    const tool = getTool("sessions_list");
    const result = await tool.execute("call-owned-list", {});
    const details = result.details as { sessions?: Array<{ key?: string }> };
    const keys = details.sessions?.map((session) => session.key);

    expect(keys).toContain("main");
    expect(keys).toContain("agent:ops:acp:owned");
    expect(keys).not.toContain("agent:ops:acp:other");
  });

  it("keeps unrelated ACP sessions blocked for sessions_history when owned ACP visibility is enabled", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "tree", ownedAcp: { enabled: true } },
        agentToAgent: { enabled: false },
      },
    };
    mockGatewayWithHistory((req) => {
      if (req.method === "sessions.list" && req.params?.spawnedBy === "main") {
        return { sessions: [{ key: "agent:ops:acp:owned" }] };
      }
      if (req.method === "sessions.resolve") {
        return { key: req.params?.key };
      }
      return undefined;
    });

    const tool = getTool("sessions_history");
    const result = await tool.execute("call-unrelated-history", {
      sessionKey: "agent:ops:acp:other",
    });

    expect(result.details).toMatchObject({
      status: "forbidden",
    });
  });

  it("allows sessions_history for creator-owned ACP sessions when owned ACP visibility is enabled", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "tree", ownedAcp: { enabled: true } },
        agentToAgent: { enabled: false },
      },
    };
    mockGatewayWithHistory((req) => {
      if (req.method === "sessions.list" && req.params?.spawnedBy === "main") {
        return { sessions: [{ key: "agent:ops:acp:owned" }] };
      }
      if (req.method === "sessions.resolve") {
        return { key: req.params?.key };
      }
      return undefined;
    });

    const tool = getTool("sessions_history");
    const result = await tool.execute("call-owned-history", {
      sessionKey: "agent:ops:acp:owned",
    });

    expect(result.details).toMatchObject({
      sessionKey: "agent:ops:acp:owned",
      messages: [{ role: "assistant" }],
    });
  });

  it("allows sessions_send by sessionKey for creator-owned ACP sessions without agent-to-agent access", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender", agentToAgent: { maxPingPongTurns: 0 } },
      tools: {
        sessions: { visibility: "tree", ownedAcp: { enabled: true } },
        agentToAgent: { enabled: false },
      },
    };
    runSessionsSendA2AFlowMock.mockReset();
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const req = opts as { method?: string; params?: Record<string, unknown> };
      if (req.method === "sessions.list" && req.params?.spawnedBy === "main") {
        return { sessions: [{ key: "agent:ops:acp:owned" }] };
      }
      if (req.method === "sessions.resolve") {
        return { key: req.params?.key };
      }
      if (req.method === "agent") {
        return { runId: "run-owned-send" };
      }
      if (req.method === "agent.wait") {
        return { status: "ok" };
      }
      if (req.method === "chat.history") {
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text: "REPLY_SKIP" }] }],
        };
      }
      return {};
    });

    const tool = getTool("sessions_send", { agentChannel: "discord" });
    const result = await tool.execute("call-owned-send-session-key", {
      sessionKey: "agent:ops:acp:owned",
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      sessionKey: "agent:ops:acp:owned",
      reply: "REPLY_SKIP",
    });
  });

  it("allows sessions_send label + agentId lookups for creator-owned ACP sessions", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender", agentToAgent: { maxPingPongTurns: 0 } },
      tools: {
        sessions: { visibility: "tree", ownedAcp: { enabled: true } },
        agentToAgent: { enabled: false },
      },
    };
    runSessionsSendA2AFlowMock.mockReset();
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const req = opts as { method?: string; params?: Record<string, unknown> };
      if (req.method === "sessions.list" && req.params?.spawnedBy === "main") {
        return { sessions: [{ key: "agent:ops:acp:owned" }] };
      }
      if (req.method === "sessions.resolve" && req.params?.label === "owned-acp") {
        return { key: "agent:ops:acp:owned" };
      }
      if (req.method === "agent") {
        return { runId: "run-owned-label" };
      }
      if (req.method === "agent.wait") {
        return { status: "ok" };
      }
      if (req.method === "chat.history") {
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text: "REPLY_SKIP" }] }],
        };
      }
      return {};
    });

    const tool = getTool("sessions_send", { agentChannel: "discord" });
    const result = await tool.execute("call-owned-send-label", {
      label: "owned-acp",
      agentId: "ops",
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      sessionKey: "agent:ops:acp:owned",
      reply: "REPLY_SKIP",
    });
    expect(
      callGatewayMock.mock.calls.find(
        (call) => (call[0] as { method?: string }).method === "sessions.resolve",
      )?.[0],
    ).toMatchObject({
      method: "sessions.resolve",
      params: {
        label: "owned-acp",
        agentId: "ops",
        spawnedBy: "main",
      },
    });
  });

  it("allows sandboxed sessions_send label + agentId lookups for creator-owned ACP sessions", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender", agentToAgent: { maxPingPongTurns: 0 } },
      tools: {
        sessions: { visibility: "tree", ownedAcp: { enabled: true } },
        agentToAgent: { enabled: false },
      },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
    };
    runSessionsSendA2AFlowMock.mockReset();
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const req = opts as { method?: string; params?: Record<string, unknown> };
      if (req.method === "sessions.list" && req.params?.spawnedBy === "main") {
        return { sessions: [{ key: "agent:ops:acp:owned" }] };
      }
      if (req.method === "sessions.resolve" && req.params?.label === "owned-acp") {
        return { key: "agent:ops:acp:owned" };
      }
      if (req.method === "agent") {
        return { runId: "run-owned-sandbox-label" };
      }
      if (req.method === "agent.wait") {
        return { status: "ok" };
      }
      if (req.method === "chat.history") {
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text: "REPLY_SKIP" }] }],
        };
      }
      return {};
    });

    const tool = getTool("sessions_send", { sandboxed: true, agentChannel: "discord" });
    const result = await tool.execute("call-owned-send-sandbox-label", {
      label: "owned-acp",
      agentId: "ops",
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      sessionKey: "agent:ops:acp:owned",
      reply: "REPLY_SKIP",
    });
    expect(
      callGatewayMock.mock.calls.find(
        (call) => (call[0] as { method?: string }).method === "sessions.resolve",
      )?.[0],
    ).toMatchObject({
      method: "sessions.resolve",
      params: {
        label: "owned-acp",
        agentId: "ops",
        spawnedBy: "main",
      },
    });
  });
});
