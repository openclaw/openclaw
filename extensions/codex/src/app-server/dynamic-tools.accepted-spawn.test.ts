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
    "preserves an accepted sessions_spawn after result middleware strips its details (%s)",
    async (expectsCompletionMessage) => {
      // Preserve #96833: an accepted spawn is a successful tool call, even
      // when its child does not owe a completion message.
      const onAgentToolResult = vi.fn();
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

      const result = await bridge.handleToolCall(
        {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-compacted",
          namespace: null,
          tool: "sessions_spawn",
          arguments: { task: "scan logs" },
        },
        { onAgentToolResult },
      );

      expect(toCodexDynamicToolProtocolResponse(result)).toEqual({
        success: true,
        contentItems: [{ type: "inputText", text: "Child launch recorded." }],
      });
      expect(onAgentToolResult).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: "sessions_spawn", isError: false }),
      );
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
