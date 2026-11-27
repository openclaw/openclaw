import { describe, expect, it } from "vitest";
import {
  createTestContext,
  endTool,
  resultWithDetails,
} from "./embedded-agent-subscribe.handlers.tools.test-support.js";

describe("handleToolExecutionEnd sessions_spawn terminal success tracking", () => {
  it.each([
    { name: "hidden", presentation: {}, expected: {} },
    {
      name: "visible",
      presentation: { sessionUrl: " https://openclaw.example/chat/main/work ", label: " Review " },
      expected: { sessionUrl: "https://openclaw.example/chat/main/work", label: "Review" },
    },
    {
      name: "invalid URL",
      presentation: { sessionUrl: "javascript:alert(1)", label: " " },
      expected: {},
    },
  ])(
    "records accepted $name sessions_spawn completion ownership",
    async ({ presentation, expected }) => {
      const { ctx } = createTestContext();

      await endTool(ctx, {
        toolName: "sessions_spawn",
        toolCallId: "tool-spawn-accepted",
        result: resultWithDetails({
          status: "accepted",
          runId: " run-child ",
          childSessionKey: " agent:claude:subagent:child ",
          expectsCompletionMessage: true,
          ...presentation,
        }),
      });

      await endTool(ctx, {
        toolName: "sessions_spawn",
        toolCallId: "spawn-error",
        result: resultWithDetails({
          status: "error",
          runId: "run-child",
          childSessionKey: "agent:claude:subagent:child",
        }),
      });
      await endTool(ctx, {
        toolName: "sessions_spawn",
        toolCallId: "spawn-malformed",
        result: { details: { status: "accepted", runId: "run-child", childSessionKey: " " } },
      });

      expect(ctx.state.acceptedSessionSpawns).toEqual([
        {
          runId: "run-child",
          childSessionKey: "agent:claude:subagent:child",
          expectsCompletionMessage: true,
          ...expected,
        },
      ]);
      expect(ctx.state.replayState).toEqual({
        replayInvalid: true,
        hadPotentialSideEffects: true,
      });
    },
  );
});
