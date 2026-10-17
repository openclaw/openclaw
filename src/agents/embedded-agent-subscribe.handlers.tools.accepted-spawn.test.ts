import { describe, expect, it } from "vitest";
import {
  hasUncollectedSessionSpawn,
  mergeAcceptedSessionSpawnsForRun,
} from "./accepted-session-spawn.js";
import { createOperationalRunInstanceRef } from "./admitted-run-context.js";
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

describe("handleToolExecutionEnd agents_wait collector settlement", () => {
  it("marks only collectors that agents_wait returned as done", async () => {
    const { ctx } = createTestContext();
    for (const runId of ["run-done", "run-failed", "run-pending"]) {
      await endTool(ctx, {
        toolName: "sessions_spawn",
        toolCallId: `spawn-${runId}`,
        result: resultWithDetails({
          status: "accepted",
          runId,
          childSessionKey: `agent:main:subagent:${runId}`,
          expectsCompletionMessage: false,
        }),
      });
    }

    await endTool(ctx, {
      toolName: "agents_wait",
      toolCallId: "wait-collectors",
      result: resultWithDetails({
        completed: [
          { runId: "run-done", status: "done", result: "ok", sessionKey: "agent:main:subagent:a" },
          {
            runId: "run-failed",
            status: "failed",
            result: "",
            sessionKey: "agent:main:subagent:b",
          },
        ],
        pending: ["run-pending"],
      }),
    });
    await endTool(ctx, {
      toolName: "agents_wait",
      toolCallId: "wait-error",
      isError: true,
      result: resultWithDetails({
        completed: [
          { runId: "run-pending", status: "done", result: "", sessionKey: "agent:main:subagent:c" },
        ],
        pending: [],
      }),
    });

    expect(
      ctx.state.acceptedSessionSpawns.map(({ runId, collected }) => ({ runId, collected })),
    ).toEqual([
      { runId: "run-done", collected: true },
      { runId: "run-failed", collected: undefined },
      { runId: "run-pending", collected: undefined },
    ]);
  });

  it("marks a collector accepted by an earlier attempt of the same run", async () => {
    const operationalRunInstance = createOperationalRunInstanceRef("parent-run");
    const spawning = createTestContext().ctx;
    spawning.params.operationalRunInstance = operationalRunInstance;
    await endTool(spawning, {
      toolName: "sessions_spawn",
      toolCallId: "spawn-collector",
      result: resultWithDetails({
        status: "accepted",
        runId: "run-collector",
        childSessionKey: "agent:main:subagent:collector",
        expectsCompletionMessage: false,
      }),
    });
    mergeAcceptedSessionSpawnsForRun(operationalRunInstance, spawning.state.acceptedSessionSpawns);

    const collecting = createTestContext().ctx;
    collecting.params.operationalRunInstance = operationalRunInstance;
    await endTool(collecting, {
      toolName: "agents_wait",
      toolCallId: "wait-collector",
      result: resultWithDetails({
        completed: [{ runId: "run-collector", status: "done", result: "ok" }],
        pending: [],
      }),
    });

    expect(
      hasUncollectedSessionSpawn(
        mergeAcceptedSessionSpawnsForRun(
          operationalRunInstance,
          collecting.state.acceptedSessionSpawns,
        ),
      ),
    ).toBe(false);
  });
});
