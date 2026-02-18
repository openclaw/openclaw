import { describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
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

function getSessionsHistoryTool(options?: { sandboxed?: boolean }) {
  const tool = createOpenClawTools({
    agentSessionKey: "main",
    sandboxed: options?.sandboxed,
  }).find((candidate) => candidate.name === "sessions_history");
  expect(tool).toBeDefined();
  if (!tool) {
    throw new Error("missing sessions_history tool");
  }
  return tool;
}

function mockGatewayWithHistory(
  extra?: (req: { method?: string; params?: Record<string, unknown> }) => unknown,
) {
  callGatewayMock.mockReset();
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

    const tool = getSessionsHistoryTool();

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
    const tool = getSessionsHistoryTool();

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

    const tool = getSessionsHistoryTool({ sandboxed: true });

    const denied = await tool.execute("call4", {
      sessionKey: "agent:other:main",
    });
    expect(denied.details).toMatchObject({ status: "forbidden" });
  });
});
