import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { AgentToolResult } from "../../../packages/agent-core/src/types.js";
import type { AnyAgentTool } from "../agent-tools.types.js";
import { createAgentHarnessToolExecutionBoundaryRegistry } from "./tool-execution.js";
import { runAgentHarnessToolInvocation } from "./tool-invocation.js";
import { recordAgentHarnessToolResultTelemetry } from "./tool-result-facts.js";

describe("runAgentHarnessToolInvocation", () => {
  it.each([
    ["failed output", { status: "failed", exitCode: 1 }, { command: "false" }, true, false],
    [
      "Approval is unavailable.",
      { status: "approval-unavailable" },
      { command: "pwd" },
      true,
      false,
    ],
    ["Approval rejected.", { ok: true, status: "cancelled" }, {}, false, false],
    ["raw failure", { status: "timed_out" }, { command: "status" }, true, true],
    ["raw failure", { status: "cancelled" }, { command: "status" }, true, true],
    ["raw failure", { status: "blocked" }, { command: "status" }, true, true],
  ] as const)(
    "preserves %s (%j) disposition through middleware",
    async (text, details, args, isError, rewrite) => {
      const result = textToolResult(text, details);
      const middleware = vi.fn<
        Parameters<typeof runAgentHarnessToolInvocation>[0]["applyMiddleware"]
      >(async (event) => {
        if (rewrite) {
          event.result.content = [{ type: "text", text: "compacted failure" }];
          event.result.details = { stage: "middleware", status: "failed" };
        }
        return event.result;
      });
      const execution = await invokeTool(result, args, middleware);
      expect(execution.result).toEqual(result);
      expect(execution.isError).toBe(isError);
      expect(execution.boundary.executionStarted).toBe(true);
      expect(execution.executedArguments).toEqual(args);
      expect(middleware).toHaveBeenCalledWith({
        threadId: "thread-1",
        turnId: "turn-1",
        toolCallId: "call-1",
        toolName: "exec",
        args,
        cwd: undefined,
        isError,
        result,
      });
      if (rewrite) {
        expect(execution.failureKind).toBe(details.status);
        expect(execution.observerResult).toEqual({
          content: [{ type: "text", text: "compacted failure" }],
          details: { stage: "middleware", status: details.status },
        });
      } else {
        expect(execution.observerResult).toEqual(result);
      }
    },
  );

  it.each(["automations", "cron"])(
    "snapshots %s arguments before result middleware can mutate them",
    async (toolName) => {
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
        toolName,
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
