import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { describe, expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { parseCodexNativeToolCatalog } from "./native-tool-catalog.js";
import type { CodexDynamicToolFunctionSpec, CodexDynamicToolSpec, JsonValue } from "./protocol.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";

const CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE = "openclaw";
const FULL_MESSAGE_PARAMETERS = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["send", "react"] },
    message: { type: "string" },
    emoji: { type: "string" },
    pollId: { type: "string" },
    target: { type: "string" },
  },
  required: ["action"],
  additionalProperties: false,
};

function createMessageTool(overrides: Partial<AnyAgentTool> = {}): AnyAgentTool {
  return {
    name: "message",
    description: "Full message manager.",
    parameters: FULL_MESSAGE_PARAMETERS,
    execute: vi.fn(),
    ...overrides,
  } as unknown as AnyAgentTool;
}

function textToolResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: {} };
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

async function callMessageTool(
  bridge: ReturnType<typeof createCodexDynamicToolBridge>,
  params: { callId: string; namespace: string | null; arguments: JsonValue },
) {
  return await bridge.handleToolCall({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: params.callId,
    namespace: params.namespace,
    tool: "message",
    arguments: params.arguments,
  });
}

describe("Codex direct message tool schema", () => {
  it("publishes a narrow root contract and keeps the full manager deferred", () => {
    const bridge = createCodexDynamicToolBridge({
      tools: [createMessageTool()],
      signal: new AbortController().signal,
      directToolNames: ["message"],
    });

    const specs = flattenSpecsWithNamespace(bridge.specs);
    const directMessage = specs.find((tool) => tool.namespace === undefined);
    const deferredMessage = specs.find(
      (tool) => tool.namespace === CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE,
    );

    expect(directMessage?.description).toContain("current source conversation");
    expect(directMessage?.inputSchema).toEqual(
      expect.objectContaining({
        type: "object",
        additionalProperties: false,
        required: ["action", "message"],
        properties: expect.objectContaining({
          action: expect.objectContaining({ enum: ["send"] }),
          message: expect.objectContaining({ type: "string" }),
          final: expect.objectContaining({ type: "boolean" }),
        }),
      }),
    );
    expect(JSON.stringify(directMessage?.inputSchema)).not.toContain("pollId");
    expect(directMessage).not.toHaveProperty("deferLoading");
    expect(deferredMessage?.deferLoading).toBe(true);
    expect(deferredMessage?.description).toBe("Full message manager.");
    expect(JSON.stringify(deferredMessage?.inputSchema)).toContain("pollId");
  });

  it("enforces the root source-reply contract while retaining deferred rich actions", async () => {
    const execute = vi.fn(async () => textToolResult("message accepted"));
    const prepareArguments = vi.fn((arguments_: unknown) => arguments_);
    const bridge = createCodexDynamicToolBridge({
      tools: [createMessageTool({ prepareArguments, execute })],
      signal: new AbortController().signal,
      directToolNames: ["message"],
    });

    const richRoot = await callMessageTool(bridge, {
      callId: "call-root-rich",
      namespace: null,
      arguments: { action: "react", emoji: "✅" },
    });
    expect(richRoot).toMatchObject({
      success: false,
      executionStarted: false,
      contentItems: [{ type: "inputText", text: expect.stringContaining("action") }],
    });

    const routedRoot = await callMessageTool(bridge, {
      callId: "call-root-routed",
      namespace: null,
      arguments: { action: "send", message: "hello", target: "other-destination" },
    });
    expect(routedRoot).toMatchObject({
      success: false,
      executionStarted: false,
      contentItems: [{ type: "inputText", text: expect.stringContaining("additional properties") }],
    });
    // Rejection happens before message-specific preparation can read media.
    expect(prepareArguments).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    const rootSend = await callMessageTool(bridge, {
      callId: "call-root-send",
      namespace: null,
      arguments: { action: "send", message: "hello", final: true },
    });
    expect(rootSend.success).toBe(true);

    const deferredRich = await callMessageTool(bridge, {
      callId: "call-deferred-rich",
      namespace: CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE,
      arguments: { action: "react", emoji: "✅" },
    });
    expect(deferredRich.success).toBe(true);
    expect(prepareArguments).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("enforces the stored native root contract after a supervised catalog round trip", async () => {
    const execute = vi.fn(async () => textToolResult("message accepted"));
    const prepareArguments = vi.fn((arguments_: unknown) => arguments_);
    const tool = createMessageTool({ prepareArguments, execute });
    const initial = createCodexDynamicToolBridge({
      tools: [tool],
      signal: new AbortController().signal,
      directToolNames: ["message"],
    });
    const storedSpecs = parseCodexNativeToolCatalog(
      { id: "thread-1", dynamic_tools: structuredClone(initial.specs) },
      "thread-1",
      codexDynamicToolsFingerprint(initial.specs),
    );
    const resumed = createCodexDynamicToolBridge({
      tools: [tool],
      registeredSpecs: storedSpecs,
      signal: new AbortController().signal,
      directToolNames: ["message"],
    });

    const invalidRootCases: Array<{ callId: string; arguments: JsonValue }> = [
      { callId: "call-rich", arguments: { action: "react", emoji: "✅" } },
      {
        callId: "call-routed",
        arguments: { action: "send", message: "hello", target: "other-destination" },
      },
    ];
    for (const invalid of invalidRootCases) {
      const rejected = await callMessageTool(resumed, {
        callId: invalid.callId,
        namespace: null,
        arguments: invalid.arguments,
      });
      expect(rejected).toMatchObject({ success: false, executionStarted: false });
    }
    expect(prepareArguments).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    expect(
      (
        await callMessageTool(resumed, {
          callId: "call-resumed-send",
          namespace: null,
          arguments: { action: "send", message: "hello" },
        })
      ).success,
    ).toBe(true);
    expect(
      (
        await callMessageTool(resumed, {
          callId: "call-resumed-react",
          namespace: CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE,
          arguments: { action: "react", emoji: "✅" },
        })
      ).success,
    ).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("keeps the full message schema directly visible and unenforced in direct mode", async () => {
    const execute = vi.fn(async () => textToolResult("compatibility message accepted"));
    const bridge = createCodexDynamicToolBridge({
      tools: [createMessageTool({ execute })],
      signal: new AbortController().signal,
      loading: "direct",
      directToolNames: ["message"],
    });

    const specs = flattenSpecsWithNamespace(bridge.specs);
    expect(specs).toHaveLength(1);
    expect(specs[0]).not.toHaveProperty("namespace");
    expect(specs[0]?.description).toBe("Full message manager.");
    expect(JSON.stringify(specs[0]?.inputSchema)).toContain("pollId");

    const result = await callMessageTool(bridge, {
      callId: "call-direct-compatibility",
      namespace: null,
      arguments: { action: "react", emoji: "✅" },
    });
    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledOnce();

    const inherited = createCodexDynamicToolBridge({
      tools: [createMessageTool({ execute })],
      registeredSpecs: structuredClone(bridge.specs),
      signal: new AbortController().signal,
    });
    expect(
      (
        await callMessageTool(inherited, {
          callId: "call-inherited-direct-compatibility",
          namespace: null,
          arguments: { action: "react", emoji: "✅" },
        })
      ).success,
    ).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
