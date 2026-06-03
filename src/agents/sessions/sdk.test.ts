import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Model } from "../../llm/types.js";
import { toClientToolDefinitions } from "../agent-tool-definition-adapter.js";
import { AuthStorage } from "./auth-storage.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { LoadExtensionsResult, RegisteredTool, ToolDefinition } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { createSyntheticSourceInfo } from "./source-info.js";

const testModel: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

function createEmptyResourceLoader(): ResourceLoader {
  return createResourceLoaderWithHandlers(new Map());
}

function createResourceLoaderWithHandlers(
  handlers: Map<string, Array<(...args: unknown[]) => Promise<unknown>>>,
): ResourceLoader {
  const extensionsResult: LoadExtensionsResult = {
    extensions:
      handlers.size > 0
        ? [
            {
              path: "<test-extension>",
              resolvedPath: "<test-extension>",
              sourceInfo: createSyntheticSourceInfo("<test-extension>", { source: "temporary" }),
              handlers,
              tools: new Map(),
              messageRenderers: new Map(),
              commands: new Map(),
              flags: new Map(),
              shortcuts: new Map(),
            },
          ]
        : [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function createResourceLoaderWithTools(tools: ToolDefinition[]): ResourceLoader {
  const sourceInfo = createSyntheticSourceInfo("<test-extension>", { source: "temporary" });
  const registeredTools = new Map<string, RegisteredTool>();
  for (const tool of tools) {
    registeredTools.set(tool.name, { definition: tool, sourceInfo });
  }
  const extensionsResult: LoadExtensionsResult = {
    extensions: [
      {
        path: "<test-extension>",
        resolvedPath: "<test-extension>",
        sourceInfo,
        handlers: new Map(),
        tools: registeredTools,
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function createCustomLookupTool(name = "custom_lookup"): ToolDefinition {
  return {
    name,
    label: "Custom Lookup",
    description: "Looks up a test value.",
    promptSnippet: "Lookup test values",
    promptGuidelines: [`Use ${name} for test values.`],
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: "ok" }],
      details: {},
    }),
  };
}

function createUnsupportedSchemaTool(name = "broken_lookup"): ToolDefinition {
  return {
    ...createCustomLookupTool(name),
    parameters: {
      type: "object",
      $dynamicRef: "#broken",
    } as unknown as ToolDefinition["parameters"],
  };
}

describe("createAgentSession tool defaults", () => {
  it("forwards max thinking budgets from settings to the agent", async () => {
    const { session } = await createAgentSession({
      model: testModel,
      resourceLoader: createEmptyResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        thinkingBudgets: {
          high: 16_384,
          max: 32_768,
        },
      }),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    });

    expect(session.agent.thinkingBudgets).toEqual({
      high: 16_384,
      max: 32_768,
    });
  });

  it("keeps custom tools active when only builtin tools are disabled", async () => {
    const customTool = createCustomLookupTool();

    const { session } = await createAgentSession({
      model: testModel,
      noTools: "builtin",
      customTools: [customTool],
      resourceLoader: createEmptyResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    });

    expect(session.getActiveToolNames()).toEqual(["custom_lookup"]);
    expect(session.getAllTools().map((tool) => tool.name)).toEqual(["custom_lookup"]);

    session.setActiveToolsByName(["bash", "custom_lookup"]);

    expect(session.getActiveToolNames()).toEqual(["custom_lookup"]);
  });

  it("preserves an exact base system prompt when active tools change", async () => {
    const customTool = createCustomLookupTool();

    const { session } = await createAgentSession({
      model: testModel,
      noTools: "builtin",
      customTools: [customTool],
      resourceLoader: createEmptyResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    });
    const systemPrompt = "You are a personal assistant running inside OpenClaw.";

    session.setBaseSystemPrompt(systemPrompt);
    session.setActiveToolsByName(["bash", "custom_lookup"]);

    expect(session.getActiveToolNames()).toEqual(["custom_lookup"]);
    expect(session.systemPrompt).toBe(systemPrompt);

    const exactPromptOptions = (
      session as unknown as {
        baseSystemPromptOptions: {
          selectedTools?: string[];
          toolSnippets?: Record<string, string>;
          promptGuidelines?: string[];
        };
      }
    ).baseSystemPromptOptions;
    expect(exactPromptOptions.selectedTools).toEqual(["custom_lookup"]);
    expect(exactPromptOptions.toolSnippets).toEqual({
      custom_lookup: "Lookup test values",
    });
    expect(exactPromptOptions.promptGuidelines).toEqual(["Use custom_lookup for test values."]);
  });

  it("quarantines SDK custom tools with unsupported runtime schemas", async () => {
    const { session } = await createAgentSession({
      model: testModel,
      noTools: "builtin",
      customTools: [createUnsupportedSchemaTool(), createCustomLookupTool("healthy_lookup")],
      resourceLoader: createEmptyResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    });

    expect(session.getActiveToolNames()).toEqual(["healthy_lookup"]);
    expect(session.getAllTools().map((tool) => tool.name)).toEqual(["healthy_lookup"]);
  });

  it("quarantines SDK custom tools with unreadable names before startup", async () => {
    const unreadableName = createCustomLookupTool("broken_lookup");
    Object.defineProperty(unreadableName, "name", {
      enumerable: true,
      get() {
        throw new Error("custom tool name exploded");
      },
    });

    const { session } = await createAgentSession({
      model: testModel,
      noTools: "builtin",
      customTools: [unreadableName, createCustomLookupTool("healthy_lookup")],
      resourceLoader: createEmptyResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    });

    expect(session.getActiveToolNames()).toEqual(["healthy_lookup"]);
    expect(session.getAllTools().map((tool) => tool.name)).toEqual(["healthy_lookup"]);
  });

  it("does not inspect schema fields for disabled SDK custom tools", async () => {
    let parametersRead = false;
    const disabledBroken = createCustomLookupTool("disabled_broken_lookup");
    Object.defineProperty(disabledBroken, "parameters", {
      enumerable: true,
      get() {
        parametersRead = true;
        throw new Error("disabled tool parameters should not be read");
      },
    });

    const { session } = await createAgentSession({
      model: testModel,
      tools: ["healthy_lookup"],
      customTools: [disabledBroken, createCustomLookupTool("healthy_lookup")],
      resourceLoader: createEmptyResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    });

    expect(parametersRead).toBe(false);
    expect(session.getActiveToolNames()).toEqual(["healthy_lookup"]);
    expect(session.getAllTools().map((tool) => tool.name)).toEqual(["healthy_lookup"]);
  });

  it("quarantines extension-registered tools with unsupported runtime schemas", async () => {
    const { session } = await createAgentSession({
      model: testModel,
      noTools: "builtin",
      resourceLoader: createResourceLoaderWithTools([
        createUnsupportedSchemaTool("extension_broken_lookup"),
        createCustomLookupTool("extension_healthy_lookup"),
      ]),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    });

    expect(session.getActiveToolNames()).toEqual(["extension_healthy_lookup"]);
    expect(session.getAllTools().map((tool) => tool.name)).toEqual(["extension_healthy_lookup"]);
  });

  it("preserves method receivers when materializing valid custom tools", async () => {
    const statefulTool = {
      ...createCustomLookupTool("stateful_lookup"),
      value: "receiver-ok",
      async execute() {
        return {
          content: [{ type: "text" as const, text: this.value }],
          details: {},
        };
      },
    } satisfies ToolDefinition & { value: string };

    const { session } = await createAgentSession({
      model: testModel,
      noTools: "builtin",
      customTools: [statefulTool],
      resourceLoader: createEmptyResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    });

    const tool = session.state.tools.find((entry) => entry.name === "stateful_lookup");
    await expect(tool?.execute("call_1", {}, undefined, undefined)).resolves.toMatchObject({
      content: [{ type: "text", text: "receiver-ok" }],
    });
  });

  it("keeps client tools without parameter schemas active", async () => {
    const [clientTool] = toClientToolDefinitions([
      {
        type: "function",
        function: {
          name: "client_ping",
          description: "Ping",
        },
      },
    ]);
    if (!clientTool) {
      throw new Error("missing client tool definition");
    }

    const { session } = await createAgentSession({
      model: testModel,
      tools: ["client_ping"],
      customTools: [clientTool],
      resourceLoader: createEmptyResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    });

    expect(session.getActiveToolNames()).toEqual(["client_ping"]);
    expect(session.getAllTools().map((tool) => tool.name)).toEqual(["client_ping"]);
  });

  it("runs session message persistence under the configured write lock", async () => {
    const events: string[] = [];
    const sessionManager = SessionManager.inMemory();
    const { session } = await createAgentSession({
      model: testModel,
      resourceLoader: createEmptyResourceLoader(),
      sessionManager,
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
      withSessionWriteLock: async (run) => {
        events.push("lock:start");
        try {
          return await run();
        } finally {
          events.push("lock:end");
        }
      },
    });

    const handleAgentEvent = (
      session as unknown as { handleAgentEvent(event: unknown): Promise<void> }
    )["handleAgentEvent"];

    await handleAgentEvent({
      type: "message_end",
      message: {
        role: "user",
        content: "hello",
        timestamp: Date.now(),
      },
    });

    expect(events).toEqual(["lock:start", "lock:end"]);
    expect(sessionManager.getEntries().some((entry) => entry.type === "message")).toBe(true);
  });

  it("runs write-capable tool hooks under the configured write lock", async () => {
    const events: string[] = [];
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      [
        "tool_call",
        [
          async () => {
            events.push("hook");
            return undefined;
          },
        ],
      ],
    ]);

    const { session } = await createAgentSession({
      model: testModel,
      resourceLoader: createResourceLoaderWithHandlers(handlers),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
      withSessionWriteLock: async (run) => {
        events.push("lock:start");
        try {
          return await run();
        } finally {
          events.push("lock:end");
        }
      },
    });

    await session.agent.beforeToolCall?.({
      assistantMessage: {
        role: "assistant",
        content: [],
        api: testModel.api,
        provider: testModel.provider,
        model: testModel.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
      toolCall: { type: "toolCall", id: "call_1", name: "read", arguments: {} },
      args: {},
      context: {
        systemPrompt: "",
        messages: [],
        tools: [],
      },
    });

    expect(events).toEqual(["lock:start", "hook", "lock:end"]);
  });

  it("fences tool execution when no extension hook is registered", async () => {
    const events: string[] = [];
    const { session } = await createAgentSession({
      model: testModel,
      resourceLoader: createEmptyResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
      withSessionWriteLock: async (run) => {
        events.push("lock:start");
        try {
          return await run();
        } finally {
          events.push("lock:end");
        }
      },
    });

    await session.agent.beforeToolCall?.({
      assistantMessage: {
        role: "assistant",
        content: [],
        api: testModel.api,
        provider: testModel.provider,
        model: testModel.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
      toolCall: { type: "toolCall", id: "call_1", name: "write_file", arguments: {} },
      args: {},
      context: {
        systemPrompt: "",
        messages: [],
        tools: [],
      },
    });

    expect(events).toEqual(["lock:start", "lock:end"]);
  });
});
