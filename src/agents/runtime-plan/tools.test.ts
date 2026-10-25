import { expectDefined } from "@openclaw/normalization-core";
import type { AgentTool } from "openclaw/plugin-sdk/agent-core";
import {
  createNativeOpenAIResponsesModel,
  createParameterFreeTool,
  normalizedParameterFreeSchema,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { getPluginInstance } from "../../plugins/plugin-instance-scope.js";
import type { ProviderPlugin } from "../../plugins/provider-plugin.types.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { getPluginToolMeta, setPluginToolMeta } from "../../plugins/tool-metadata.js";
import { wrapToolWithAbortSignal } from "../agent-tools.abort.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  rewrapToolWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
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
const instances: NonNullable<ReturnType<typeof getPluginInstance>>[] = [];

vi.mock("../embedded-agent-runner/tool-schema-runtime.js", () => ({
  logProviderToolSchemaDiagnostics: mocks.logProviderToolSchemaDiagnostics,
  normalizeProviderToolSchemas: mocks.normalizeProviderToolSchemas,
}));

function createNormalizer(
  id: string,
  normalizeToolSchemas: ProviderPlugin["normalizeToolSchemas"],
) {
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id,
    source: `/synthetic/${id}.ts`,
    origin: "bundled",
    enabled: true,
    configSchema: false,
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {} });
  api.registerProvider({ id, label: id, auth: [], normalizeToolSchemas });
  const provider = expectDefined(builder.registry.providers[0], "registered provider").provider;
  const instance = getPluginInstance(record)!;
  instances.push(instance);
  return { instance, provider };
}

function runtimePlan(normalize: ReturnType<typeof useNormalizer> = vi.fn()) {
  return { tools: { normalize, logDiagnostics: vi.fn() } } as unknown as AgentRuntimePlan;
}

function useNormalizer(provider: ProviderPlugin) {
  const normalize = (tools: AgentTool[]) =>
    provider.normalizeToolSchemas!({ tools, provider: provider.id });
  const implementation = ({ tools }: { tools: AgentTool[] }) => normalize(tools);
  mocks.normalizeProviderToolSchemas.mockImplementationOnce(implementation);
  return normalize;
}

const noteMetadata: Parameters<typeof setPluginToolMeta>[1] = {
  pluginId: "bundle-mcp",
  optional: false,
  mcp: {
    serverName: "fixture",
    safeServerName: "fixture",
    toolName: "lookup_note",
    operation: "tool",
  },
};

function normalizeTools(
  tools: AgentTool[],
  options: Partial<Omit<Parameters<typeof normalizeAgentRuntimeTools>[0], "tools">> = {},
) {
  return normalizeAgentRuntimeTools({ provider: "openai", tools, ...options });
}

function asCallable({ name, ...definition }: AgentTool) {
  const callable = Object.assign(() => undefined, definition);
  Object.defineProperty(callable, "name", { value: name, enumerable: true });
  return callable;
}

