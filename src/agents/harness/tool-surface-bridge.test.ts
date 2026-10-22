import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setPluginToolMeta } from "../../plugins/tool-metadata.js";
import { createCanonicalAgentConfigFixture } from "../../test-utils/config-roster.js";
import { finalizeAgentToolAvailability } from "../agent-tool-availability.js";
import { runWithAgentRingZeroTools } from "../agent-tools.ring-zero-context.js";
import { applyEmbeddedAttemptToolsAllow } from "../embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { projectAgentToolDefinition } from "../prepared-tool-surface.js";
import { createStubTool } from "../test-helpers/agent-tool-stubs.js";
import { attachToolAllowlistIntersection } from "../tool-policy.js";
import {
  TOOL_CALL_RAW_TOOL_NAME,
  createToolSearchTools,
  buildToolSchemaDirectoryPrompt,
} from "../tool-search.js";
import { prepareAgentToolSurfacePresentation } from "../tool-surface-plan.js";
import { createAgentsWaitTool } from "../tools/agents-wait-tool.js";
import { createSessionsSpawnTool } from "../tools/sessions-spawn-tool.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "./tool-surface-bridge.js";

type RuntimeOptions = Parameters<typeof createAgentHarnessToolSurfaceRuntimeCore>[0];
const runtimes: ReturnType<typeof createAgentHarnessToolSurfaceRuntimeCore>[] = [];
function rawRuntime(params: Omit<RuntimeOptions, "modelToolsEnabled">) {
  const runtime = createAgentHarnessToolSurfaceRuntimeCore({ ...params, modelToolsEnabled: true });
  runtimes.push(runtime);
  return runtime;
}

function configuredRuntime(params: Omit<RuntimeOptions, "modelToolsEnabled">) {
  return rawRuntime({
    ...params,
    config: createCanonicalAgentConfigFixture(params.config).config,
  });
}

const tools = (names: string[]) => names.map(createStubTool);

function createRuntime(
  config: OpenClawConfig,
  options: Omit<RuntimeOptions, "config" | "modelToolsEnabled"> = {},
) {
  return configuredRuntime({
    config,
    executeTool: async () => ({ content: [], details: {} }),
    ...options,
  });
}
function searchTools(runtime: ReturnType<typeof rawRuntime>, withExecutor = false) {
  return createToolSearchTools({
    config: runtime.config,
    catalogRef: runtime.toolSearchCatalogRef,
    ...(withExecutor ? { executeTool: runtime.toolSearchCatalogExecutor } : {}),
  });
}
const toolNames = (items: ReturnType<typeof tools>) => items.map((tool) => tool.name);
const searchControlNames = ["tool_search", "tool_describe", "dispatch_action"];
const getTool = (items: ReturnType<typeof tools>, name: string) =>
  expectDefined(
    items.find((tool) => tool.name === name),
    name,
  );
function preparePresentation(
  params: Omit<
    Parameters<typeof prepareAgentToolSurfacePresentation>[0],
    "toolsEnabled" | "isRawModelRun" | "forceDirectMessageTool"
  >,
) {
  return prepareAgentToolSurfacePresentation({
    ...params,
    toolsEnabled: true,
    isRawModelRun: false,
    forceDirectMessageTool: false,
  });
}

afterEach(() => {
  for (const runtime of runtimes.splice(0).toReversed()) {
    runtime.cleanup();
  }
  clearRuntimeConfigSnapshot();
});

