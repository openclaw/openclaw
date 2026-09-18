import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markSynchronousCoreFileResult,
  type CodexDynamicToolRuntimeResponse,
} from "./dynamic-tool-response-state.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { createCodexDynamicToolExecutionRegistry } from "./run-attempt-tools.js";

const call = { threadId: "thread", turnId: "turn", callId: "write", tool: "write", arguments: {} };
function response(
  state: "read_completed" | "mutation_committed" | "uncertain",
): CodexDynamicToolRuntimeResponse {
  const result: CodexDynamicToolRuntimeResponse = {
    success: true,
    executedArguments: {},
    contentItems: [{ type: "inputText", text: "completed" }],
    terminalResolution: {
      executionStarted: true,
      sideEffectEvidence: state !== "read_completed",
      effectReceipt: { state },
    },
  };
  markSynchronousCoreFileResult(
    result,
    Object.freeze({
      tool: "write",
      argumentsJson: "{}",
      contentJson: JSON.stringify(result.contentItems),
    }),
  );
  return result;
}

describe("quota continuation dynamic execution evidence", () => {
  it.each(["read_completed", "mutation_committed"] as const)(
    "accepts host-owned %s evidence exactly once",
    async (state) => {
      const registry = createCodexDynamicToolExecutionRegistry();
      const start = vi.fn(async () => response(state));
      const first = registry.claim(call, start);
      const duplicate = registry.claim(call, start);
      expect(duplicate.execution).toBe(first.execution);
      expect(registry.isSettled(call)).toBe(false);
      await first.execution;
      expect(start).toHaveBeenCalledTimes(1);
      expect(registry.size).toBe(1);
      expect(registry.isSettled(call)).toBe(true);
      expect(registry.isSettled({ ...call, turnId: "other-turn" })).toBe(false);
    },
  );

  it("does not let an in-place argument mutation rewrite the pre-execution receipt", async () => {
    const registry = createCodexDynamicToolExecutionRegistry();
    const original = { ...call, arguments: { content: "original" } };
    await registry.claim(original, async () => {
      original.arguments.content = "adjusted";
      const result = response("mutation_committed");
      result.executedArguments = { content: "adjusted" };
      return result;
    }).execution;
    expect(registry.isSettled(original)).toBe(false);
  });

  it.each(["adjusted", "rewritten", "oversized", "image"] as const)(
    "rejects %s execution/display evidence",
    async (kind) => {
      const registry = createCodexDynamicToolExecutionRegistry();
      const result = response("mutation_committed");
      if (kind === "adjusted") {
        result.executedArguments = { changed: true };
      }
      if (kind === "oversized") {
        result.contentItems = [{ type: "inputText", text: "x".repeat(12_000) }];
      }
      if (kind === "image") {
        result.contentItems = [{ type: "inputImage", imageUrl: "data:image/png;base64,synthetic" }];
      }
      await registry.claim(call, async () => result).execution;
      const transcript = [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: call.callId, name: call.tool, arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: call.callId,
          toolName: call.tool,
          isError: false,
          content: [{ type: "text", text: kind === "rewritten" ? "different" : "completed" }],
        },
      ];
      expect(registry.matchesSettledTranscript(call.threadId, call.turnId, transcript)).toBe(false);
    },
  );

  it.each(["unknown", "missing", "async", "no-start", "failure", "copied-provenance"] as const)(
    "rejects %s evidence despite success-like text",
    async (kind) => {
      const registry = createCodexDynamicToolExecutionRegistry();
      const result = response(kind === "unknown" ? "uncertain" : "mutation_committed");
      if (kind === "missing") {
        delete result.terminalResolution;
      }
      if (kind === "async") {
        result.asyncStarted = true;
      }
      if (kind === "no-start" && result.terminalResolution) {
        result.terminalResolution.executionStarted = false;
      }
      if (kind === "failure") {
        result.success = false;
      }
      await registry.claim(call, async () =>
        kind === "copied-provenance" ? { ...result } : result,
      ).execution;
      expect(registry.isSettled(call)).toBe(false);
    },
  );
});

