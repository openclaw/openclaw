import { describe, expect, it } from "vitest";
import { resolveEmbeddedRunFailureSignal } from "./embedded-agent-runner/failure-signal.js";
import {
  createTestContext,
  endTool,
} from "./embedded-agent-subscribe.handlers.tools.test-support.js";

describe("node failure projection", () => {
  it("preserves policy denial codes for cron failure classification", async () => {
    const { ctx } = createTestContext();
    await endTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-node-policy-denied",
      result: {
        content: [{ type: "text", text: "Node command was denied before execution." }],
        details: {
          status: "failed",
          failureKind: "policy-denied",
          reason: "policy-denied",
          nodeInvokeFailure: {
            failureCode: "SYSTEM_RUN_DENIED",
            message: "execution denied by node policy",
          },
        },
      },
    });

    expect(ctx.state.lastToolError).toMatchObject({
      toolName: "exec",
      errorCode: "SYSTEM_RUN_DENIED",
    });
    expect(
      resolveEmbeddedRunFailureSignal({
        trigger: "cron",
        lastToolError: ctx.state.lastToolError,
      }),
    ).toMatchObject({
      kind: "execution_denied",
      code: "SYSTEM_RUN_DENIED",
      fatalForCron: true,
    });
  });

  it("keeps non-denial node invoke failures nonfatal for cron", async () => {
    const { ctx } = createTestContext();
    await endTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-node-timeout",
      result: {
        content: [{ type: "text", text: "Node command outcome is unknown." }],
        details: {
          status: "failed",
          failureKind: "outcome-unknown",
          reason: "outcome-unknown",
          nodeInvokeFailure: {
            failureCode: "TIMEOUT",
            message: "node invoke timed out",
          },
        },
      },
    });

    expect(ctx.state.lastToolError).toMatchObject({
      toolName: "exec",
      errorCode: "TIMEOUT",
    });
    expect(
      resolveEmbeddedRunFailureSignal({
        trigger: "cron",
        lastToolError: ctx.state.lastToolError,
      }),
    ).toBeUndefined();
  });
});
