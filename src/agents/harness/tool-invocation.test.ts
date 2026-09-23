import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { AgentToolResult } from "../../../packages/agent-core/src/types.js";
import type { AnyAgentTool } from "../agent-tools.types.js";
import { createAgentHarnessToolExecutionBoundaryRegistry } from "./tool-execution.js";
import { runAgentHarnessToolInvocation } from "./tool-invocation.js";
import { recordAgentHarnessToolResultTelemetry } from "./tool-result-facts.js";

describe("runAgentHarnessToolInvocation", () => {
  it("passes raw tool failure state into agent tool result middleware", async () => {
    const result = textToolResult("failed output", { status: "failed", exitCode: 1 });
    const middleware = vi.fn<
      Parameters<typeof runAgentHarnessToolInvocation>[0]["applyMiddleware"]
    >(async (event) => event.result);
    const execution = await invokeTool(result, { command: "false" }, middleware);

    expect(execution.result).toEqual(result);
    expect(execution.isError).toBe(true);
    expect(execution.boundary.executionStarted).toBe(true);
    expect(execution.executedArguments).toEqual({ command: "false" });
    expect(middleware).toHaveBeenCalledWith({
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      toolName: "exec",
      args: { command: "false" },
      cwd: undefined,
      isError: true,
      result,
    });
  });

  it("keeps shared failure statuses fail-closed", async () => {
    const result = textToolResult("Approval is unavailable.", { status: "approval-unavailable" });
    const execution = await invokeTool(result, { command: "pwd" });

    expect(execution.isError).toBe(true);
    expect(execution.observerResult).toEqual(result);
  });

  it("preserves explicitly successful cancellation outcomes", async () => {
    const result = textToolResult("Approval rejected.", { ok: true, status: "cancelled" });
    const execution = await invokeTool(result);

    expect(execution.isError).toBe(false);
    expect(execution.observerResult).toEqual(result);
  });

  it("snapshots executed arguments before result middleware can mutate them", async () => {
    const result = textToolResult("added", { id: "job-1" });
    const execution = await invokeTool(
      result,
      { action: "add", job: { name: "reminder" } },
      async (event) => {
        event.args.action = "status";
        return event.result;
      },
    );
    const telemetry = {
      didSendViaMessagingTool: false,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      messagingToolSourceReplyPayloads: [],
      confirmedMediaDeliveries: [],
      toolMediaUrls: [],
      toolAutoDeliveryMediaUrls: [],
      coreTtsToolResults: [],
      toolAudioAsVoice: false,
      successfulCronAdds: 0,
    };
    recordAgentHarnessToolResultTelemetry({
      toolName: "cron",
      args: execution.executedArguments,
      result: execution.result,
      telemetry,
      isError: execution.isError,
      messagingDelivered: false,
      mediaDeliveryConfirmed: false,
      extractSourceReplyPayload: () => undefined,
      collectMessagingMediaUrls: () => [],
      resolveMessagingMediaSourceUrls: (urls) => urls,
      signal: new AbortController().signal,
    });

    expect(execution.boundary.executionStarted).toBe(true);
    expect(telemetry.successfulCronAdds).toBe(1);
  });

  it.each(["timed_out", "cancelled", "blocked"] as const)(
    "preserves raw %s disposition for private observation after middleware rewrites it",
    async (status) => {
      const execution = await invokeTool(
        textToolResult("raw failure", { status }),
        { command: "status" },
        async (event) => {
          event.result.content = [{ type: "text", text: "compacted failure" }];
          event.result.details = { stage: "middleware", status: "failed" };
          return event.result;
        },
      );

      expect(execution.isError).toBe(true);
      expect(execution.failureKind).toBe(status);
      expect(execution.observerResult).toEqual({
        content: [{ type: "text", text: "compacted failure" }],
        details: { stage: "middleware", status },
      });
    },
  );
});

function textToolResult(text: string, details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

function invokeTool(
  result: AgentToolResult<unknown>,
  args: Record<string, unknown> = {},
  applyMiddleware: Parameters<typeof runAgentHarnessToolInvocation>[0]["applyMiddleware"] = async (
    event,
  ) => event.result,
) {
  const tool: AnyAgentTool = {
    name: "exec",
    label: "exec",
    description: "Execute a tool.",
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async () => result,
  };
  return runAgentHarnessToolInvocation({
    tool,
    call: {
      toolCallId: "call-1",
      toolName: tool.name,
      arguments: args,
      threadId: "thread-1",
      turnId: "turn-1",
    },
    signal: new AbortController().signal,
    boundaries: createAgentHarnessToolExecutionBoundaryRegistry(),
    applyMiddleware,
    onResult: (execution) => execution,
    onError: ({ error }) => {
      throw error;
    },
  });
}