describe("pre-presentation concrete file receipts", () => {
  afterEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));
  it.each(["normal", "middleware", "in-place", "legacy", "budget", "sanitized", "callback"])(
    "keeps ordinary presentation but only certifies lossless %s results",
    async (kind) => {
      const plugins = createEmptyPluginRegistry();
      const entered = vi.fn();
      if (kind === "middleware" || kind === "in-place") {
        const handler: (typeof plugins.agentToolResultMiddlewares)[number]["handler"] = async ({
          result,
        }) => {
          entered();
          if (kind === "in-place") {
            const block = result.content[0];
            if (block?.type === "text") {
              block.text = "rewritten";
            }
            return { result };
          }
          return { result: { ...result, content: [{ type: "text", text: "rewritten" }] } };
        };
        plugins.agentToolResultMiddlewares.push({
          pluginId: "fixture",
          source: "test",
          runtimes: ["codex"],
          rawHandler: handler,
          handler,
        });
      }
      if (kind === "legacy") {
        const factory: (typeof plugins.codexAppServerExtensionFactories)[number]["factory"] = (
          codex,
        ) => {
          codex.on("tool_result", ({ result }) => {
            entered();
            return { result: { ...result, content: [{ type: "text", text: "rewritten" }] } };
          });
        };
        plugins.codexAppServerExtensionFactories.push({
          pluginId: "fixture",
          pluginName: "Fixture",
          rawFactory: factory,
          factory,
          source: "test",
        });
      }
      setActivePluginRegistry(plugins);
      // Synthetic no-effect tool and terminal outcome; bridge and middleware are real.
      const raw =
        kind === "budget"
          ? "x".repeat(12000)
          : kind === "sanitized"
            ? "Authorization: Bearer synthetic-nonusable-fixture-1234567890"
            : "ACTUAL RESULT";
      const concrete: AgentToolResult<unknown> = {
        content: [{ type: "text", text: raw }],
        details: {},
      };
      const bridge = createCodexDynamicToolBridge({
        tools: [
          {
            name: "read",
            description: "No-effect fixture",
            label: "read",
            parameters: Type.Object({}),
            execute: async () => concrete,
          },
        ],
        signal: new AbortController().signal,
        hookContext: { contextWindowTokens: kind === "budget" ? 4096 : 32768 },
      });
      const request = { ...call, tool: "read", namespace: null };
      const receipts = createCodexDynamicToolExecutionRegistry();
      const result = await receipts.claim(request, async () => {
        const bridgeResponse = await bridge.handleToolCall(
          request,
          kind === "callback"
            ? {
                onAgentToolResult: () => {
                  entered();
                  // The observer normally receives sanitized data. Mutate a retained
                  // concrete-result reference to test the pre-callback receipt boundary.
                  const block = concrete.content[0];
                  if (block?.type === "text") {
                    block.text = "rewritten";
                  }
                },
              }
            : undefined,
        );
        bridgeResponse.terminalResolution = {
          executionStarted: true,
          sideEffectEvidence: false,
          effectReceipt: { state: "read_completed" },
        };
        return bridgeResponse;
      }).execution;
      const output = result.contentItems
        .flatMap((item) =>
          item.type === "inputText" && typeof item.text === "string" ? [item.text] : [],
        )
        .join("\n")
        .trim();
      expect(result.success).toBe(true);
      expect(receipts.isSettled(request)).toBe(kind === "normal");
      expect(
        receipts.matchesSettledTranscript(request.threadId, request.turnId, [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: request.callId, name: request.tool, arguments: {} }],
          },
          {
            role: "toolResult",
            toolCallId: request.callId,
            toolName: request.tool,
            isError: false,
            content: [{ type: "text", text: output }],
          },
        ]),
      ).toBe(kind === "normal");
      if (["middleware", "in-place", "legacy", "callback"].includes(kind)) {
        expect(entered).toHaveBeenCalled();
      }
      if (kind !== "normal") {
        expect(output).not.toBe(raw);
      }
      if (kind === "budget") {
        expect(output.length).toBeLessThan(10000);
        expect(output).toContain("OpenClaw truncated");
      }
      if (kind === "sanitized") {
        expect(output).not.toContain("synthetic-nonusable-fixture-1234567890");
      }
    },
  );
});
