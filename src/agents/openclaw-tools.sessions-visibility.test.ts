import { expect, it, vi } from "vitest";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";

const callGatewayMock = vi.fn();
let mockConfig: Record<string, unknown> = {};
function history(sandboxed?: boolean) {
  return createSessionsHistoryTool({
    agentSessionKey: "main",
    sandboxed,
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

it("keeps same-agent history accessible but denies cross-agent history when a2a is explicitly disabled", async () => {
  mockConfig = {
    session: { mainKey: "main", scope: "per-sender" },
    tools: { agentToAgent: { enabled: false } },
  };
  mockGatewayWithHistory((req) =>
    req.method === "sessions.resolve" ? { key: req.params?.key } : undefined,
  );

  const tool = history();
  const sessionKey = "agent:main:quietchat:direct:someone-else";
  expect((await tool.execute("call1", { sessionKey })).details).toMatchObject({ sessionKey });

  expect(
    (await tool.execute("call-cross-agent", { sessionKey: "agent:other:main" })).details,
  ).toEqual({
    status: "forbidden",
    error:
      "Agent-to-agent history is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent access.",
  });
});

it("lists and reads another agent's session by default with no tools configuration", async () => {
  mockConfig = {};
  const sessionKey = "agent:other:main";
  const session = { key: sessionKey, agentId: "other" };
  mockGatewayWithHistory(({ method }) =>
    method === "sessions.list"
      ? { sessions: [session] }
      : method === "sessions.resolve"
        ? session
        : undefined,
  );
  const list = createSessionsListTool({
    agentSessionKey: "agent:main:main",
    config: {},
    callGateway: (opts: unknown) => callGatewayMock(opts),
  });
  expect((await list.execute("call-list", {})).details).toMatchObject({
    count: 1,
    sessions: [{ key: sessionKey, agentId: "other" }],
  });

  const result = await history().execute("call3", { sessionKey });
  expect(result.details).toMatchObject({
    sessionKey,
    messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
  });
});

it("clamps sandboxed sessions to tree when agents.defaults.sandbox.sessionToolsVisibility=spawned", async () => {
  mockConfig = {
    session: { mainKey: "main", scope: "per-sender" },
    tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true, allow: ["*"] } },
    agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
  };
  mockGatewayWithHistory((req) =>
    req.method === "sessions.resolve" && req.params?.spawnedBy === "main" ? {} : undefined,
  );

  expect(
    (await history(true).execute("call4", { sessionKey: "agent:other:main" })).details,
  ).toMatchObject({ status: "forbidden" });
});
