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
import { createDeferred } from "../../../test/helpers/promise.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { getPluginInstance } from "../../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { getPluginToolMeta, setPluginToolMeta } from "../../plugins/tool-metadata.js";
import { wrapToolWithAbortSignal } from "../agent-tools.abort.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  rewrapToolWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import {
  filterRuntimeCompatibleTools,
  type RuntimeToolSchemaDiagnostic,
} from "../tool-schema-projection.js";
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
      const metadataWrites: PropertyKey[] = [];
      const observeMetadataWrites = (definition: AgentTool): AgentTool =>
        new Proxy(definition, {
          set(target, key, value, receiver) {
            if (key === "outputSchema" || key === "hideFromChannelProgress") {
              metadataWrites.push(key);
            }
            return Reflect.set(target, key, value, receiver);
          },
        });
      try {
        const output = { content: [{ type: "text" as const, text: "fixture note" }], details: {} };
        const tool = observeMetadataWrites(
          wrapToolWithBeforeToolCallHook({
            ...createParameterFreeTool("fixture__lookup_note"),
            label: "Fixture lookup",
            parameters: Type.Object({}),
            outputSchema: Type.Object({}),
            hideFromChannelProgress: true,
            execute: vi.fn(async () => output),
          }),
        );
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
            mode === "cloned" ? tools.map((entry) => observeMetadataWrites({ ...entry })) : tools,
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
        expect(metadataWrites).toEqual([]);
        const normalizedTool = expectDefined(normalized[0], "normalized tool");
        expect(normalizedTool.parameters).toBe(tool.parameters);
        expect(normalizedTool.outputSchema).toBe(tool.outputSchema);
        const wrapped = normalized
          .map((entry) => rewrapToolWithBeforeToolCallHook(entry, { runId: "current-run" }))
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

  it("shares normalized definitions while keeping run cancellation and private callbacks independent", async () => {
    const builder = createTestPluginRegistry();
    const record = createPluginRecord({
      id: "run-bound-normalizer",
      source: "/synthetic/run-bound-normalizer.ts",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    builder.registry.plugins.push(record);
    const api = builder.createApi(record, { config: {} });
    const instance = getPluginInstance(record)!;
    const parameters = Type.Object({});
    const completed = createDeferred();
    const executions: string[] = [];
    class RunTool implements AnyAgentTool {
      name = "run_fixture";
      label = "Run fixture";
      description = "Return this run's result";
      parameters = parameters;
      outputSchema = parameters;
      #runId: string;

      constructor(runId: string) {
        this.#runId = runId;
      }

      prepareArguments() {
        return { runId: this.#runId };
      }

      prepareBeforeToolCallParams() {
        return { preparedRun: this.#runId };
      }

      finalizeBeforeToolCallParams() {
        return { finalizedRun: this.#runId };
      }

      getExecutionTimeoutMs() {
        return this.#runId === "first" ? 100 : 200;
      }

      async execute() {
        executions.push(this.#runId);
        await completed.promise;
        return { content: [], details: { runId: this.#runId } };
      }
    }
    api.registerProvider({
      id: record.id,
      label: "Run-bound normalizer",
      auth: [],
      normalizeToolSchemas: ({ tools }) => tools,
    });
    const provider = expectDefined(builder.registry.providers[0], "registered provider").provider;
    mocks.normalizeProviderToolSchemas.mockImplementation(({ tools }) =>
      provider.normalizeToolSchemas!({ tools, provider: provider.id }),
    );
    const normalize = (runId: string): AnyAgentTool =>
      expectDefined(
        normalizeAgentRuntimeTools({ tools: [new RunTool(runId)], provider: record.id })[0],
        "normalized run tool",
      );
    try {
      const first = normalize("first");
      const second = normalize("second");
      expect(first.parameters).toBe(parameters);
      expect(second.parameters).toBe(parameters);
      expect(first.outputSchema).toBe(parameters);
      expect(second.outputSchema).toBe(parameters);
      for (const [tool, runId, timeout] of [
        [first, "first", 100],
        [second, "second", 200],
      ] as const) {
        const {
          prepareArguments,
          prepareBeforeToolCallParams,
          finalizeBeforeToolCallParams,
          getExecutionTimeoutMs,
        } = tool;
        expect(prepareArguments?.({})).toEqual({ runId });
        expect(prepareBeforeToolCallParams?.({}, {})).toEqual({ preparedRun: runId });
        expect(finalizeBeforeToolCallParams?.({}, {})).toEqual({ finalizedRun: runId });
        expect(getExecutionTimeoutMs?.({})).toBe(timeout);
      }
      const firstAbort = new AbortController();
      const secondAbort = new AbortController();
      const firstRun = wrapToolWithAbortSignal(first, firstAbort.signal);
      const secondRun = wrapToolWithAbortSignal(second, secondAbort.signal);
      const canceled = firstRun.execute("first-call", {});
      const canceledResult = expect(canceled).rejects.toThrow("Aborted");
      const active = secondRun.execute("second-call", {});
      expect(executions).toEqual(["first", "second"]);
      firstAbort.abort();
      await canceledResult;
      expect(secondAbort.signal.aborted).toBe(false);
      completed.resolve();
      await expect(active).resolves.toMatchObject({ details: { runId: "second" } });
      await expect(firstRun.execute("old-call", {})).rejects.toThrow("Aborted");
      await instance.dispose();
      for (const tool of [first, second]) {
        expect(() => tool.execute("retired-call", {})).toThrow("reloaded or disabled");
        expect(() => tool.prepareArguments?.({})).toThrow("reloaded or disabled");
        expect(() => tool.prepareBeforeToolCallParams?.({}, {})).toThrow("reloaded or disabled");
        expect(() => tool.finalizeBeforeToolCallParams?.({}, {})).toThrow("reloaded or disabled");
        expect(() => tool.getExecutionTimeoutMs?.({})).toThrow("reloaded or disabled");
      }
      expect(executions).toEqual(["first", "second"]);
    } finally {
      completed.resolve();
      await instance.dispose();
    }
  });

  it.each(["object", "callable", "callable-source"] as const)(
    "revokes normalized %s tool execution with its consumer while sibling admission remains live",
    async (shape) => {
      const builder = createTestPluginRegistry();
      const record = createPluginRecord({
        id: "consumer-normalizer",
        source: "/synthetic/consumer-normalizer.ts",
        origin: "bundled",
        enabled: true,
        configSchema: false,
      });
      builder.registry.plugins.push(record);
      const api = builder.createApi(record, { config: {} });
      const instance = getPluginInstance(record)!;
      api.registerProvider({
        id: record.id,
        label: "Consumer normalizer",
        auth: [],
        normalizeToolSchemas: ({ tools }) =>
          shape !== "callable"
            ? tools
            : tools.map((tool) => {
                const { name, ...definition } = tool;
                const callable = Object.assign(() => undefined, definition);
                Object.defineProperty(callable, "name", { value: name, enumerable: true });
                return callable;
              }),
      });
      const provider = expectDefined(builder.registry.providers[0], "registered provider").provider;
      const first = instance.retainConsumer();
      const second = instance.retainConsumer();
      const execute = vi.fn(async () => ({ content: [], details: {} }));
      const definition = { ...createParameterFreeTool(), label: "Consumer tool", execute };
      const { name, ...callableDefinition } = definition;
      const callableSource = Object.assign(() => undefined, callableDefinition);
      Object.defineProperty(callableSource, "name", { value: name, enumerable: true });
      const source = wrapToolWithBeforeToolCallHook(
        shape === "callable-source" ? callableSource : definition,
      );
      const normalize = (consumer: typeof first) => {
        const scopedProvider = consumer.wrap(provider);
        mocks.normalizeProviderToolSchemas.mockImplementationOnce(({ tools }) =>
          scopedProvider.normalizeToolSchemas!({ tools, provider: provider.id }),
        );
        return expectDefined(
          normalizeAgentRuntimeTools({ tools: [source], provider: record.id })[0],
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
        expect(instance.acceptingCalls).toBe(true);
        expect(execute).toHaveBeenCalledTimes(4);
      } finally {
        first.release();
        second.release();
        await instance.dispose();
      }
    },
  );

  it.each(["direct", "inherited"] as const)(
    "preserves %s Proxy execution and leaves unreadable schemas to quarantine",
    async (placement) => {
      const builder = createTestPluginRegistry();
      const record = createPluginRecord({
        id: "proxy-normalizer",
        source: "/synthetic/proxy-normalizer.ts",
        origin: "bundled",
        enabled: true,
        configSchema: false,
      });
      builder.registry.plugins.push(record);
      const api = builder.createApi(record, { config: {} });
      const instance = getPluginInstance(record)!;
      const underlyingExecute = vi.fn(async () => ({ content: [], details: { source: "target" } }));
      const overrideExecute = vi.fn(async () => ({ content: [], details: { source: "proxy" } }));
      const trapAdmissions: boolean[] = [];
      api.registerProvider({
        id: record.id,
        label: "Proxy normalizer",
        auth: [],
        normalizeToolSchemas: ({ tools }) =>
          tools.map((tool) => {
            const proxy = new Proxy(tool, {
              get(target, key, receiver) {
                trapAdmissions.push(instance.hasActiveCall);
                if (key === "execute") {
                  return overrideExecute;
                }
                if (key === "parameters" && target.name === "unreadable") {
                  throw new Error("Proxy schema unavailable");
                }
                return Reflect.get(target, key, receiver);
              },
            });
            return placement === "direct" ? proxy : Object.create(proxy);
          }),
      });
      const provider = expectDefined(builder.registry.providers[0], "registered provider").provider;
      mocks.normalizeProviderToolSchemas.mockImplementationOnce(({ tools }) =>
        provider.normalizeToolSchemas!({ tools, provider: provider.id }),
      );
      try {
        const normalized = normalizeAgentRuntimeTools({
          tools: ["healthy", "unreadable"].map((name) => {
            return Object.assign(createParameterFreeTool(name), {
              label: name,
              execute: underlyingExecute,
            });
          }),
          provider: record.id,
        });
        expect(normalized).toHaveLength(2);
        const projected = filterRuntimeCompatibleTools(normalized);
        expect(projected.tools.map((tool) => tool.name)).toEqual(["healthy"]);
        expect(projected.diagnostics).toEqual([
          {
            toolName: "unreadable",
            toolIndex: 1,
            violations: ["unreadable.parameters is unreadable"],
          },
        ]);
        const { execute } = expectDefined(projected.tools[0], "healthy normalized tool");
        await expect(execute("proxy-call", {})).resolves.toMatchObject({
          details: { source: "proxy" },
        });
        expect(underlyingExecute).not.toHaveBeenCalled();
        expect(overrideExecute).toHaveBeenCalledOnce();
        expect(trapAdmissions.length).toBeGreaterThan(0);
        expect(trapAdmissions.every(Boolean)).toBe(true);
        await instance.dispose();
        expect(() => execute("retired-proxy-call", {})).toThrow("reloaded or disabled");
        expect(overrideExecute).toHaveBeenCalledOnce();
      } finally {
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
      Object.defineProperty(normalized, "outputSchema", {
        configurable: true,
        get() {
          throw new Error("output schema has not been assigned yet");
        },
        set(value: AgentTool["outputSchema"]) {
          Object.defineProperty(normalized, "outputSchema", { value });
        },
      });
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
