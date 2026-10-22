import { expect, it, vi } from "vitest";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";

it("sessions_list filters visibility before hydrating mailbox previews and messages", async () => {
  callGatewayMock.mockReset();
  const mainKey = "agent:main:main";
  type GatewayCall = { method?: string; params?: Record<string, unknown> };
  const session = (key: string, classification: string, extra = {}) => ({
    key: `agent:main:${key}`,
    kind: "direct",
    classification,
    sessionId: key,
    updatedAt: 10,
    ...extra,
  });
  const sessions = [
    session("main", "main", { lastChannel: "whatsapp", lastMessagePreview: "Latest update" }),
    session("discord:group:dev", "group", {
      kind: "group",
      peerKind: "group",
      channel: "discord",
      displayName: "discord:g-dev",
      status: "running",
      startedAt: 100,
      runtimeMs: 42,
      estimatedCostUsd: 0.0042,
      childSessions: ["agent:main:subagent:worker"],
      derivedTitle: "Dev room",
      lastMessagePreview: "Need review",
    }),
    session("dashboard:child", "dashboard", { parentSessionKey: mainKey }),
    session("subagent:worker", "subagent", { spawnedBy: mainKey }),
    session("cron:job-1", "cron"),
    { key: "global", kind: "global", classification: "global", agentId: "main" },
    { key: "unknown", kind: "unknown", classification: "unknown", agentId: "main" },
    { key: "agent:other:main", agentId: "other", sessionId: "hidden", classification: "main" },
  ];
  callGatewayMock.mockImplementation(async (request: GatewayCall) => {
    if (request.method === "sessions.list") {
      return { sessions };
    }
    if (request.method === "sessions.describe") {
      const row = sessions.find((entry) => entry.key === request.params?.key);
      return {
        session: row
          ? { ...row, ...(row.key === mainKey ? { derivedTitle: "Main mailbox" } : {}) }
          : null,
      };
    }
    return request.method === "chat.history"
      ? {
          messages: [
            { role: "toolResult", content: [] },
            { role: "assistant", content: [{ type: "text", text: "hi" }] },
          ],
        }
      : {};
  });
  const result = await createSessionsListTool({
    callGateway: callGatewayMock,
    agentSessionKey: mainKey,
    config: {
      session: { mainKey: "main", scope: "per-sender" },
      tools: { sessions: { visibility: "agent" }, agentToAgent: { enabled: false } },
    },
  }).execute("mailbox", {
    agentId: "main",
    label: "mailbox",
    search: "review",
    includeDerivedTitles: true,
    includeLastMessage: true,
    messageLimit: 1,
  });
  expect(callGatewayMock).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      method: "sessions.list",
      params: expect.objectContaining({
        agentId: "main",
        label: "mailbox",
        search: "review",
        includeDerivedTitles: false,
        includeLastMessage: false,
      }),
    }),
  );
  const described = callGatewayMock.mock.calls
    .map(([request]) => request)
    .filter((request: GatewayCall) => request.method === "sessions.describe")
    .map((request: GatewayCall) => request.params?.key);
  expect(described).toContain(mainKey);
  expect(described).not.toContain("agent:other:main");
  expect(result.details).toMatchObject({
    count: 5,
    sessions: [
      {
        key: mainKey,
        agentId: "main",
        channel: "whatsapp",
        derivedTitle: "Main mailbox",
        lastMessagePreview: "Latest update",
        messages: [{ role: "assistant" }],
      },
      {
        key: "agent:main:discord:group:dev",
        status: "running",
        childSessions: ["agent:main:subagent:worker"],
        derivedTitle: "Dev room",
        lastMessagePreview: "Need review",
      },
      { key: "agent:main:dashboard:child", parentSessionKey: mainKey },
      { key: "agent:main:subagent:worker", parentSessionKey: mainKey },
      { key: "agent:main:cron:job-1", kind: "cron" },
    ],
  });
});

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
