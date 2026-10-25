import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import { createAgentHarnessToolSurfaceRuntimeAsync } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { parseCodexNativeToolCatalog } from "./native-tool-catalog.js";
import { flattenCodexDynamicToolFunctions as functions } from "./protocol.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";

function createCollectorTools(swarm?: false) {
  return createOpenClawCodingTools({
    sessionKey: "agent:main:main",
    runId: "parent",
    config: {
      agents: { entries: { main: {} } },
      tools: { profile: "coding", ...(swarm === false ? { swarm: false } : {}) },
    },
  }).filter((tool) => tool.name === "sessions_spawn" || tool.name === "agents_wait");
}

type BridgeParams = Parameters<typeof createCodexDynamicToolBridge>[0];
function createBridge(
  tools: BridgeParams["tools"],
  params: Omit<BridgeParams, "tools" | "signal"> = {},
) {
  return createCodexDynamicToolBridge({
    tools,
    loading: "direct",
    ...params,
    signal: new AbortController().signal,
  });
}

function expectUncollectableSpawn(
  spawn: { parameters?: unknown; description?: string } | undefined,
) {
  expect(spawn?.parameters).not.toHaveProperty("properties.collect");
  expect(spawn?.parameters).toHaveProperty("properties.fastMode");
  expect(spawn?.description).not.toContain("collect=true");
}

async function expectCollectionRejected(bridge: ReturnType<typeof createBridge>) {
  const result = await bridge.handleToolCall({
    callId: "uncollectable",
    threadId: "thread",
    turnId: "turn",
    tool: "sessions_spawn",
    arguments: { task: "inspect", collect: true },
  });
  expect(result.success).toBe(false);
  expect(JSON.stringify(result.contentItems)).toMatch(
    /Collector results are unavailable|Invalid arguments/,
  );
}

