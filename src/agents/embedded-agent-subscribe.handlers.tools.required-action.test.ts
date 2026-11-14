import { describe, expect, it } from "vitest";
import { handleToolExecutionStart } from "./embedded-agent-subscribe.handlers.tools.start.js";
import {
  createTestContext,
  endTool,
  resultWithDetails,
} from "./embedded-agent-subscribe.handlers.tools.test-support.js";

async function runAskUserResult(status: "action_unresolved" | "ready_to_verify") {
  const { ctx } = createTestContext();
  const toolCallId = `ask-user-${status}`;
  await handleToolExecutionStart(ctx, {
    type: "tool_execution_start",
    toolName: "ask_user",
    toolCallId,
    args: {},
  });
  await endTool(ctx, {
    toolName: "ask_user",
    toolCallId,
    result: resultWithDetails({
      status,
      ...(status === "action_unresolved" ? { reason: "declined" } : {}),
    }),
  });
  return ctx.state.toolMetas[0];
}

describe("ask_user completion facts", () => {
  it("records action_unresolved without interpreting model text", async () => {
    const meta = await runAskUserResult("action_unresolved");

    expect(meta).toMatchObject({
      toolName: "ask_user",
      requiredActionUnresolved: true,
    });
  });

  it("does not mark ready_to_verify as unresolved", async () => {
    const meta = await runAskUserResult("ready_to_verify");

    expect(meta).not.toHaveProperty("requiredActionUnresolved");
  });
});
