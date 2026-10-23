import { describe, expect, it } from "vitest";
import { handleToolExecutionStart } from "./embedded-agent-subscribe.handlers.tools.start.js";
import {
  createTestContext,
  endTool,
} from "./embedded-agent-subscribe.handlers.tools.test-support.js";

describe("unknown-tool fallback replay safety", () => {
  it.each([false, true, undefined])(
    "records replay safety with executionStarted=%s",
    async (executionStarted) => {
      const { ctx } = createTestContext();
      const call = { toolName: "malformed_tool_call", toolCallId: "unknown-tool" };
      await handleToolExecutionStart(ctx, {
        type: "tool_execution_start",
        ...call,
        args: {},
      });
      await endTool(ctx, {
        ...call,
        isError: true,
        executionStarted,
        result: { content: [{ type: "text", text: "Tool not found" }] },
      });

      expect(ctx.state.toolMetas).toEqual([
        expect.objectContaining({
          toolName: "malformed_tool_call",
          replaySafe: executionStarted === false,
        }),
      ]);
    },
  );
});
