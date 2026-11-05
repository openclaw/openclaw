// Regression: both adapter and subscription are active in embedded runs (PR #27283).
import { expectDefined } from "@openclaw/normalization-core";
import type { AgentTool } from "openclaw/plugin-sdk/agent-core";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { createToolHandlerMocks } from "./agent-tool-handler-state.test-helpers.js";
import { peekAdjustedParamsForToolCall } from "./agent-tools.before-tool-call.state.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { handleToolExecutionEnd } from "./embedded-agent-subscribe.handlers.tools.completion.js";
import { handleToolExecutionStart } from "./embedded-agent-subscribe.handlers.tools.start.js";
import { prepareToolResult } from "./embedded-agent-tool-results.js";

const hookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn(() => true),
  runAfterToolCall: vi.fn(
    async (_event: { error?: unknown; params?: Record<string, unknown> }) => {},
  ),
}));
const beforeHook = vi.hoisted(() =>
  vi.fn(async ({ params }: { params: unknown }) => ({ blocked: false, params })),
);

function createToolHandlerCtx() {
  return {
    params: { runId: "integration-test", session: { messages: [] } },
    hookRunner,
    ...createToolHandlerMocks(),
  };
}

vi.mock("../infra/agent-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/agent-events.js")>()),
  emitAgentCommandOutputEvent: vi.fn(),
  emitAgentEvent: vi.fn(),
  emitAgentItemEvent: vi.fn(),
}));
vi.mock("./agent-tools.before-tool-call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-tools.before-tool-call.js")>()),
  runBeforeToolCallHook: beforeHook,
}));

describe("after_tool_call fires exactly once in embedded runs", () => {
  beforeEach(() => vi.clearAllMocks());

  function createToolCall(toolName: string, fail = false) {
    const tool: AgentTool = {
      name: toolName,
      label: toolName,
      description: `test tool: ${toolName}`,
      parameters: Type.Object({}),
      execute: async () => {
        if (fail) {
          throw new Error("tool failed");
        }
        return { content: [{ type: "text", text: "ok" }], details: { ok: true } };
      },
    };
    const def = expectDefined(
      toToolDefinitions([tool], { runId: "integration-test" })[0],
      "tool definition",
    );
    const extensionContext = {} as Parameters<typeof def.execute>[4];
    return (toolCallId: string, args: Record<string, unknown>, ctx = createToolHandlerCtx()) => ({
      async start() {
        await handleToolExecutionStart(
          ctx as never,
          { type: "tool_execution_start", toolName, toolCallId, args } as never,
        );
        await def.execute(toolCallId, args, undefined, undefined, extensionContext);
      },
      async end(result: unknown) {
        return await handleToolExecutionEnd(
          ctx as never,
          { type: "tool_execution_end", toolName, toolCallId, isError: fail, result } as never,
          prepareToolResult(result),
        );
      },
    });
  }

  it("fires after_tool_call exactly once on error when both adapter and handler are active", async () => {
    const call = createToolCall("exec", true)("integration-call-err", { command: "fail" });
    await call.start();
    await call.end({ status: "error", error: "tool failed" });

    expect(hookRunner.runAfterToolCall).toHaveBeenCalledTimes(1);
    const event = hookRunner.runAfterToolCall.mock.calls[0]?.[0];
    expect(event?.error).toBe("tool failed");
  });

  it("uses before_tool_call adjusted params for after_tool_call payload", async () => {
    const ctx = createToolHandlerCtx();
    const toolCall = createToolCall("read");
    const toolCallId = "integration-call-adjusted";
    const args = { path: "/tmp/original.txt" };
    const adjusted = { path: "/tmp/adjusted.txt", mode: "safe" };
    const call = toolCall(toolCallId, args, ctx);

    beforeHook.mockResolvedValueOnce({ blocked: false, params: adjusted });
    await call.start();
    expect(peekAdjustedParamsForToolCall(toolCallId, "integration-test")).toEqual(adjusted);
    const terminal = await call.end({ content: [{ type: "text", text: "ok" }] });
    expect(peekAdjustedParamsForToolCall(toolCallId, "integration-test")).toBeUndefined();
    const event = hookRunner.runAfterToolCall.mock.calls[0]?.[0];
    expect(event?.params).toEqual(adjusted);
    // Plugin-owned hook inputs remain mutable without changing retained execution facts.
    event!.params!.path = "/tmp/plugin.txt";
    expect(terminal.executedArguments).toEqual({ path: "/tmp/adjusted.txt", mode: "safe" });
    expect(hookRunner.runAfterToolCall).toHaveBeenCalledTimes(1);
    for (const id of ["next-call", "last-call"]) {
      const next = toolCall(id, args, ctx);
      await next.start();
      await next.end({ content: [{ type: "text", text: "ok" }] });
    }

    expect(hookRunner.runAfterToolCall).toHaveBeenCalledTimes(3);
  });
});