describe("AgentRuntimePlan tool policy helpers", () => {
  beforeEach(() => {
    mocks.logProviderToolSchemaDiagnostics.mockReset();
    mocks.normalizeProviderToolSchemas.mockReset();
  });
  afterEach(async () => {
    for (const instance of instances.splice(0)) {
      await instance.dispose();
    }
  });

  it("does not load a provider runtime to normalize an empty tool set", () => {
    const onPreNormalizationSchemaDiagnostics = vi.fn();

    expect(normalizeTools([], { onPreNormalizationSchemaDiagnostics })).toEqual([]);
    expect(onPreNormalizationSchemaDiagnostics).toHaveBeenCalledWith([], []);
    expect(mocks.normalizeProviderToolSchemas).not.toHaveBeenCalled();
  });

  it.each([
    ["plan", "unchanged", true],
    ["provider", "unchanged", true],
    ["provider", "cloned", true],
    ["provider", "replaced", true],
    ["provider", "replaced", false],
  ] as const)(
    "preserves %s/%s metadata and admission (hidden: %s)",
    async (route, mode, hidden) => {
      const { instance, provider } = createNormalizer("normalizer-fixture", ({ tools }) =>
        mode === "unchanged"
          ? tools
          : tools.map((tool) => {
              if (mode === "cloned") {
                return { ...tool };
              }
              const replacement = {
                ...createParameterFreeTool(tool.name),
                parameters: normalizedParameterFreeSchema(),
                execute: tool.execute,
              };
              Object.defineProperty(replacement, "outputSchema", {
                configurable: true,
                get() {
                  throw new Error("output schema has not been assigned yet");
                },
                set(value: AgentTool["outputSchema"]) {
                  Object.defineProperty(replacement, "outputSchema", { value });
                },
              });
              return replacement;
            }),
      );
      const output = { content: [{ type: "text" as const, text: "fixture note" }], details: {} };
      const formatter = () => ({ text: "Terminal summary" });
      const tool = setToolTerminalPresentation(
        wrapToolWithBeforeToolCallHook({
          ...createParameterFreeTool("fixture__lookup_note"),
          outputSchema: Type.Object({}),
          execute: async () => output,
        }),
        formatter,
      );
      Object.defineProperty(tool, "hideFromChannelProgress", {
        value: hidden,
        enumerable: mode !== "replaced",
      });
      (tool as AnyAgentTool).catalogMode = "direct-only";
      setPluginToolMeta(tool, noteMetadata);
      const normalize = useNormalizer(provider);
      const normalized = normalizeTools([tool], {
        runtimePlan: route === "plan" ? runtimePlan(normalize) : undefined,
      });
      const normalizedTool = expectDefined(normalized[0], "normalized tool");
      const wrapped = normalized.map((entry) =>
        wrapToolWithAbortSignal(
          rewrapToolWithBeforeToolCallHook(entry, { runId: "current-run" }),
          new AbortController().signal,
        ),
      );
      for (const entry of [normalizedTool, expectDefined(wrapped[0], "wrapped tool")]) {
        expect(entry.outputSchema).toBe(tool.outputSchema);
        expect(entry.hideFromChannelProgress).toBe(hidden ? true : undefined);
        expect((entry as AnyAgentTool).catalogMode).toBe("direct-only");
        expect(isToolWrappedWithBeforeToolCallHook(entry)).toBe(true);
        expect(getToolTerminalPresentation(entry)).toBe(formatter);
        expect(getPluginToolMeta(entry)).toBe(noteMetadata);
        await expect(entry.execute("active-call", {})).resolves.toBe(output);
      }
      if (mode !== "replaced") {
        expect(normalizedTool.parameters).toBe(tool.parameters);
      }
      await instance.dispose();
      expect(() => normalizedTool.execute("retired-call", {})).toThrow("reloaded or disabled");
      await expect(wrapped[0]!.execute("retired-wrapped-call", {})).rejects.toThrow(
        "reloaded or disabled",
      );
    },
  );

  it.each(["object", "callable", "callable-source"] as const)(
    "revokes normalized %s tool execution with its consumer while sibling admission remains live",
    async (shape) => {
      const { instance, provider } = createNormalizer("consumer-normalizer", ({ tools }) =>
        shape === "callable" ? tools.map(asCallable) : tools,
      );
      const first = instance.retainConsumer();
      const second = instance.retainConsumer();
      const execute = vi.fn(async () => ({ content: [], details: {} }));
      const definition = { ...createParameterFreeTool(), label: "Consumer tool", execute };
      const source = wrapToolWithBeforeToolCallHook(
        shape === "callable-source" ? asCallable(definition) : definition,
      );
      const normalize = (consumer: typeof first) => {
        const scopedProvider = consumer.wrap(provider);
        mocks.normalizeProviderToolSchemas.mockImplementationOnce(({ tools }) =>
          scopedProvider.normalizeToolSchemas!({ tools, provider: provider.id }),
        );
        return expectDefined(
          normalizeTools([source], { provider: provider.id })[0],
          "normalized consumer tool",
        );
      };
      try {
        const firstTool = normalize(first);
        const secondTool = normalize(second);
        expect(typeof firstTool).toBe(shape === "callable" ? "function" : "object");
        const rewrapped = rewrapToolWithBeforeToolCallHook(firstTool, { runId: "retained-first" });
        const retainedExecute = firstTool.execute;
        await retainedExecute("first-active", {});
        await rewrapped.execute("rewrapped-active", {});
        await secondTool.execute("second-active", {});
        first.release();
        expect(() => retainedExecute("first-closed", {})).toThrow("consumer is closed");
        await expect(rewrapped.execute("rewrapped-closed", {})).rejects.toThrow(
          "consumer is closed",
        );
        await expect(secondTool.execute("second-still-active", {})).resolves.toMatchObject({
          content: [],
        });
        expect(execute).toHaveBeenCalledTimes(4);
      } finally {
        first.release();
        second.release();
      }
    },
  );

  it("does not reread quarantined tools while preserving normalized metadata", () => {
    const unreadableName = createParameterFreeTool("fuzzplugin_unreadable_name") as AgentTool;
    Object.defineProperty(unreadableName, "name", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin name getter exploded");
      },
    });
    const healthy = createParameterFreeTool("fixture__lookup_note") as AgentTool;
    setPluginToolMeta(healthy, noteMetadata);
    const normalized = { ...healthy, parameters: normalizedParameterFreeSchema() };
    const diagnostics: RuntimeToolSchemaDiagnostic[][] = [];
    mocks.normalizeProviderToolSchemas.mockReturnValueOnce([normalized]);

    const result = normalizeTools([unreadableName, healthy], {
      onPreNormalizationSchemaDiagnostics: (entries) => diagnostics.push([...entries]),
    });

    expect(result).toEqual([normalized]);
    expect(getPluginToolMeta(expectDefined(result[0], "result[0] test invariant"))).toBe(
      noteMetadata,
    );
    expect(diagnostics).toEqual([
      [{ toolName: "tool[0]", toolIndex: 0, violations: ["tool[0].name is unreadable"] }],
    ]);
  });

  it("routes diagnostics through RuntimePlan when a plan is available", () => {
    const tools = [createParameterFreeTool()] as AgentTool[];
    const plan = runtimePlan();
    const context = {
      workspaceDir: "/tmp/openclaw-runtime-plan-tools",
      modelApi: "openai-responses",
      model: createNativeOpenAIResponsesModel() as never,
    };

    logAgentRuntimeToolDiagnostics({
      runtimePlan: plan,
      tools,
      provider: "openai",
      ...context,
    });

    expect(plan.tools.logDiagnostics).toHaveBeenCalledWith(tools, context);
  });
});
