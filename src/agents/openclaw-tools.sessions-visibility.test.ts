import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

let mockConfig: Record<string, unknown> = {
  session: { mainKey: "main", scope: "per-sender" },
};
vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => mockConfig,
    resolveGatewayPort: () => 18789,
  };
});
function getSessionsHistoryTool(options?: { agentSessionKey?: string; sandboxed?: boolean }) {
  return createSessionsHistoryTool({
    agentSessionKey: options?.agentSessionKey ?? "main",
    sandboxed: options?.sandboxed,
    config: mockConfig as never,
    callGateway: (opts: unknown) => callGatewayMock(opts),
  });
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
  beforeEach(() => {
    callGatewayMock.mockClear();
  });

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
        const key = typeof req.params?.key === "string" ? req.params.key : "";
        return { key };
      }
      return undefined;
    });

    const tool = getSessionsHistoryTool();

    const denied = await tool.execute("call1", {
      sessionKey: "agent:main:quietchat:direct:someone-else",
    });
    expect((denied.details as { status?: string }).status).toBe("forbidden");

    const allowed = await tool.execute("call2", { sessionKey: "subagent:child-1" });
    expect((allowed.details as { sessionKey?: string }).sessionKey).toBe("subagent:child-1");
  });

  it("allows broader access when tools.sessions.visibility=all", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: false } },
    };
    mockGatewayWithHistory();
    const tool = getSessionsHistoryTool();

    const result = await tool.execute("call3", {
      sessionKey: "agent:main:quietchat:direct:someone-else",
    });
    expect((result.details as { sessionKey?: string }).sessionKey).toBe(
      "agent:main:quietchat:direct:someone-else",
    );
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

    const tool = getSessionsHistoryTool({ sandboxed: true });

    const denied = await tool.execute("call4", {
      sessionKey: "agent:other:main",
    });
    expect((denied.details as { status?: string }).status).toBe("forbidden");
  });

  it("denies cmo reading rodrigo sessions_history even with all visibility and a2a enabled", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true, allow: ["*"] } },
    };
    mockGatewayWithHistory((req) => {
      if (req.method === "sessions.resolve") {
        const key = typeof req.params?.key === "string" ? req.params.key : "";
        return { key };
      }
      return undefined;
    });

    const tool = getSessionsHistoryTool({ agentSessionKey: "agent:cmo:main" });
    const denied = await tool.execute("call-cmo-rodrigo", {
      sessionKey: "agent:rodrigo:main",
    });

    expect((denied.details as { status?: string }).status).toBe("forbidden");
    expect((denied.details as { error?: string }).error).toContain(
      "Only James/main OOA may read other agents' histories",
    );
    expect(
      callGatewayMock.mock.calls.some(
        (call) => (call[0] as { method?: string }).method === "chat.history",
      ),
    ).toBe(false);
  });

  it("denies rodrigo reading cmo sessions_history even with all visibility and a2a enabled", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true, allow: ["*"] } },
    };
    mockGatewayWithHistory((req) => {
      if (req.method === "sessions.resolve") {
        const key = typeof req.params?.key === "string" ? req.params.key : "";
        return { key };
      }
      return undefined;
    });

    const tool = getSessionsHistoryTool({ agentSessionKey: "agent:rodrigo:main" });
    const denied = await tool.execute("call-rodrigo-cmo", {
      sessionKey: "agent:cmo:main",
    });

    expect((denied.details as { status?: string }).status).toBe("forbidden");
    expect(
      callGatewayMock.mock.calls.some(
        (call) => (call[0] as { method?: string }).method === "chat.history",
      ),
    ).toBe(false);
  });

  it("allows same-agent sessions_history for the caller's own agent", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true, allow: ["*"] } },
    };
    mockGatewayWithHistory((req) => {
      if (req.method === "sessions.resolve") {
        const key = typeof req.params?.key === "string" ? req.params.key : "";
        return { key };
      }
      return undefined;
    });

    const tool = getSessionsHistoryTool({ agentSessionKey: "agent:cmo:main" });
    const allowed = await tool.execute("call-cmo-own", {
      sessionKey: "agent:cmo:telegram:direct:428565749",
    });

    expect((allowed.details as { sessionKey?: string }).sessionKey).toBe(
      "agent:cmo:telegram:direct:428565749",
    );
    expect(
      callGatewayMock.mock.calls.some(
        (call) => (call[0] as { method?: string }).method === "chat.history",
      ),
    ).toBe(true);
  });

  it("allows James/main OOA to read another agent sessions_history", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true, allow: ["*"] } },
    };
    mockGatewayWithHistory((req) => {
      if (req.method === "sessions.resolve") {
        const key = typeof req.params?.key === "string" ? req.params.key : "";
        return { key };
      }
      return undefined;
    });

    const tool = getSessionsHistoryTool({ agentSessionKey: "agent:main:main" });
    const allowed = await tool.execute("call-main-cmo", {
      sessionKey: "agent:cmo:main",
    });

    expect((allowed.details as { sessionKey?: string }).sessionKey).toBe("agent:cmo:main");
  });

  it("denies elevated non-OOA sessions_history after resolving another agent sessionId", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true, allow: ["*"] } },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "all" } } },
    };
    mockGatewayWithHistory((req) => {
      if (req.method === "sessions.resolve" && req.params?.sessionId === "sess-rodrigo") {
        return { key: "agent:rodrigo:main" };
      }
      return undefined;
    });

    const tool = getSessionsHistoryTool({
      agentSessionKey: "agent:cmo:main",
      sandboxed: false,
    });
    const denied = await tool.execute("call-cmo-rodrigo-session-id", {
      sessionKey: "sess-rodrigo",
    });

    expect((denied.details as { status?: string }).status).toBe("forbidden");
    expect(
      callGatewayMock.mock.calls.some(
        (call) => (call[0] as { method?: string }).method === "chat.history",
      ),
    ).toBe(false);
  });
});
