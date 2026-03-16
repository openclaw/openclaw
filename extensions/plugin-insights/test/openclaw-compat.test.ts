import { describe, it, expect } from "vitest";
import type {
  ContextEngine,
  OpenClawPluginApi,
  AgentTool,
  OpenClawPluginCommandDefinition,
  AgentToolResult,
  ReplyPayload,
  ContextEngineInfo,
  IngestResult,
  AssembleResult,
  CompactResult,
} from "../src/types.js";
import { textToolResult } from "../src/types.js";

/**
 * OpenClaw Compatibility Contract Tests
 *
 * These tests validate that our type interfaces match the expected
 * OpenClaw plugin-sdk contracts (openclaw@2026.3.7+).
 * When integrating with the real SDK, replace these with:
 *   import type { OpenClawPluginApi, ContextEngine, ... } from "openclaw/plugin-sdk";
 *
 * If any of these tests break after importing real OpenClaw types,
 * it means our interface assumptions were wrong and need fixing.
 */
describe("OpenClaw API contract", () => {
  it("OpenClawPluginApi should have all required properties and methods", () => {
    const keys: (keyof OpenClawPluginApi)[] = [
      "id",
      "name",
      "source",
      "pluginConfig",
      "logger",
      "registerContextEngine",
      "registerTool",
      "registerCommand",
    ];

    for (const key of keys) {
      expect(typeof key).toBe("string");
    }
  });

  it("ContextEngine should have info with ownsCompaction, and required methods", () => {
    // Structural contract: minimum ContextEngine matching real SDK
    const minimalEngine: ContextEngine = {
      info: { id: "test", name: "Test", ownsCompaction: false },
      async ingest() {
        return { ingested: true };
      },
      async assemble(params) {
        return { messages: params.messages, estimatedTokens: 0 };
      },
      async compact() {
        return { ok: true, compacted: false };
      },
    };

    expect(minimalEngine.info.ownsCompaction).toBe(false);
    expect(typeof minimalEngine.ingest).toBe("function");
    expect(typeof minimalEngine.assemble).toBe("function");
    expect(typeof minimalEngine.compact).toBe("function");
  });

  it("ContextEngine should allow optional hooks", () => {
    const engine: ContextEngine = {
      info: { id: "test", name: "Test", ownsCompaction: false },
      async ingest() {
        return { ingested: true };
      },
      async assemble(params) {
        return { messages: params.messages, estimatedTokens: 0 };
      },
      async compact() {
        return { ok: true, compacted: false };
      },
    };

    // Optional hooks should be undefined
    expect(engine.bootstrap).toBeUndefined();
    expect(engine.afterTurn).toBeUndefined();
    expect(engine.prepareSubagentSpawn).toBeUndefined();
    expect(engine.onSubagentEnded).toBeUndefined();
    expect(engine.dispose).toBeUndefined();
  });

  it("AgentTool should have name, label, description, parameters, execute", () => {
    const tool: AgentTool = {
      name: "test_tool",
      label: "Test Tool",
      description: "A test tool",
      parameters: { type: "object", properties: {} },
      async execute(_toolCallId, _params) {
        return textToolResult("result");
      },
    };

    expect(tool.name).toBeTruthy();
    expect(tool.label).toBeTruthy();
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });

  it("AgentTool.execute should return AgentToolResult", async () => {
    const tool: AgentTool = {
      name: "test_tool",
      label: "Test Tool",
      description: "A test tool",
      parameters: { type: "object", properties: {} },
      async execute(toolCallId, params) {
        return textToolResult("hello");
      },
    };

    const result = await tool.execute("call-1", {});
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: "text", text: "hello" });
    expect(result.details).toBeUndefined();
  });

  it("OpenClawPluginCommandDefinition should have name, description, handler returning ReplyPayload", () => {
    const cmd: OpenClawPluginCommandDefinition = {
      name: "test cmd",
      description: "A test command",
      handler(_ctx) {
        return { text: "done" };
      },
    };

    expect(cmd.name).toBeTruthy();
    expect(cmd.description).toBeTruthy();
    expect(typeof cmd.handler).toBe("function");

    const result = cmd.handler({
      channel: "test",
      isAuthorizedSender: true,
      commandBody: "test cmd",
      config: {},
    }) as ReplyPayload;
    expect(result.text).toBe("done");
  });

  it("ContextEngine factory should return engine with info.ownsCompaction=false", () => {
    // This mirrors how OpenClaw calls our factory:
    //   api.registerContextEngine("plugin-insights", () => engine)
    const factory = (): ContextEngine => ({
      info: {
        id: "plugin-insights",
        name: "Plugin Insights",
        ownsCompaction: false,
      },
      async ingest() {
        return { ingested: true };
      },
      async assemble(params) {
        return { messages: params.messages, estimatedTokens: 0 };
      },
      async compact() {
        return { ok: true, compacted: false };
      },
      async afterTurn() {},
    });

    const engine = factory();
    expect(engine.info.ownsCompaction).toBe(false);
    expect(engine.info.id).toBe("plugin-insights");
  });
});

describe("OpenClaw integration readiness checklist", () => {
  /**
   * NOTE: These tests document what needs to be verified against
   * the real OpenClaw runtime. They all pass trivially now but
   * serve as a checklist for real integration testing.
   */

  it.todo("afterTurn receives correct AfterTurnParams shape from OpenClaw runtime");
  it.todo("registerContextEngine factory is called exactly once per session");
  it.todo("registerTool makes tools available to the agent via tool_use");
  it.todo("registerCommand makes commands available via `openclaw <cmd>`");
  it.todo("api.on('plugin_insights_report') hook receives cross-plugin reports");
  it.todo("plugin activates correctly after `openclaw plugins install plugin-insights`");
  it.todo("SQLite DB is created at the configured path on first activation");
  it.todo("data survives across multiple openclaw sessions");
});