describe("Codex collector availability", () => {
  it("rejects a prepared schema mutated in place without a description change", async () => {
    const initial = createBridge(createCollectorTools());
    const spawn = initial.availableTools.find((tool) => tool.name === "sessions_spawn")!;
    const schema = structuredClone(spawn.parameters);
    const description = spawn.description;
    // A preparer can replace a mutable owner's contents without changing its identity.
    Object.defineProperties(spawn, {
      parameters: {
        get: () => schema,
        set: (prepared: typeof schema) => Object.assign(schema, prepared),
      },
      description: { get: () => description, set: () => {} },
    });
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    spawn.execute = execute;
    const bridge = createBridge([spawn], {
      registeredSpecs: initial.specs,
      requireExactRegisteredDefinitions: true,
    });
    expect(spawn.parameters).toBe(schema);
    expect(schema).not.toHaveProperty("properties.collect");
    expect(spawn.description).toBe(description);
    await expect(
      bridge.handleToolCall({
        threadId: "synthetic-parent",
        turnId: "synthetic-turn",
        callId: "mutated-in-place",
        tool: spawn.name,
        arguments: { task: "Inspect the synthetic collector source." },
      }),
    ).resolves.toMatchObject({ success: false, executionStarted: false });
    expect(execute).not.toHaveBeenCalled();
    expect(bridge.specs).toEqual(initial.specs);
  });

  it("retains a genuine restored discovery control without admitting a same-name tool", async () => {
    const config = {
      tools: {
        codeMode: false,
        toolSearch: { enabled: true, mode: "tools" as const },
        gatewayPolicy: { allow: [] },
      },
    };
    const runtime = await createAgentHarnessToolSurfaceRuntimeAsync({
      config,
      modelToolsEnabled: true,
      executeTool: async () => ({ content: [], details: {} }),
    });
    onTestFinished(runtime.cleanup);
    const controls = runtime.compactTools([]).tools.filter((tool) => tool.name === "tool_search");
    expect(controls).toHaveLength(1);
    const initial = createCodexDynamicToolBridge({
      tools: controls,
      signal: new AbortController().signal,
      hookContext: { config },
    });
    const savedFingerprint = codexDynamicToolsFingerprint(initial.specs);
    const restored = createCodexDynamicToolBridge({
      tools: controls,
      registeredSpecs: initial.specs,
      signal: new AbortController().signal,
      hookContext: { config },
    });
    expect(functions(restored.availableSpecs).map((tool) => tool.name)).toEqual(["tool_search"]);
    expect(codexDynamicToolsFingerprint(restored.specs)).toBe(savedFingerprint);

    const execute = vi.fn();
    const lookalike = createCodexDynamicToolBridge({
      tools: controls.map((tool) => Object.assign({}, tool, { execute })),
      registeredSpecs: initial.specs,
      signal: new AbortController().signal,
      hookContext: { config },
    });
    expect(lookalike.availableSpecs).toEqual([]);
    expect(codexDynamicToolsFingerprint(lookalike.specs)).toBe(savedFingerprint);
    expect(
      await lookalike.handleToolCall({
        callId: "fake-discovery-control",
        threadId: "thread",
        turnId: "turn",
        tool: "tool_search",
        arguments: { query: "task" },
      }),
    ).toMatchObject({ success: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["direct", "searchable"] as const)(
    "keeps native catalogs frozen across the default-on upgrade with %s loading",
    async (loading) => {
      const legacy = createBridge(createCollectorTools(false), { loading });
      const nativeFingerprint = codexDynamicToolsFingerprint(legacy.specs);
      const nativeSpecs = parseCodexNativeToolCatalog(
        { id: "thread", dynamic_tools: legacy.specs },
        "thread",
        nativeFingerprint,
      );
      const legacyFunctions = functions(nativeSpecs);
      expect(legacyFunctions.map((tool) => tool.name)).toEqual(["sessions_spawn"]);
      expect(legacyFunctions[0]?.inputSchema).not.toHaveProperty("properties.collect");

      const currentTools = createCollectorTools();
      expect(currentTools.find((tool) => tool.name === "agents_wait")).toBeDefined();
      const resumed = createBridge(currentTools, {
        registeredTools: [],
        registeredSpecs: nativeSpecs,
        loading,
      });
      expect([resumed.specs, resumed.availableSpecs]).toEqual([nativeSpecs, nativeSpecs]);
      expect(resumed.availableTools.map((tool) => tool.name)).toEqual(["sessions_spawn"]);
      expectUncollectableSpawn(
        resumed.availableTools.find((tool) => tool.name === "sessions_spawn"),
      );
      await expectCollectionRejected(resumed);

      const tools = createCollectorTools();
      const initial = createBridge(tools, { registeredTools: tools, loading });
      const inherited = createBridge(tools, {
        registeredTools: [],
        registeredSpecs: initial.specs,
        loading,
      });
      expect(codexDynamicToolsFingerprint(initial.specs)).not.toBe(nativeFingerprint);
      expect(inherited.specs).toEqual(initial.specs);
      for (const bridge of [initial, inherited]) {
        const spawn = bridge.availableTools.find((tool) => tool.name === "sessions_spawn");
        const projected = functions(bridge.specs);
        const projectedSpawn = projected.find((tool) => tool.name === "sessions_spawn");
        for (const field of ["collect", "outputSchema", "groupId"]) {
          expect(spawn?.parameters).toHaveProperty(`properties.${field}`);
          expect(projectedSpawn?.inputSchema).toHaveProperty(`properties.${field}`);
        }
        expect(spawn?.description).toContain("await with agents_wait");
        expect(projected.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(["sessions_spawn", "agents_wait"]),
        );
      }
    },
  );

  it.each([
    "missing",
    "quarantined",
    "lookalike",
    "registered-surface",
    "unregistered",
    "registration-quarantined",
  ] as const)("narrows the actual spawn definition when the reader is %s", async (kind) => {
    const tools = createCollectorTools();
    const spawn = tools.find((tool) => tool.name === "sessions_spawn")!;
    const reader = tools.find((tool) => tool.name === "agents_wait")!;
    expect(spawn.parameters).toHaveProperty("properties.collect");
    const initial = createBridge(tools);
    const registeredSpecs = initial.specs.filter(
      (spec) => spec.type === "function" && spec.name === "sessions_spawn",
    );
    if (kind === "quarantined") {
      reader.parameters = { type: "array", items: { type: "string" } };
    }
    const currentTools =
      kind === "missing" ? [spawn] : kind === "lookalike" ? [spawn, { ...reader }] : tools;
    const registeredTools =
      kind === "unregistered"
        ? [spawn]
        : kind === "registration-quarantined"
          ? [spawn, { ...reader, parameters: { type: "array", items: { type: "string" } } }]
          : undefined;
    const bridge = createBridge(currentTools, {
      registeredTools,
      ...(kind === "registered-surface" ? { registeredSpecs } : {}),
    });
    expectUncollectableSpawn(bridge.availableTools.find((tool) => tool.name === "sessions_spawn"));
    if (kind === "registered-surface") {
      expect(bridge.specs).toEqual(registeredSpecs);
      expect(bridge.availableSpecs).toEqual(registeredSpecs);
    } else {
      for (const specs of [bridge.availableSpecs, bridge.specs]) {
        const spec = functions(specs).find((tool) => tool.name === "sessions_spawn");
        expectUncollectableSpawn({ parameters: spec?.inputSchema, description: spec?.description });
      }
    }
    if (registeredTools) {
      expect(bridge.availableTools.map((tool) => tool.name)).toEqual(["sessions_spawn"]);
      expect(functions(bridge.availableSpecs).map((tool) => tool.name)).toEqual(["sessions_spawn"]);
    }
    if (kind === "quarantined") {
      expect(bridge.telemetry.quarantinedTools).toEqual(
        expect.arrayContaining([expect.objectContaining({ tool: "agents_wait" })]),
      );
    }
    await expectCollectionRejected(bridge);
  });
});
