// Runtime plan tool tests cover schema normalization and diagnostics when the
// runtime plan owns tool policy, with legacy provider fallback still available.

import { expectDefined } from "@openclaw/normalization-core";
import type { AgentTool } from "openclaw/plugin-sdk/agent-core";
import {
  createNativeOpenAIResponsesModel,
  createParameterFreeTool,
  normalizedParameterFreeSchema,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { getPluginInstance } from "../../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { getPluginToolMeta, setPluginToolMeta } from "../../plugins/tool-metadata.js";
import { wrapToolWithAbortSignal } from "../agent-tools.abort.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import type { RuntimeToolSchemaDiagnostic } from "../tool-schema-projection.js";
import {
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
} from "../tool-search-catalog.js";
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

  it("does not load a provider runtime to normalize an empty tool set", () => {
    const onPreNormalizationSchemaDiagnostics = vi.fn();

    expect(
      normalizeAgentRuntimeTools({
        tools: [],
        provider: "openai",
        onPreNormalizationSchemaDiagnostics,
      }),
    ).toEqual([]);
    expect(onPreNormalizationSchemaDiagnostics).toHaveBeenCalledWith([], []);
    expect(mocks.normalizeProviderToolSchemas).not.toHaveBeenCalled();
  });

  it.each([
    ["plan", "unchanged"],
    ["provider", "unchanged"],
    ["provider", "cloned"],
  ] as const)(
    "owns the assembly array after %s normalization (%s) while retaining plugin tool admission",
    async (route, mode) => {
      const builder = createTestPluginRegistry();
      const record = createPluginRecord({
        id: "normalizer-fixture",
        source: "/synthetic/normalizer-fixture.ts",
        origin: "bundled",
        enabled: true,
        configSchema: false,
      });
      builder.registry.plugins.push(record);
      const api = builder.createApi(record, { config: {} });
      const instance = getPluginInstance(record)!;
      const catalogRef = createToolSearchCatalogRef();
      try {
        const output = { content: [{ type: "text" as const, text: "fixture note" }], details: {} };
        const tool: AgentTool = {
          ...createParameterFreeTool("fixture__lookup_note"),
          label: "Fixture lookup",
          parameters: Type.Object({}),
          execute: vi.fn(async () => output),
        };
        const metadata: Parameters<typeof setPluginToolMeta>[1] = {
          pluginId: "bundle-mcp",
          optional: false,
          mcp: {
            serverName: "fixture",
            safeServerName: "fixture",
            toolName: "lookup_note",
            operation: "tool",
          },
        };
        setPluginToolMeta(tool, metadata);
        api.registerProvider({
          id: "normalizer-fixture",
          label: "Normalizer fixture",
          auth: [],
          normalizeToolSchemas: ({ tools }) =>
            mode === "cloned" ? tools.map((entry) => ({ ...entry })) : tools,
        });
        const provider = expectDefined(
          builder.registry.providers[0],
          "registered provider",
        ).provider;
        const normalize = (tools: AgentTool[]) =>
          provider.normalizeToolSchemas!({ tools, provider: provider.id });
        mocks.normalizeProviderToolSchemas.mockImplementationOnce(({ tools }) => normalize(tools));
        const runtimePlan =
          route === "plan"
            ? ({ tools: { normalize, logDiagnostics: vi.fn() } } as unknown as AgentRuntimePlan)
            : undefined;
        const normalized = normalizeAgentRuntimeTools({
          runtimePlan,
          tools: [tool],
          provider: "openai",
        });
        const normalizedTool = expectDefined(normalized[0], "normalized tool");
        const wrapped = normalized
          .map((entry) => wrapToolWithBeforeToolCallHook(entry))
          .map((entry) => wrapToolWithAbortSignal(entry, new AbortController().signal));
        const wrappedTool = expectDefined(wrapped[0], "wrapped tool");

        expect(getPluginToolMeta(normalizedTool)).toBe(metadata);
        expect(getPluginToolMeta(wrappedTool)).toBe(metadata);
        registerHeadlessToolSearchCatalog({ catalogRef, tools: wrapped });
        expect(catalogRef.current?.entries).toMatchObject([
          { name: tool.name, source: "mcp", sourceName: "fixture", mcp: metadata.mcp },
        ]);
        await expect(normalizedTool.execute("current-call", {})).resolves.toBe(output);
        await expect(wrappedTool.execute("wrapped-call", {})).resolves.toBe(output);
        await instance.dispose();
        expect(() => normalizedTool.execute("retired-call", {})).toThrow(
          "Plugin normalizer-fixture was reloaded or disabled",
        );
        await expect(wrappedTool.execute("retired-wrapped-call", {})).rejects.toThrow(
          "Plugin normalizer-fixture was reloaded or disabled",
        );
      } finally {
        clearToolSearchCatalog({ catalogRef });
        await instance.dispose();
      }
    },
  );

  it.each([true, false])(
    "preserves output schemas and channel-progress visibility (%s) across runtime clones",
    (hideFromChannelProgress) => {
      const outputSchema = Type.Object(
        { id: Type.String(), ready: Type.Boolean() },
        { additionalProperties: false },
      );
      const tool = {
        ...createParameterFreeTool("fixture_status"),
        outputSchema,
      } as unknown as AgentTool;
      Object.defineProperty(tool, "hideFromChannelProgress", { value: hideFromChannelProgress });
      const normalized = {
        ...createParameterFreeTool("fixture_status"),
        parameters: normalizedParameterFreeSchema(),
      } as unknown as AgentTool;
      mocks.normalizeProviderToolSchemas.mockReturnValueOnce([normalized]);

      const result = normalizeAgentRuntimeTools({
        tools: [tool],
        provider: "openai",
      });

      expect(result[0]).toBe(normalized);
      expect(result[0]?.outputSchema).toBe(outputSchema);
      expect(result[0]?.hideFromChannelProgress).toBe(hideFromChannelProgress ? true : undefined);
    },
  );

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

    expect(result[0]).toBe(normalized);
    expect((result[0] as AnyAgentTool).catalogMode).toBe("direct-only");
    expect(
      isToolWrappedWithBeforeToolCallHook(expectDefined(result[0], "result[0] test invariant")),
    ).toBe(true);
    expect(getToolTerminalPresentation(expectDefined(result[0], "result[0] test invariant"))).toBe(
      formatter,
    );
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
    expect(getPluginToolMeta(expectDefined(result[0], "result[0] test invariant"))).toMatchObject({
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
