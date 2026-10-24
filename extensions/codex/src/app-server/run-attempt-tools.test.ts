import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { createCodexDynamicToolSpecs, projectCodexDynamicTools } from "./dynamic-tool-catalog.js";
import { resolveCodexDynamicToolsLoadingForRuntime } from "./dynamic-tool-profile.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type { CodexDynamicToolFunctionSpec, CodexDynamicToolSpec, JsonObject } from "./protocol.js";
import { resolveCodexDynamicToolDirectNames } from "./run-attempt-tools.js";
import { buildCodexThreadConfiguration } from "./thread-requests.js";

function createAttemptParams(
  overrides: Partial<EmbeddedRunAttemptParams> = {},
): EmbeddedRunAttemptParams {
  return overrides as EmbeddedRunAttemptParams;
}

type RuntimeDynamicToolForTest = Parameters<
  typeof createCodexDynamicToolBridge
>[0]["tools"][number];

function createRuntimeDynamicTool(name: string): RuntimeDynamicToolForTest {
  return {
    name,
    label: name,
    description: name + " test tool",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: name + " done" }],
      details: {},
    })),
  };
}

function createCodexToolBridgeForTest(
  params: EmbeddedRunAttemptParams,
  tools: RuntimeDynamicToolForTest[],
  registeredTools: RuntimeDynamicToolForTest[],
) {
  return createCodexDynamicToolBridge({
    tools,
    registeredTools,
    signal: new AbortController().signal,
    directToolNames: resolveCodexDynamicToolDirectNames(params, registeredTools),
  });
}

function flattenSpecsWithNamespace(
  specs: readonly CodexDynamicToolSpec[],
): Array<CodexDynamicToolFunctionSpec & { namespace?: string }> {
  return specs.flatMap((spec) =>
    spec.type === "namespace"
      ? spec.tools.map((tool) => ({ ...tool, namespace: spec.name }))
      : [spec],
  );
}

describe("Codex direct tool loading", () => {
  const projectTool = (name: string) =>
    projectCodexDynamicTools([
      { name, description: `Use ${name}`, parameters: { type: "object", properties: {} } },
    ]).tools;

  it("keeps the available ring-zero tool directly callable", () => {
    const params = createAttemptParams({ toolsAllow: ["openclaw"] });
    expect(
      createCodexDynamicToolSpecs({
        entries: projectTool("openclaw"),
        loading: "searchable",
        directToolNames: resolveCodexDynamicToolDirectNames(params, projectTool("openclaw"), true),
      }),
    ).toEqual([expect.objectContaining({ type: "function", name: "openclaw" })]);
  });

  it("keeps registered catalog bytes stable across delivery modes and disabled turns", async () => {
    const tool = createRuntimeDynamicTool("message");
    const bridges = (["automatic", "message_tool_only", "automatic"] as const).map(
      (sourceReplyDeliveryMode) =>
        createCodexDynamicToolBridge({
          tools: [],
          registeredTools: [tool],
          signal: new AbortController().signal,
          loading: "searchable",
          directToolNames: resolveCodexDynamicToolDirectNames(
            createAttemptParams({ sourceReplyDeliveryMode, disableMessageTool: true }),
            [tool],
          ),
        }),
    );

    const enabledBridge = createCodexToolBridgeForTest(createAttemptParams(), [tool], [tool]);
    expect(JSON.stringify(bridges[0]?.specs)).toBe(JSON.stringify(enabledBridge.specs));
    expect(JSON.stringify(bridges[1]?.specs)).toBe(JSON.stringify(bridges[0]?.specs));
    expect(JSON.stringify(bridges[2]?.specs)).toBe(JSON.stringify(bridges[0]?.specs));
    expect(
      bridges[0]?.specs.some((spec) => spec.type === "function" && spec.name === "message"),
    ).toBe(true);
    for (const bridge of bridges) {
      expect(bridge.availableSpecs).toEqual([]);
      const result = await bridge.handleToolCall({
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "disabled-message",
        namespace: "openclaw",
        tool: "message",
        arguments: {},
      });
      expect(result).toMatchObject({
        success: false,
        contentItems: [
          { type: "inputText", text: "OpenClaw tool is not available for this turn: message" },
        ],
      });
    }
    expect(tool.execute).not.toHaveBeenCalled();
  });
});

it("keeps OpenClaw control-path tools direct when code-mode-only is enabled", () => {
  const tools = [
    "message",
    "web_search",
    "heartbeat_respond",
    "agents_list",
    "sessions_spawn",
    "sessions_yield",
  ].map(createRuntimeDynamicTool);
  const toolBridge = createCodexDynamicToolBridge({
    tools,
    signal: new AbortController().signal,
    directToolNames: ["message"],
  });
  const specs = flattenSpecsWithNamespace(toolBridge.specs);
  for (const name of ["message", "agents_list", "sessions_spawn", "sessions_yield"]) {
    const spec = specs.find((tool) => tool.name === name);
    expect(spec).not.toHaveProperty("namespace");
    expect(spec).not.toHaveProperty("deferLoading");
  }
  for (const name of ["web_search", "heartbeat_respond"]) {
    expect(specs.find((tool) => tool.name === name)).toMatchObject({
      namespace: "openclaw",
      deferLoading: true,
    });
  }
});

