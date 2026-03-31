import { beforeEach, describe, expect, it, vi } from "vitest";

function createStubTool(name: string) {
  return {
    name,
    description: `${name} stub`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(async () => ({ output: name })),
  };
}

function mockToolFactory(name: string) {
  return () => createStubTool(name);
}

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

vi.mock("./tools/agents-list-tool.js", () => ({
  createAgentsListTool: mockToolFactory("agents_list_stub"),
}));
vi.mock("./tools/cron-tool.js", () => ({
  createCronTool: mockToolFactory("cron_stub"),
}));
vi.mock("./tools/gateway-tool.js", () => ({
  createGatewayTool: mockToolFactory("gateway_stub"),
}));
vi.mock("./tools/image-generate-tool.js", () => ({
  createImageGenerateTool: mockToolFactory("image_generate_stub"),
}));
vi.mock("./tools/message-tool.js", () => ({
  createMessageTool: mockToolFactory("message_stub"),
}));
vi.mock("./tools/nodes-tool.js", () => ({
  createNodesTool: mockToolFactory("nodes_stub"),
}));
vi.mock("./tools/pdf-tool.js", () => ({
  createPdfTool: mockToolFactory("pdf_stub"),
}));
vi.mock("./tools/session-status-tool.js", () => ({
  createSessionStatusTool: mockToolFactory("session_status_stub"),
}));
vi.mock("./tools/sessions-list-tool.js", () => ({
  createSessionsListTool: mockToolFactory("sessions_list_stub"),
}));
vi.mock("./tools/sessions-yield-tool.js", () => ({
  createSessionsYieldTool: mockToolFactory("sessions_yield_stub"),
}));
vi.mock("./tools/subagents-tool.js", () => ({
  createSubagentsTool: mockToolFactory("subagents_stub"),
}));
vi.mock("./tools/tts-tool.js", () => ({
  createTtsTool: mockToolFactory("tts_stub"),
}));

import "./test-helpers/fast-core-tools.js";

let createOpenClawTools: typeof import("./openclaw-tools.js").createOpenClawTools;

async function loadFreshOpenClawToolsModuleForTest() {
  vi.resetModules();
  vi.doMock("../gateway/call.js", () => ({
    callGateway: (opts: unknown) => callGatewayMock(opts),
  }));
  vi.doMock("../config/config.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../config/config.js")>();
    return {
      ...actual,
      loadConfig: () => mockConfig,
      resolveGatewayPort: () => 18789,
    };
  });
  ({ createOpenClawTools } = await import("./openclaw-tools.js"));
}

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

function getToolByName(name: string, options?: { sandboxed?: boolean }) {
  const tool = createOpenClawTools({
    agentSessionKey: "main",
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
  beforeEach(async () => {
    await loadFreshOpenClawToolsModuleForTest();
  });

  it("registers real sessions_send and sessions_spawn schemas through createOpenClawTools", () => {
    const sessionsSend = getToolByName("sessions_send");
    const sessionsSendSchema = sessionsSend.parameters as {
      anyOf?: unknown;
      oneOf?: unknown;
      properties?: Record<string, { type?: unknown }>;
    };
    expect(sessionsSendSchema.anyOf).toBeUndefined();
    expect(sessionsSendSchema.oneOf).toBeUndefined();
    expect(sessionsSendSchema.properties?.timeoutSeconds?.type).toBe("number");

    const sessionsSpawn = getToolByName("sessions_spawn");
    const sessionsSpawnSchema = sessionsSpawn.parameters as {
      anyOf?: unknown;
      oneOf?: unknown;
      properties?: Record<string, { type?: unknown }>;
    };
    expect(sessionsSpawnSchema.anyOf).toBeUndefined();
    expect(sessionsSpawnSchema.oneOf).toBeUndefined();
    expect(sessionsSpawnSchema.properties?.thinking?.type).toBe("string");
    expect(sessionsSpawnSchema.properties?.runTimeoutSeconds?.type).toBe("number");
    expect(sessionsSpawnSchema.properties?.timeoutSeconds?.type).toBe("number");
    expect(sessionsSpawnSchema.properties?.thread?.type).toBe("boolean");
    expect(sessionsSpawnSchema.properties?.mode?.type).toBe("string");
    expect(sessionsSpawnSchema.properties?.sandbox?.type).toBe("string");
    expect(sessionsSpawnSchema.properties?.streamTo?.type).toBe("string");
    expect(sessionsSpawnSchema.properties?.runtime?.type).toBe("string");
    expect(sessionsSpawnSchema.properties?.cwd?.type).toBe("string");
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
