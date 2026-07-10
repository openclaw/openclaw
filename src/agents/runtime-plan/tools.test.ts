// Runtime plan tool tests cover schema normalization and diagnostics when the
// runtime plan owns tool policy, with legacy provider fallback still available.
import type { AgentTool } from "openclaw/plugin-sdk/agent-core";
import {
  createNativeOpenAIResponsesModel,
  createParameterFreeTool,
  normalizedParameterFreeSchema,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { getPluginToolMeta, setPluginToolMeta } from "../../plugins/tools.js";
import { toToolDefinitions } from "../agent-tool-definition-adapter.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import type { ExtensionContext } from "../sessions/index.js";
import type { RuntimeToolSchemaDiagnostic } from "../tool-schema-projection.js";
import {
  getToolTerminalPresentation,
  setToolTerminalPresentation,
} from "../tool-terminal-presentation.js";
import type { AnyAgentTool } from "../tools/common.js";
import { logAgentRuntimeToolDiagnostics, normalizeAgentRuntimeTools } from "./tools.js";
import type { AgentRuntimePlan } from "./types.js";

const mocks = vi.hoisted(() => ({
  logProviderToolSchemaDiagnostics: vi.fn(),
  normalizeProviderToolSchemas: vi.fn(),
}));

vi.mock("../embedded-agent-runner/tool-schema-runtime.js", () => ({
  logProviderToolSchemaDiagnostics: mocks.logProviderToolSchemaDiagnostics,
  normalizeProviderToolSchemas: mocks.normalizeProviderToolSchemas,
}));

describe("AgentRuntimePlan tool policy helpers", () => {
  beforeEach(() => {
    mocks.logProviderToolSchemaDiagnostics.mockReset();
    mocks.normalizeProviderToolSchemas.mockReset();
  });

  afterEach(() => {
    resetGlobalHookRunner();
  });

  it("uses RuntimePlan-owned tool normalization when a plan is available", () => {
    const tools = [createParameterFreeTool()] as AgentTool[];
    const normalized = [
      { ...tools[0], parameters: normalizedParameterFreeSchema() },
    ] as AgentTool[];
    const model = createNativeOpenAIResponsesModel() as never;
    const normalize = vi.fn(() => normalized);
    const runtimePlan = {
      tools: {
        normalize,
        logDiagnostics: vi.fn(),
      },
    } as unknown as AgentRuntimePlan;

    expect(
      normalizeAgentRuntimeTools({
        runtimePlan,
        tools,
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-responses",
        workspaceDir: "/tmp/openclaw-runtime-plan-tools",
        model,
      }),
    ).toEqual(normalized);
    expect(normalize).toHaveBeenCalledWith(tools, {
      workspaceDir: "/tmp/openclaw-runtime-plan-tools",
      modelApi: "openai-responses",
      model,
    });
  });

  it("quarantines unreadable tools before RuntimePlan normalization", () => {
    // Broken plugin tool getters are removed before plan/provider normalization
    // so one bad tool cannot crash the full runtime tool list.
    const healthy = { ...createParameterFreeTool(), name: "healthy" } as AgentTool;
    const unreadable = { ...createParameterFreeTool(), name: "fuzzplugin_unreadable" } as AgentTool;
    Object.defineProperty(unreadable, "parameters", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin parameters getter exploded");
      },
    });
    const tools = [unreadable, healthy];
    const diagnostics: RuntimeToolSchemaDiagnostic[][] = [];
    const normalize = vi.fn((entries: AgentTool[]) => entries);
    const runtimePlan = {
      tools: {
        normalize,
        logDiagnostics: vi.fn(),
      },
    } as unknown as AgentRuntimePlan;

    expect(
      normalizeAgentRuntimeTools({
        runtimePlan,
        tools,
        provider: "openai",
        onPreNormalizationSchemaDiagnostics: (entries) => diagnostics.push([...entries]),
      }),
    ).toEqual([healthy]);
    expect(normalize).toHaveBeenCalledWith([healthy], {
      workspaceDir: undefined,
      modelApi: undefined,
      model: undefined,
    });
    expect(diagnostics).toEqual([
      [
        {
          toolName: "fuzzplugin_unreadable",
          toolIndex: 0,
          violations: ["fuzzplugin_unreadable.parameters is unreadable"],
        },
      ],
    ]);
  });

  it("quarantines non-object schemas before provider schema normalization", () => {
    const healthy = { ...createParameterFreeTool(), name: "healthy" } as AgentTool;
    const arraySchema = {
      ...createParameterFreeTool("fuzzplugin_array_root"),
      parameters: { type: "array", items: { type: "number" } },
    } as unknown as AgentTool;
    const diagnostics: RuntimeToolSchemaDiagnostic[][] = [];
    mocks.normalizeProviderToolSchemas.mockImplementationOnce(({ tools: entries }) => entries);

    expect(
      normalizeAgentRuntimeTools({
        tools: [arraySchema, healthy],
        provider: "openai",
        onPreNormalizationSchemaDiagnostics: (entries) => diagnostics.push([...entries]),
      }),
    ).toEqual([healthy]);
    expect(mocks.normalizeProviderToolSchemas).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [healthy],
        provider: "openai",
      }),
    );
    expect(diagnostics).toEqual([
      [
        {
          toolName: "fuzzplugin_array_root",
          toolIndex: 0,
          violations: ['fuzzplugin_array_root.parameters.type must be "object"'],
        },
      ],
    ]);
  });

  it("accepts legacy optional model fields while normalizing RuntimePlan context", () => {
    const tools = [createParameterFreeTool()] as AgentTool[];
    const normalize = vi.fn(() => tools);
    const runtimePlan = {
      tools: {
        normalize,
        logDiagnostics: vi.fn(),
      },
    } as unknown as AgentRuntimePlan;

    expect(
      normalizeAgentRuntimeTools({
        runtimePlan,
        tools,
        provider: "openai",
        modelApi: null,
      }),
    ).toEqual(tools);
    expect(normalize).toHaveBeenCalledWith(tools, {
      workspaceDir: undefined,
      modelApi: undefined,
      model: undefined,
    });
  });

  it("falls back to legacy provider schema normalization when no plan is available", () => {
    mocks.normalizeProviderToolSchemas.mockReturnValueOnce([
      {
        ...createParameterFreeTool(),
        parameters: normalizedParameterFreeSchema(),
      },
    ]);

    const normalized = normalizeAgentRuntimeTools({
      tools: [createParameterFreeTool()] as AgentTool[],
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      workspaceDir: "/tmp/openclaw-runtime-plan-tools",
      model: createNativeOpenAIResponsesModel() as never,
    });

    expect(normalized[0]?.parameters).toEqual(normalizedParameterFreeSchema());
    expect(mocks.normalizeProviderToolSchemas).toHaveBeenCalledTimes(1);
    expect(mocks.normalizeProviderToolSchemas.mock.calls.at(0)?.[0]).toEqual({
      tools: [createParameterFreeTool()],
      provider: "openai",
      config: undefined,
      workspaceDir: "/tmp/openclaw-runtime-plan-tools",
      env: process.env,
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      model: createNativeOpenAIResponsesModel(),
      allowRuntimePluginLoad: undefined,
    });
  });

  it("preserves plugin metadata when provider schema normalization clones tools", () => {
    // Provider normalization may clone tool objects; plugin metadata has to move
    // with the clone so later dispatch still knows the owning plugin/MCP server.
    const tool = createParameterFreeTool("fixture__lookup_note") as AgentTool;
    setPluginToolMeta(tool, {
      pluginId: "bundle-mcp",
      optional: false,
      mcp: {
        serverName: "fixture",
        safeServerName: "fixture",
        toolName: "lookup_note",
        operation: "tool",
      },
    });
    const normalized = {
      ...tool,
      parameters: normalizedParameterFreeSchema(),
    };
    mocks.normalizeProviderToolSchemas.mockReturnValueOnce([normalized]);

    const result = normalizeAgentRuntimeTools({
      tools: [tool],
      provider: "openai",
    });

    expect(result[0]).not.toBe(normalized);
    expect(getPluginToolMeta(result[0])).toMatchObject({
      pluginId: "bundle-mcp",
      mcp: {
        serverName: "fixture",
        toolName: "lookup_note",
      },
    });
  });

  it("preserves private execution metadata when provider normalization clones tools", () => {
    const formatter = vi.fn(() => ({ text: "Terminal summary" }));
    const tool = {
      ...createParameterFreeTool("web_fetch"),
      label: "Web fetch",
      execute: vi.fn(),
    } as AgentTool;
    const source = setToolTerminalPresentation(
      wrapToolWithBeforeToolCallHook(tool, {
        agentId: "main",
        sessionId: "session-runtime-normalization",
      }),
      formatter,
    );
    (source as AnyAgentTool).catalogMode = "direct-only";
    const normalized = {
      ...createParameterFreeTool("web_fetch"),
      label: "Web fetch",
      execute: vi.fn(),
      parameters: normalizedParameterFreeSchema(),
    } as AgentTool;
    mocks.normalizeProviderToolSchemas.mockReturnValueOnce([normalized]);

    const result = normalizeAgentRuntimeTools({
      tools: [source],
      provider: "openai",
    });

    expect(result[0]).not.toBe(normalized);
    expect((result[0] as AnyAgentTool).catalogMode).toBe("direct-only");
    expect(isToolWrappedWithBeforeToolCallHook(result[0])).toBe(true);
    expect(getToolTerminalPresentation(result[0])).toBe(formatter);
  });

  it("keeps wrapped execution authoritative when normalization replaces callbacks", async () => {
    const sourcePrepareArguments = vi.fn((args: unknown) => args as Record<string, never>);
    const sourcePrepare = vi.fn((params: unknown) => params);
    const sourceFinalize = vi.fn((params: unknown) => params);
    const sourceExecute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "source executed" }],
      details: {},
    }));
    const replacementPrepareArguments = vi.fn((args: unknown) => args as Record<string, never>);
    const replacementPrepare = vi.fn((params: unknown) => params);
    const replacementFinalize = vi.fn((params: unknown) => params);
    const replacementExecute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "replacement executed" }],
      details: {},
    }));
    const source: AnyAgentTool = {
      ...createParameterFreeTool("dangerous_write"),
      label: "Dangerous write",
      prepareArguments: sourcePrepareArguments,
      prepareBeforeToolCallParams: sourcePrepare,
      finalizeBeforeToolCallParams: sourceFinalize,
      executionMode: "sequential" as const,
      execute: sourceExecute,
    };
    const wrapped = wrapToolWithBeforeToolCallHook(source, {
      agentId: "main",
      sessionId: "session-runtime-normalization-policy",
    });
    const registry = createEmptyPluginRegistry();
    registry.finalToolInputPolicies = [
      {
        pluginId: "deny-all-policy",
        source: "test",
        policy: {
          id: "deny-all",
          description: "deny every finalized tool input",
          evaluate: () => ({ outcome: "deny", reasonCode: "test.denied" }),
        },
      },
    ];
    initializeGlobalHookRunner(registry);
    let normalizationExecutionProbe: ReturnType<AnyAgentTool["execute"]> | undefined;
    mocks.normalizeProviderToolSchemas.mockImplementationOnce(({ tools }) => {
      const [normalizationInput] = tools;
      if (!normalizationInput) {
        throw new Error("expected normalization input");
      }
      normalizationExecutionProbe = normalizationInput.execute("normalization-probe", {});
      return [
        {
          ...normalizationInput,
          parameters: normalizedParameterFreeSchema(),
          prepareArguments: replacementPrepareArguments,
          prepareBeforeToolCallParams: replacementPrepare,
          finalizeBeforeToolCallParams: replacementFinalize,
          executionMode: "parallel" as const,
          execute: replacementExecute,
        },
      ];
    });

    const [normalized] = normalizeAgentRuntimeTools({
      tools: [wrapped],
      provider: "openai",
    });
    if (!normalized) {
      throw new Error("expected normalized tool");
    }
    expect(normalized.prepareArguments?.({})).toEqual({});
    expect(sourcePrepareArguments).toHaveBeenCalledOnce();
    expect(normalized.prepareArguments).not.toBe(replacementPrepareArguments);
    expect((normalized as AnyAgentTool).prepareBeforeToolCallParams).not.toBe(replacementPrepare);
    expect((normalized as AnyAgentTool).finalizeBeforeToolCallParams).not.toBe(replacementFinalize);
    expect(normalized.executionMode).toBe("sequential");
    const [definition] = toToolDefinitions([normalized]);
    if (!definition) {
      throw new Error("expected tool definition");
    }
    await expect(normalizationExecutionProbe).resolves.toEqual({
      content: [],
      details: undefined,
    });
    const result = await definition.execute(
      "call-1",
      {},
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    expect(result.content).toEqual([
      { type: "text", text: "Tool call blocked by final input policy" },
    ]);
    expect(sourceExecute).not.toHaveBeenCalled();
    expect(sourcePrepare).toHaveBeenCalledOnce();
    expect(sourceFinalize).toHaveBeenCalledOnce();
    expect(replacementPrepareArguments).not.toHaveBeenCalled();
    expect(replacementPrepare).not.toHaveBeenCalled();
    expect(replacementFinalize).not.toHaveBeenCalled();
    expect(replacementExecute).not.toHaveBeenCalled();
  });

  it("binds projected lifecycle callbacks to the original tool identity", async () => {
    const identityState = new WeakMap<object, string>();
    class IdentityBoundTool {
      readonly #privateIdentity = "private";
      readonly #parameters = createParameterFreeTool().parameters;

      get name() {
        return this.#privateIdentity === "private" ? "identity_bound" : "invalid";
      }

      get label() {
        return this.#privateIdentity === "private" ? "Identity bound" : "invalid";
      }

      get description() {
        return this.#privateIdentity === "private"
          ? "requires its original class identity"
          : "invalid";
      }

      get parameters() {
        return this.#parameters;
      }

      constructor() {
        identityState.set(this, "weakmap");
      }

      private readIdentity(): string {
        return `${this.#privateIdentity}:${identityState.get(this)}`;
      }

      prepareArguments(args: unknown) {
        return { ...(args as Record<string, unknown>), preparedBy: this.readIdentity() };
      }

      prepareBeforeToolCallParams(params: unknown) {
        return { ...(params as Record<string, unknown>), preparedBy: this.readIdentity() };
      }

      finalizeBeforeToolCallParams(params: unknown) {
        return { ...(params as Record<string, unknown>), finalizedBy: this.readIdentity() };
      }

      async execute() {
        return {
          content: [{ type: "text" as const, text: this.readIdentity() }],
          details: {},
        };
      }
    }

    const source = new IdentityBoundTool() as unknown as AnyAgentTool;
    mocks.normalizeProviderToolSchemas.mockImplementationOnce(({ tools }) => {
      const [normalizationInput] = tools;
      if (!normalizationInput) {
        throw new Error("expected normalization input");
      }
      return [
        {
          ...normalizationInput,
          parameters: normalizedParameterFreeSchema(),
          execute: vi.fn(),
        },
      ];
    });

    const [normalized] = normalizeAgentRuntimeTools({
      tools: [source],
      provider: "openai",
    }) as AnyAgentTool[];
    if (!normalized?.prepareBeforeToolCallParams || !normalized.finalizeBeforeToolCallParams) {
      throw new Error("expected projected lifecycle callbacks");
    }
    expect(normalized.prepareArguments?.({})).toEqual({
      preparedBy: "private:weakmap",
    });
    const prepared = await normalized.prepareBeforeToolCallParams({}, {});
    expect(prepared).toEqual({ preparedBy: "private:weakmap" });
    const finalized = await normalized.finalizeBeforeToolCallParams(prepared, prepared);
    expect(finalized).toEqual({
      preparedBy: "private:weakmap",
      finalizedBy: "private:weakmap",
    });
    await expect(normalized.execute("call-identity", finalized)).resolves.toMatchObject({
      content: [{ type: "text", text: "private:weakmap" }],
    });
  });

  it("does not reread quarantined tools while preserving normalized metadata", () => {
    const unreadableName = {
      ...createParameterFreeTool("fuzzplugin_unreadable_name"),
    } as AgentTool;
    Object.defineProperty(unreadableName, "name", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin name getter exploded");
      },
    });
    const healthy = createParameterFreeTool("fixture__lookup_note") as AgentTool;
    setPluginToolMeta(healthy, {
      pluginId: "bundle-mcp",
      optional: false,
      mcp: {
        serverName: "fixture",
        safeServerName: "fixture",
        toolName: "lookup_note",
        operation: "tool",
      },
    });
    const normalized = {
      ...healthy,
      parameters: normalizedParameterFreeSchema(),
    };
    const diagnostics: RuntimeToolSchemaDiagnostic[][] = [];
    mocks.normalizeProviderToolSchemas.mockReturnValueOnce([normalized]);

    const result = normalizeAgentRuntimeTools({
      tools: [unreadableName, healthy],
      provider: "openai",
      onPreNormalizationSchemaDiagnostics: (entries) => diagnostics.push([...entries]),
    });

    expect(result).toEqual([normalized]);
    expect(getPluginToolMeta(result[0])).toMatchObject({
      pluginId: "bundle-mcp",
      mcp: {
        serverName: "fixture",
        toolName: "lookup_note",
      },
    });
    expect(diagnostics).toEqual([
      [
        {
          toolName: "tool[0]",
          toolIndex: 0,
          violations: ["tool[0].name is unreadable"],
        },
      ],
    ]);
  });

  it("quarantines unreadable tools before provider schema normalization", () => {
    const healthy = { ...createParameterFreeTool(), name: "healthy" } as AgentTool;
    const unreadable = { ...createParameterFreeTool(), name: "fuzzplugin_unreadable" } as AgentTool;
    Object.defineProperty(unreadable, "parameters", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin parameters getter exploded");
      },
    });
    const tools = [unreadable, healthy];
    const diagnostics: RuntimeToolSchemaDiagnostic[][] = [];
    mocks.normalizeProviderToolSchemas.mockImplementationOnce(({ tools: entries }) => entries);

    expect(
      normalizeAgentRuntimeTools({
        tools,
        provider: "openai",
        onPreNormalizationSchemaDiagnostics: (entries) => diagnostics.push([...entries]),
      }),
    ).toEqual([healthy]);
    expect(mocks.normalizeProviderToolSchemas).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [healthy],
        provider: "openai",
      }),
    );
    expect(diagnostics).toEqual([
      [
        {
          toolName: "fuzzplugin_unreadable",
          toolIndex: 0,
          violations: ["fuzzplugin_unreadable.parameters is unreadable"],
        },
      ],
    ]);
  });

  it("can normalize without cold-loading provider runtime plugins", () => {
    const tools = [createParameterFreeTool()] as AgentTool[];

    normalizeAgentRuntimeTools({
      tools,
      provider: "openai",
      allowProviderRuntimePluginLoad: false,
    });

    expect(mocks.normalizeProviderToolSchemas).toHaveBeenCalledWith(
      expect.objectContaining({
        tools,
        provider: "openai",
        allowRuntimePluginLoad: false,
      }),
    );
  });

  it("routes diagnostics through RuntimePlan when a plan is available", () => {
    const tools = [createParameterFreeTool()] as AgentTool[];
    const model = createNativeOpenAIResponsesModel() as never;
    const logDiagnostics = vi.fn();
    const runtimePlan = {
      tools: {
        normalize: vi.fn(),
        logDiagnostics,
      },
    } as unknown as AgentRuntimePlan;

    logAgentRuntimeToolDiagnostics({
      runtimePlan,
      tools,
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      workspaceDir: "/tmp/openclaw-runtime-plan-tools",
      model,
    });

    expect(logDiagnostics).toHaveBeenCalledWith(tools, {
      workspaceDir: "/tmp/openclaw-runtime-plan-tools",
      modelApi: "openai-responses",
      model,
    });
  });
});
