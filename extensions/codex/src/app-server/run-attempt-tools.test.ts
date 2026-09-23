import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createCodexDynamicToolSpecs, projectCodexDynamicTools } from "./dynamic-tool-catalog.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import {
  flattenCodexDynamicToolFunctions,
  type CodexDynamicToolFunctionSpec,
  type CodexDynamicToolSpec,
} from "./protocol.js";
import { resolveCodexDynamicToolDirectNames } from "./run-attempt-tools.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";

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

function specNames(specs: readonly CodexDynamicToolSpec[]): string[] {
  return flattenCodexDynamicToolFunctions(specs).map((tool) => tool.name);
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

  it.each([false, true])(
    "keeps registered catalog bytes stable and enforces message availability when disabled=%s",
    async (disableMessageTool) => {
      const execute = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "sent" }],
        details: {},
      }));
      const tool: AnyAgentTool = {
        name: "message",
        label: "Message",
        description: "Send messages",
        parameters: Type.Object({}),
        execute,
      };
      const bridges = (["automatic", "message_tool_only", "automatic"] as const).map(
        (sourceReplyDeliveryMode) =>
          createCodexDynamicToolBridge({
            tools: disableMessageTool ? [] : [tool],
            registeredTools: [tool],
            signal: new AbortController().signal,
            loading: "searchable",
            directToolNames: resolveCodexDynamicToolDirectNames(
              createAttemptParams({ sourceReplyDeliveryMode, disableMessageTool }),
              [tool],
            ),
          }),
      );

      expect(JSON.stringify(bridges[1]?.specs)).toBe(JSON.stringify(bridges[0]?.specs));
      expect(JSON.stringify(bridges[2]?.specs)).toBe(JSON.stringify(bridges[0]?.specs));
      expect(
        bridges[0]?.specs.some((spec) => spec.type === "function" && spec.name === "message"),
      ).toBe(true);
      if (disableMessageTool) {
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
          expect(result.success).toBe(false);
        }
        expect(execute).not.toHaveBeenCalled();
      }
    },
  );
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

it("keeps message in the registered schema when disabled for an internal turn", async () => {
  const params = createAttemptParams({
    disableTools: false,
    disableMessageTool: true,
    sourceReplyDeliveryMode: "message_tool_only",
  });
  const availableTools: RuntimeDynamicToolForTest[] = [];
  const registeredTools = [createRuntimeDynamicTool("message")];
  const bridge = createCodexToolBridgeForTest(params, availableTools, registeredTools);
  const normalParams = createAttemptParams({
    disableTools: false,
    sourceReplyDeliveryMode: "message_tool_only",
  });
  const normalTools = [createRuntimeDynamicTool("message")];
  const normalRegisteredTools = [createRuntimeDynamicTool("message")];
  const normalBridge = createCodexToolBridgeForTest(
    normalParams,
    normalTools,
    normalRegisteredTools,
  );
  expect(bridge.availableSpecs.map((tool) => tool.name)).not.toContain("message");
  expect(bridge.specs.map((tool) => tool.name)).toContain("message");
  expect(codexDynamicToolsFingerprint(bridge.specs)).toBe(
    codexDynamicToolsFingerprint(normalBridge.specs),
  );
  await expect(
    bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "message",
      arguments: {},
    }),
  ).resolves.toMatchObject({
    success: false,
    contentItems: [
      {
        type: "inputText",
        text: "OpenClaw tool is not available for this turn: message",
      },
    ],
  });
});

it("keeps the persistent dynamic schema stable across heartbeat-only turns", async () => {
  const createHeartbeatRunParams = (trigger?: EmbeddedRunAttemptParams["trigger"]) =>
    createAttemptParams({ disableTools: false, ...(trigger ? { trigger } : {}) });
  const registeredTools = [
    createRuntimeDynamicTool("message"),
    createRuntimeDynamicTool("web_search"),
    createRuntimeDynamicTool("heartbeat_respond"),
  ];
  const normalBridge = createCodexToolBridgeForTest(
    createHeartbeatRunParams(),
    registeredTools,
    registeredTools,
  );
  const heartbeatBridge = createCodexToolBridgeForTest(
    createHeartbeatRunParams("heartbeat"),
    [createRuntimeDynamicTool("heartbeat_respond")],
    registeredTools,
  );
  const nextNormalBridge = createCodexToolBridgeForTest(
    createHeartbeatRunParams(),
    registeredTools,
    registeredTools,
  );
  expect(specNames(heartbeatBridge.availableSpecs)).toEqual(["heartbeat_respond"]);
  expect(specNames(heartbeatBridge.specs)).toEqual(specNames(normalBridge.specs));
  expect(specNames(nextNormalBridge.specs)).toEqual(specNames(normalBridge.specs));
});
