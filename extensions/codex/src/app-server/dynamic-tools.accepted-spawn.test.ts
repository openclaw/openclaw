import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toCodexDynamicToolProtocolResponse } from "./dynamic-tool-execution.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";

function textToolResult(text: string, details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

function createSpawnBridge(result: AgentToolResult<unknown>) {
  return createCodexDynamicToolBridge({
    tools: [
      {
        name: "sessions_spawn",
        label: "Spawn",
        description: "Delegate a bounded task.",
        parameters: Type.Object({ task: Type.String() }),
        execute: async () => result,
      },
    ],
    signal: new AbortController().signal,
  });
}

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("Codex accepted child receipts", () => {
  it.each([true, false, undefined])(
    "preserves accepted child completion intent (%s)",
    async (expectsCompletionMessage) => {
      // Preserve #96833: an accepted spawn is a successful tool call, even
      // when its child does not owe a completion message.
      const onAgentToolResult = vi.fn();
      const bridge = createSpawnBridge(
        textToolResult("Accepted: launching child session to scan logs.", {
          status: "accepted",
          runId: "run_5f3a9c",
          childSessionKey: "child-7b21",
          mode: "run",
          ...(expectsCompletionMessage !== undefined ? { expectsCompletionMessage } : {}),
        }),
      );

      const result = await bridge.handleToolCall(
        {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-accepted",
          namespace: null,
          tool: "sessions_spawn",
          arguments: { task: "scan logs" },
        },
        { onAgentToolResult },
      );

      expect(result.success).toBe(true);
      expect(result.contentItems).toEqual([
        { type: "inputText", text: "Accepted: launching child session to scan logs." },
      ]);
      expect(onAgentToolResult).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: "sessions_spawn", isError: false }),
      );
      expect(bridge.telemetry.acceptedSessionSpawns).toEqual([
        {
          runId: "run_5f3a9c",
          childSessionKey: "child-7b21",
          expectsCompletionMessage: expectsCompletionMessage === true,
        },
      ]);
    },
  );

  it.each([true, undefined])(
    "preserves an accepted sessions_spawn after result middleware strips its details (%s)",
    async (expectsCompletionMessage) => {
      const registry = createEmptyPluginRegistry();
      const handler = vi.fn(async (event: { result: AgentToolResult<unknown> }) => ({
        result: {
          ...event.result,
          content: [{ type: "text" as const, text: "Child launch recorded." }],
          details: {},
        },
      }));
      registry.agentToolResultMiddlewares.push({
        pluginId: "result-compactor",
        pluginName: "Result Compactor",
        rawHandler: handler,
        handler,
        runtimes: ["codex"],
        source: "test",
      });
      setActivePluginRegistry(registry);
      const bridge = createSpawnBridge(
        textToolResult("Accepted: launching child session.", {
          status: "accepted",
          runId: "run_compacted",
          childSessionKey: "child-compacted",
          ...(expectsCompletionMessage !== undefined ? { expectsCompletionMessage } : {}),
        }),
      );

      const result = await bridge.handleToolCall({
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-compacted",
        namespace: null,
        tool: "sessions_spawn",
        arguments: { task: "scan logs" },
      });

      expect(toCodexDynamicToolProtocolResponse(result)).toEqual({
        success: true,
        contentItems: [{ type: "inputText", text: "Child launch recorded." }],
      });
      expect(bridge.telemetry.acceptedSessionSpawns).toEqual([
        {
          runId: "run_compacted",
          childSessionKey: "child-compacted",
          expectsCompletionMessage: expectsCompletionMessage === true,
        },
      ]);
    },
  );
});