describe("createAgentHarnessToolSurfaceRuntime", () => {
  it.each([
    ["automatic Code Mode", "auto", true, false, ["exec", "wait", "fixture_direct"]],
    ["direct tools", false, false, false, ["fixture_read", "fixture_direct"]],
    ["Tool Search", false, false, true, [...searchControlNames, "fixture_direct"]],
  ] as const)(
    "preserves the local %s projection after transporting prepared facts",
    async (_mode, codeMode, preferred, search, expected) => {
      const config: OpenClawConfig = { tools: { codeMode, toolSearch: search } };
      const model = { compat: { codeMode: preferred ? "preferred" : "capable" } };
      const params = { config, model, modelProvider: "test", modelId: "model" };
      const presentation = preparePresentation(params);
      const local = rawRuntime(params);
      const worker = rawRuntime({ presentation: structuredClone(presentation) });
      const buildTools = () => {
        const read = createStubTool("fixture_read");
        read.execute = async () => ({
          content: [],
          details: { marker: "prepared catalog result" },
        });
        setPluginToolMeta(read, { pluginId: "fixture", optional: true, replaySafe: true });
        return [read, { ...createStubTool("fixture_direct"), catalogMode: "direct-only" as const }];
      };
      const localSurface = local.compactTools(buildTools());
      const workerSurface = worker.compactTools(buildTools(), {
        prepared: { preserveToolNames: [] },
      });
      expect(toolNames(workerSurface.tools)).toEqual(expected);
      expect(workerSurface.tools.map(projectAgentToolDefinition)).toEqual(
        localSurface.tools.map(projectAgentToolDefinition),
      );
      if (presentation.codeMode.enabled || search) {
        expect(worker.toolSearchCatalogRef?.current?.entries.map((entry) => entry.id)).toEqual([
          "openclaw:fixture:fixture_read",
        ]);
        expect(workerSurface.promptToolPolicy.apply().callableToolNames).toContain("fixture_read");
      }
      if (search) {
        const call = getTool(workerSurface.tools, "dispatch_action");
        const result = await call.execute("prepared-call", { id: "fixture_read", args: {} });
        expect(JSON.stringify(result)).toContain("prepared catalog result");
      }
    },
  );

  it("returns the canonical directory only after applying prompt policy", () => {
    const runtime = configuredRuntime({
      config: {
        agents: { defaults: { experimental: { localModelLean: false } } },
        tools: { codeMode: false, toolSearch: { enabled: true, mode: "directory" } },
      },
      model: { contextWindow: 8_000 },
      executeTool: async () => ({ content: [], details: {} }),
    });
    const { promptToolPolicy: policy } = runtime.compactTools([
      ...searchTools(runtime),
      ...tools(["fixture_allowed", "fixture_denied"]),
    ]);
    const full = policy.apply().toolSchemaDirectoryPrompt;
    expect(full).toContain("fixture_denied");
    expect(policy.apply().toolSchemaDirectoryPrompt).toBe(full);
    const { toolSchemaDirectoryPrompt: restricted } = policy.apply({
      toolsAllow: ["fixture_allowed"],
    });
    expect(restricted).toBe(
      buildToolSchemaDirectoryPrompt(
        { config: runtime.config, catalogRef: runtime.toolSearchCatalogRef },
        { contextTokenBudget: 8_000 },
      ),
    );
    expect(restricted).toContain("fixture_allowed");
    expect(restricted).not.toContain("fixture_denied");
    expect(expectDefined(restricted, "restricted directory").length).toBeLessThanOrEqual(800);
    expect(policy.apply({ toolsAllow: [] }).toolSchemaDirectoryPrompt).toBeUndefined();
    expect(policy.apply().toolSchemaDirectoryPrompt).toBe(full);
  });

  it("uses structured calls without deferred dispatch support", () => {
    const config: OpenClawConfig = { tools: { toolSearch: { mode: "directory" } } };
    const runtime = createRuntime(config, { supportsDeferredToolCalls: false });
    const surface = runtime.compactTools([...searchTools(runtime), ...tools(["fixture_hidden"])]);
    const guidance = surface.promptToolPolicy.apply().toolSchemaDirectoryPrompt;
    expect(runtime.plan.toolSearchConfig.mode).toBe("tools");
    expect(guidance?.includes("Call a unique deferred tool name directly")).toBe(false);
    expect(guidance?.includes("Deferred names are not directly callable")).toBe(true);
    expect(config.tools?.toolSearch).toEqual({ mode: "directory" });
  });

  it("keeps overlapping allowlists callable through the code surface", () => {
    const toolsAllow = attachToolAllowlistIntersection([], [["web_*"], ["*_search"]]);
    const runtime = configuredRuntime({
      config: {
        agents: { defaults: { experimental: { localModelLean: false } } },
        tools: { codeMode: true, toolSearch: false },
      },
      executeTool: async () => ({ content: [], details: {} }),
      toolsAllow,
      runtimeToolAllowlist: toolsAllow,
    });
    const allowedTools = applyEmbeddedAttemptToolsAllow(
      [...searchTools(runtime, true), ...tools(["web_search", "web_fetch", "memory_search"])],
      runtime.runtimeToolAllowlist,
    );
    const surface = runtime.compactTools(allowedTools);
    const { callableToolNames, toolSchemaDirectoryPrompt } = surface.promptToolPolicy.apply();
    expect(callableToolNames).toContain("web_search");
    expect(callableToolNames).not.toContain("web_fetch");
    expect(callableToolNames).not.toContain("memory_search");
    expect(toolSchemaDirectoryPrompt).toContain("- web_search ");
    expect(toolSchemaDirectoryPrompt).not.toContain("- web_fetch ");
    expect(toolSchemaDirectoryPrompt).not.toContain("- memory_search ");
    expect(runtime.codeModeControlsEnabled).toBe(true);
    expect(runtime.toolSearchControlsEnabled).toBe(false);
  });

  it("keeps browser callable through automatic Tool Search for message-tool-only replies with lean disabled", async () => {
    let calls = 0;
    const browser = {
      ...createStubTool("browser"),
      execute: async () => {
        calls += 1;
        return { content: [{ type: "text" as const, text: "BROWSER_RESULT" }], details: {} };
      },
    };
    const config: OpenClawConfig = {
      agents: { defaults: { experimental: { localModelLean: false } } },
    };
    const runtime = configuredRuntime({
      config,
      model: { toolSearchMode: "tools" },
      executeTool: async () => browser.execute(),
      sourceReplyDeliveryMode: "message_tool_only",
    });
    const surface = runtime.compactTools([
      ...searchTools(runtime, true),
      createStubTool("read"),
      createStubTool("message"),
      browser,
    ]);
    expect(toolNames(surface.tools)).toEqual([...searchControlNames, "read", "message"]);
    expect(surface.promptToolPolicy.apply().callableToolNames).toContain("browser");
    const call = getTool(surface.tools, "dispatch_action");
    expect(
      JSON.stringify(await call.execute("browser-call", { id: "browser", args: {} })),
    ).toContain("BROWSER_RESULT");
    expect(calls).toBe(1);
    expect(config.tools).toBeUndefined();
  });
  it.each(["quarantine", "prompt-policy"] as const)(
    "narrows collector capabilities after harness %s",
    async (restriction) => {
      const runtime = createRuntime({ tools: { toolSearch: false } });
      setRuntimeConfigSnapshot(expectDefined(runtime.config, "collector runtime config"));
      const spawn = createSessionsSpawnTool({ agentSessionKey: "agent:main:main" });
      const reader = createAgentsWaitTool({ agentSessionKey: "agent:main:main" });
      finalizeAgentToolAvailability([spawn, reader]);
      expect(spawn.parameters).toHaveProperty("properties.collect");
      if (restriction === "quarantine") {
        reader.parameters = { type: "array", items: { type: "string" } };
      }
      const compacted = runtime.compactTools([spawn, reader]);
      const surface = compacted.promptToolPolicy.apply({ toolsAllow: ["sessions_spawn"] });
      expect(surface.callableToolNames).toEqual(["sessions_spawn"]);
      expect(spawn.parameters).not.toHaveProperty("properties.collect");
      await expect(spawn.execute("collector", { task: "inspect", collect: true })).rejects.toThrow(
        "Collector results are unavailable",
      );
    },
  );

  it("executes a model opt-in while the global default is off", async () => {
    const markerTool = createStubTool("read_marker");
    markerTool.execute = async () => ({
      content: [{ type: "text", text: "MODEL_OVERRIDE" }],
      details: { marker: "MODEL_OVERRIDE" },
    });
    const runtime = configuredRuntime({
      config: {
        tools: { codeMode: false },
        agents: { defaults: { models: { "test/model-a": { codeMode: true } } } },
      },
      modelProvider: "test",
      modelId: "model-a",
      executeTool: async ({ toolCallId, input }) => markerTool.execute(toolCallId, input),
    });
    const surface = runtime.compactTools([markerTool]);
    expect(toolNames(surface.tools)).toEqual(["exec", "wait"]);
    const exec = getTool(surface.tools, "exec");
    const result = await exec.execute("model-override", { code: "return await read_marker({});" });
    expect(result.details).toMatchObject({
      status: "completed",
      value: { marker: "MODEL_OVERRIDE" },
    });
  });

  it("suppresses catalog controls for a host-scoped ring-zero run", () => {
    const openclaw = { ...createStubTool("openclaw"), catalogMode: "direct-only" as const };

    runWithAgentRingZeroTools([openclaw], () => {
      const runtime = configuredRuntime({
        config: { tools: { toolSearch: true } },
        executeTool: async () => ({ content: [], details: {} }),
        runtimeToolAllowlist: ["openclaw"],
        toolsAllow: ["openclaw"],
      });

      expect(runtime.codeModeControlsEnabled).toBe(false);
      expect(runtime.toolSearchControlsEnabled).toBe(false);
      expect(runtime.includeToolSearchControls).toBe(false);
      expect(runtime.runtimeToolAllowlist).toEqual(["openclaw"]);
      expect(runtime.compactTools([openclaw]).tools).toEqual([openclaw]);
    });
  });

  it("filters raw SDK tools but does not refilter prepared constructor output", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { experimental: { localModelLean: true } } },
      tools: { alsoAllow: ["image_generate"], toolSearch: { enabled: false } },
    };
    const runtime = createRuntime(config);

    expect(
      toolNames(runtime.compactTools(tools(["read", "browser", "image_generate"])).tools),
    ).toEqual(["read", "image_generate"]);
    expect(
      toolNames(
        runtime.compactTools(tools(["read", "browser"]), { localModelLeanApplied: true }).tools,
      ),
    ).toEqual(["read", "browser"]);
  });

  it.each(
    [true, false].flatMap((lean) => ["agentId", "sessionKey"].map((scope) => ({ lean, scope }))),
  )(
    "preserves lean=$lean directory presentation across worker projection via $scope",
    ({ lean, scope }) => {
      const config: OpenClawConfig = {
        agents: {
          defaults: { experimental: { localModelLean: !lean } },
          entries: { main: {}, scoped: { experimental: { localModelLean: lean } } },
        },
        tools: { codeMode: false, toolSearch: { mode: "tools" } },
      };
      const selection =
        scope === "agentId" ? { agentId: "scoped" } : { sessionKey: "agent:scoped:main" };
      const runtime = configuredRuntime({ config, ...selection });
      const worker = rawRuntime({
        presentation: structuredClone(preparePresentation({ config, ...selection })),
      });
      const lookup = Object.assign(createStubTool("fixture_lookup"), {
        description: "Search the local archive.",
      });
      const surface = runtime.compactTools([lookup, createStubTool("browser")]);
      const prompt = surface.promptToolPolicy.apply().toolSchemaDirectoryPrompt;
      expect(prompt).toContain("- fixture_lookup (core)");
      expect(prompt?.includes("Search the local archive.")).toBe(!lean);
      expect(prompt?.includes("- browser (core)")).toBe(!lean);
      const projected = worker.compactTools([lookup], { prepared: { preserveToolNames: [] } });
      const directory = projected.promptToolPolicy.apply().toolSchemaDirectoryPrompt;
      expect(directory?.split("\n").filter((line) => line.startsWith("- "))).toEqual([
        lean ? "- fixture_lookup (core)" : "- fixture_lookup (core): Search the local archive.",
      ]);
    },
  );

  it("atomically filters and restores direct tools plus the hidden catalog", () => {
    const runtime = createRuntime({ tools: { toolSearch: true } });
    const names = [TOOL_CALL_RAW_TOOL_NAME, "read", "hidden_alpha", "hidden_beta"];
    const compacted = runtime.compactTools(tools(names));
    const alpha = compacted.promptToolPolicy.apply({ toolsAllow: ["hidden_alpha"] });
    expect(toolNames(alpha.tools)).toEqual([TOOL_CALL_RAW_TOOL_NAME]);
    expect(alpha.callableToolNames).toEqual([TOOL_CALL_RAW_TOOL_NAME, "hidden_alpha"]);

    const beta = compacted.promptToolPolicy.apply({ toolsAllow: ["hidden_beta"] });
    expect(toolNames(beta.tools)).toEqual([TOOL_CALL_RAW_TOOL_NAME]);
    expect(beta.callableToolNames).toEqual([TOOL_CALL_RAW_TOOL_NAME, "hidden_beta"]);

    const restored = compacted.promptToolPolicy.apply();
    expect(restored.tools).toEqual(compacted.tools);
    expect(restored.callableToolNames).toEqual(names);
  });

  it("keeps message-only delivery directly visible in Code Mode", () => {
    const runtime = configuredRuntime({
      config: { tools: { codeMode: true } },
      executeTool: async () => ({ content: [], details: {} }),
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(
      runtime.compactTools(tools(["web_search", "message"])).tools.map((tool) => tool.name),
    ).toEqual(["exec", "wait", "message"]);
  });
});
