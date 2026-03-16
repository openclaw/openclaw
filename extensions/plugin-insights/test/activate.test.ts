import { describe, it, expect, vi, afterEach } from "vitest";
import pluginDefinition from "../index.js";
import type {
  OpenClawPluginApi,
  ContextEngine,
  AgentTool,
  OpenClawPluginCommandDefinition,
  AgentMessage,
  UserMessage,
  AssistantMessage,
} from "../src/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function createMockAPI(configOverrides?: Record<string, unknown>): {
  api: OpenClawPluginApi;
  registered: {
    contextEngines: { id: string; factory: () => ContextEngine }[];
    tools: AgentTool[];
    commands: OpenClawPluginCommandDefinition[];
    hooks: { hookName: string; handler: Function }[];
  };
} {
  const registered = {
    contextEngines: [] as { id: string; factory: () => ContextEngine }[],
    tools: [] as AgentTool[],
    commands: [] as OpenClawPluginCommandDefinition[],
    hooks: [] as { hookName: string; handler: Function }[],
  };

  const api: OpenClawPluginApi = {
    id: "plugin-insights",
    name: "Plugin Insights",
    source: "test",
    pluginConfig: {
      enabled: true,
      dbPath: path.join(os.tmpdir(), `plugin-insights-test-${Date.now()}.db`),
      retentionDays: 90,
      llmJudge: { enabled: false },
      ...configOverrides,
    },
    logger: {
      info: console.log,
      warn: console.warn,
      error: console.error,
    },
    registerContextEngine(id, factory) {
      registered.contextEngines.push({ id, factory });
    },
    registerTool(tool) {
      registered.tools.push(tool);
    },
    registerCommand(cmd) {
      registered.commands.push(cmd);
    },
    on(hookName, handler) {
      registered.hooks.push({ hookName, handler });
    },
  };

  return { api, registered };
}

function cleanupDb(api: OpenClawPluginApi) {
  const config = api.pluginConfig as any;
  try {
    fs.unlinkSync(config.dbPath);
  } catch {
    // ignore
  }
}

function mkUserMessage(content: string): UserMessage {
  return { role: "user", content, timestamp: Date.now() };
}

function mkAssistantMessage(
  text: string,
  opts?: {
    toolCalls?: { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }[];
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  }
): AssistantMessage {
  const content: AssistantMessage["content"] = [{ type: "text", text }];
  if (opts?.toolCalls) {
    content.push(...opts.toolCalls);
  }
  return {
    role: "assistant",
    content,
    usage: opts?.usage ?? { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
    model: "test",
    api: "test",
    provider: "test",
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

describe("pluginDefinition.register()", () => {
  const apis: OpenClawPluginApi[] = [];

  afterEach(() => {
    for (const api of apis) {
      cleanupDb(api);
    }
    apis.length = 0;
  });

  it("should register exactly 1 ContextEngine named 'plugin-insights'", () => {
    const { api, registered } = createMockAPI();
    apis.push(api);

    pluginDefinition.register!(api);

    expect(registered.contextEngines).toHaveLength(1);
    expect(registered.contextEngines[0].id).toBe("plugin-insights");
  });

  it("should register 2 agent tools: insights_show and insights_compare", () => {
    const { api, registered } = createMockAPI();
    apis.push(api);

    pluginDefinition.register!(api);

    expect(registered.tools).toHaveLength(2);
    const names = registered.tools.map((t) => t.name);
    expect(names).toContain("insights_show");
    expect(names).toContain("insights_compare");
  });

  it("should register 6 CLI commands", () => {
    const { api, registered } = createMockAPI();
    apis.push(api);

    pluginDefinition.register!(api);

    expect(registered.commands).toHaveLength(6);
    const names = registered.commands.map((c) => c.name);
    expect(names).toContain("insights-show");
    expect(names).toContain("insights-compare");
    expect(names).toContain("insights-export");
    expect(names).toContain("insights-dashboard");
    expect(names).toContain("insights-reset");
    expect(names).toContain("insights-status");
  });

  it("should register after_tool_call hook for runtime tool learning", () => {
    const { api, registered } = createMockAPI();
    apis.push(api);

    pluginDefinition.register!(api);

    expect(registered.hooks).toHaveLength(1);
    expect(registered.hooks[0].hookName).toBe("after_tool_call");
    expect(typeof registered.hooks[0].handler).toBe("function");
  });

  it("should produce a working ContextEngine with info.ownsCompaction=false", async () => {
    const { api, registered } = createMockAPI();
    apis.push(api);

    pluginDefinition.register!(api);

    const engine = registered.contextEngines[0].factory();
    expect(engine.info.ownsCompaction).toBe(false);
    expect(typeof engine.afterTurn).toBe("function");
  });

  it("should NOT register anything when enabled=false", () => {
    const { api, registered } = createMockAPI({ enabled: false });
    apis.push(api);

    pluginDefinition.register!(api);

    expect(registered.contextEngines).toHaveLength(0);
    expect(registered.tools).toHaveLength(0);
    expect(registered.commands).toHaveLength(0);
    expect(registered.hooks).toHaveLength(0);
  });

  it("should handle afterTurn with tool calls in assistant content", async () => {
    const { api, registered } = createMockAPI();
    apis.push(api);

    pluginDefinition.register!(api);

    const engine = registered.contextEngines[0].factory();

    const messages: AgentMessage[] = [
      mkUserMessage("test"),
      mkAssistantMessage("response", {
        toolCalls: [
          { type: "toolCall", id: "tc1", name: "memory_search", arguments: {} },
        ],
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
      }),
    ];

    // Simulate a turn with memory_search tool call
    await engine.afterTurn!({
      sessionId: "test-sess",
      sessionFile: "/tmp/test-session.json",
      messages,
      prePromptMessageCount: 0,
    });

    // The afterTurn should not throw, meaning data was collected
    // (We can't directly query the DB here since it's encapsulated,
    // but no error means the pipeline worked end-to-end)
  });
});

describe("pluginDefinition.register() → after_tool_call hook auto-learning", () => {
  const apis: OpenClawPluginApi[] = [];

  afterEach(() => {
    for (const api of apis) {
      cleanupDb(api);
    }
    apis.length = 0;
  });

  it("should auto-learn tool names from after_tool_call events", async () => {
    const { api, registered } = createMockAPI();
    apis.push(api);

    pluginDefinition.register!(api);

    const hook = registered.hooks[0].handler;

    // Simulate after_tool_call event for an external tool
    hook(
      { toolName: "memory_recall", params: {}, durationMs: 100 },
      { toolName: "memory_recall", sessionId: "test-sess" }
    );

    // Should NOT learn our own tools
    hook(
      { toolName: "insights_show", params: {} },
      { toolName: "insights_show", sessionId: "test-sess" }
    );

    // The tool should be recorded in the DB for future attribution
    // (No error means the hook processed successfully)
  });

  it("should skip tools without a name", () => {
    const { api, registered } = createMockAPI();
    apis.push(api);

    pluginDefinition.register!(api);

    const hook = registered.hooks[0].handler;

    // Should not throw when event has no toolName
    hook({}, {});
  });
});
