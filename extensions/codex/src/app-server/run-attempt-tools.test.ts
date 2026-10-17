import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCodexDynamicToolSpecs, projectCodexDynamicTools } from "./dynamic-tool-catalog.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type { CodexDynamicToolFunctionSpec, CodexDynamicToolSpec } from "./protocol.js";
import { resolveCodexDynamicToolDirectNames } from "./run-attempt-tools.js";

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
    createRuntimeDynamicTool("message"),
    createRuntimeDynamicTool("web_search"),
    createRuntimeDynamicTool("heartbeat_respond"),
    createRuntimeDynamicTool("agents_list"),
    createRuntimeDynamicTool("sessions_spawn"),
    createRuntimeDynamicTool("sessions_yield"),
  ];
  const toolBridge = createCodexDynamicToolBridge({
    tools,
    signal: new AbortController().signal,
    directToolNames: ["message"],
  });
  const specs = flattenSpecsWithNamespace(toolBridge.specs);
  const message = specs.find((tool) => tool.name === "message");
  const webSearch = specs.find((tool) => tool.name === "web_search");
  const heartbeat = specs.find((tool) => tool.name === "heartbeat_respond");
  const agentsList = specs.find((tool) => tool.name === "agents_list");
  const sessionsSpawn = specs.find((tool) => tool.name === "sessions_spawn");
  const sessionsYield = specs.find((tool) => tool.name === "sessions_yield");
  expect(message).not.toHaveProperty("namespace");
  expect(message).not.toHaveProperty("deferLoading");
  expect(webSearch?.namespace).toBe("openclaw");
  expect(webSearch?.deferLoading).toBe(true);
  expect(heartbeat?.namespace).toBe("openclaw");
  expect(heartbeat?.deferLoading).toBe(true);
  expect(agentsList).not.toHaveProperty("namespace");
  expect(agentsList).not.toHaveProperty("deferLoading");
  expect(sessionsSpawn).not.toHaveProperty("namespace");
  expect(sessionsSpawn).not.toHaveProperty("deferLoading");
  expect(sessionsYield).not.toHaveProperty("namespace");
  expect(sessionsYield).not.toHaveProperty("deferLoading");
});