it("keeps session UI tools callable without native JavaScript discovery", async () => {
  const tools = ["dashboard", "show_widget", "screen"].map(createRuntimeDynamicTool);
  const loading = resolveCodexDynamicToolsLoadingForRuntime({}, "custom/unlisted-model", {
    nativeToolSurfaceEnabled: false,
  });
  const bridge = createCodexDynamicToolBridge({
    tools,
    loading,
    signal: new AbortController().signal,
  });
  const thread = buildCodexThreadConfiguration(
    createAttemptParams({ config: {}, modelId: "custom/unlisted-model" }),
    {
      appServer: resolveCodexAppServerRuntimeOptions({}),
      nativeCodeModeEnabled: false,
      dynamicTools: bridge.specs,
    },
  );
  expect(thread.config["features.code_mode"]).toBe(false);
  // A model without tool_search and Code Mode receives only direct specs.
  const callable = bridge.specs.filter((spec) => spec.type === "function");
  expect(callable.map((spec) => spec.name)).toEqual(tools.map((tool) => tool.name));
  expect(callable.every((spec) => spec.deferLoading !== true)).toBe(true);
  for (const forbidden of ["ALL_TOOLS", "`tool_search`", "spawn_agent"]) {
    expect(thread.developerInstructions).not.toContain(forbidden);
  }
  for (const spec of callable) {
    const result = await bridge.handleToolCall({
      threadId: "dashboard-thread",
      turnId: "dashboard-turn",
      callId: `call-${spec.name}`,
      namespace: null,
      tool: spec.name,
      arguments: {},
    });
    expect(result).toMatchObject({
      success: true,
      contentItems: [{ type: "inputText", text: `${spec.name} done` }],
    });
    expect(tools.find((tool) => tool.name === spec.name)?.execute).toHaveBeenCalledOnce();
  }
});

it.each(["direct", "searchable"] as const)(
  "preserves %s loading with native discovery",
  (loading) => {
    const resolved = resolveCodexDynamicToolsLoadingForRuntime(
      { codexDynamicToolsLoading: loading },
      "gpt-5.6-sol",
      {
        nativeToolSurfaceEnabled: true,
      },
    );
    const bridge = createCodexDynamicToolBridge({
      tools: [createRuntimeDynamicTool("dashboard")],
      loading: resolved,
      signal: new AbortController().signal,
    });
    expect(resolved).toBe(loading);
    expect(bridge.specs[0]?.type).toBe(loading === "direct" ? "function" : "namespace");
  },
);

it.each<{
  name: string;
  config?: JsonObject;
  available: boolean;
  restricted?: boolean;
  expected: boolean | undefined;
}>([
  { name: "callable default", available: true, expected: false },
  { name: "unavailable default", available: false, expected: undefined },
  {
    name: "explicit native blocking tool",
    config: { "tools.experimental_request_user_input.enabled": true },
    available: true,
    expected: true,
  },
  {
    name: "nested native blocking tool",
    config: { tools: { experimental_request_user_input: { enabled: true } } },
    available: true,
    expected: undefined,
  },
  {
    name: "explicit Default-mode native questions",
    config: { "features.default_mode_request_user_input": true },
    available: true,
    expected: undefined,
  },
  {
    name: "nested Default-mode native questions",
    config: { features: { default_mode_request_user_input: true } },
    available: true,
    expected: undefined,
  },
  {
    name: "explicit native denial without an executor",
    config: { "tools.experimental_request_user_input.enabled": false },
    available: false,
    expected: false,
  },
  {
    name: "restricted native opt-in",
    config: { "tools.experimental_request_user_input.enabled": true },
    available: true,
    restricted: true,
    expected: false,
  },
])("preserves question policy for $name", ({ config, available, restricted, expected }) => {
  const thread = buildCodexThreadConfiguration(
    createAttemptParams({ config: {}, pluginHarnessToolPolicyRestricted: restricted }),
    {
      appServer: resolveCodexAppServerRuntimeOptions({}),
      developerInstructions: "Test instructions",
      hostSystemAgentActive: false,
      nativeCodeModeEnabled: !restricted,
      askUserAvailable: available,
      config,
    },
  );
  expect(thread.config["tools.experimental_request_user_input.enabled"]).toBe(expected);
  if (config && !restricted) {
    expect(thread.config).toMatchObject(config);
  }
});
