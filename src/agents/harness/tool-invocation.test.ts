import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import type { AgentToolResult } from "../../../packages/agent-core/src/types.js";
import { createAgentHarnessToolExecutionBoundaryRegistry } from "./tool-execution.js";
import { runAgentHarnessToolInvocation } from "./tool-invocation.js";
import {
  createTelemetry,
  recordTelemetry,
  textToolResult,
} from "./tool-result-facts.test-support.js";

const call = { toolCallId: "call-1", toolName: "exec", threadId: "thread-1", turnId: "turn-1" };
type Middleware = Parameters<typeof runAgentHarnessToolInvocation>[0]["applyMiddleware"];

it.each([
  ["failed output", { status: "failed", exitCode: 1 }, { command: "false" }, true, false],
  ["Approval is unavailable.", { status: "approval-unavailable" }, { command: "pwd" }, true, false],
  ["Approval rejected.", { ok: true, status: "cancelled" }, {}, false, false],
  ["raw failure", { status: "timed_out" }, { command: "status" }, true, true],
  ["raw failure", { status: "cancelled" }, { command: "status" }, true, true],
  ["raw failure", { status: "blocked" }, { command: "status" }, true, true],
] as const)(
  "tool invocation preserves %s (%j) disposition through middleware",
  async (text, details, args, isError, rewrite) => {
    const result = textToolResult(text, details);
    const middleware = vi.fn<Middleware>(async (event) => {
      if (rewrite) {
        event.result.content = [{ type: "text", text: "compacted failure" }];
        event.result.details = { stage: "middleware", status: "failed" };
      }
      return event.result;
    });
    const execution = await invokeTool(result, args, middleware);
    expect(execution.result).toEqual(result);
    expect(execution.executedArguments).toEqual(args);
    expect(execution).toMatchObject({ isError, boundary: { executionStarted: true } });
    expect(middleware).toHaveBeenCalledWith({
      ...call,
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
  const telemetry = createTelemetry();
  telemetry.successfulCronAdds = 0;
  recordTelemetry({
    toolName: "cron",
    args: execution.executedArguments,
    result: execution.result,
    telemetry,
    isError: execution.isError,
  });

  expect(execution.boundary.executionStarted).toBe(true);
  expect(telemetry.successfulCronAdds).toBe(1);
});

function invokeTool(
  result: AgentToolResult<unknown>,
  args: Record<string, unknown> = {},
  applyMiddleware: Middleware = async (event) => event.result,
) {
  return runAgentHarnessToolInvocation({
    tool: {
      name: "exec",
      label: "exec",
      description: "Execute a tool.",
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async () => result,
    },
    call: { ...call, arguments: args },
    signal: new AbortController().signal,
    boundaries: createAgentHarnessToolExecutionBoundaryRegistry(),
    applyMiddleware,
    onResult: (execution) => execution,
    onError: ({ error }) => {
      throw error;
    },
  });
}
