/**
 * Integration test proving that sessions_yield produces a clean end_turn exit
 * with no pending tool calls, so the parent session is idle when subagent
 * results arrive.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
} from "./run.overflow-compaction.harness.js";
import { isEmbeddedPiRunActive, queueEmbeddedPiMessage } from "./runs.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

type AttemptResultWithCompletionTruth = ReturnType<typeof makeAttemptResult> & {
  completionTruth?: Record<string, unknown>;
  completionTruthSelection?: Record<string, unknown>;
};

function makeAttemptResultWithCompletionTruth(
  overrides: Parameters<typeof makeAttemptResult>[0] & {
    completionTruth?: Record<string, unknown>;
    completionTruthSelection?: Record<string, unknown>;
  },
): AttemptResultWithCompletionTruth {
  return makeAttemptResult(
    overrides as Parameters<typeof makeAttemptResult>[0],
  ) as AttemptResultWithCompletionTruth;
}

describe("sessions_yield orchestration", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    mockedRunEmbeddedAttempt.mockReset();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  it("parent session is idle after yield — end_turn, no pendingToolCalls", async () => {
    const sessionId = "yield-parent-session";

    // Simulate an attempt where sessions_yield was called
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: null,
        sessionIdUsed: sessionId,
        yieldDetected: true,
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      sessionId,
      runId: "run-yield-orchestration",
    });

    // 1. Run completed with end_turn (yield causes clean exit)
    expect(result.meta.stopReason).toBe("end_turn");

    // 2. No pending tool calls (yield is NOT a client tool call)
    expect(result.meta.pendingToolCalls).toBeUndefined();

    // 3. Parent session is IDLE (not in ACTIVE_EMBEDDED_RUNS)
    expect(isEmbeddedPiRunActive(sessionId)).toBe(false);

    // 4. Steer would fail (message delivery must take direct path, not steer)
    expect(queueEmbeddedPiMessage(sessionId, "subagent result")).toBe(false);
  });

  it("propagates resolved completion truth into run completion meta", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResultWithCompletionTruth({
        promptError: null,
        yieldDetected: true,
        completionTruth: {
          source: "sessions_yield",
          status: "yielded",
          message: "Waiting for worker",
          sessionId: "yield-truth-session",
          toolCallId: "call-1",
        },
        completionTruthSelection: {
          source: "toolResult",
          confidence: "high",
          notes: ["selected explicit tool result"],
        },
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      sessionId: "yield-truth-session",
      runId: "run-yield-completion-truth",
    });

    expect(result.meta.completion).toMatchObject({
      stopReason: "end_turn",
      truth: {
        source: "sessions_yield",
        status: "yielded",
        message: "Waiting for worker",
      },
      truthSelection: {
        source: "toolResult",
        confidence: "high",
      },
    });
    expect(result.meta.completion?.truth).not.toHaveProperty("sessionId");
    expect(result.meta.completion?.truth).not.toHaveProperty("toolCallId");
  });

  it("propagates realtimeHint completion truth fallback into run completion meta", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResultWithCompletionTruth({
        promptError: null,
        yieldDetected: true,
        completionTruth: {
          source: "sessions_yield",
          status: "yielded",
          message: "fallback realtime hint",
          sessionId: "yield-realtime-hint-session",
          toolCallId: "unknown",
        },
        completionTruthSelection: {
          source: "realtimeHint",
          confidence: "low",
          notes: ["selected realtime hint fallback"],
        },
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      sessionId: "yield-realtime-hint-session",
      runId: "run-yield-completion-truth-realtime-hint",
    });

    expect(result.meta.completion).toMatchObject({
      stopReason: "end_turn",
      truth: {
        source: "sessions_yield",
        status: "yielded",
        message: "fallback realtime hint",
      },
      truthSelection: {
        source: "realtimeHint",
        confidence: "low",
      },
    });
  });

  it("clientToolCall takes precedence over yieldDetected", async () => {
    // Edge case: both flags set (shouldn't happen, but clientToolCall wins)
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: null,
        yieldDetected: true,
        clientToolCalls: [{ name: "hosted_tool", params: { arg: "value" } }],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-yield-vs-client-tool",
    });

    // clientToolCalls wins — tool_calls stopReason, pendingToolCalls populated
    expect(result.meta.stopReason).toBe("tool_calls");
    expect(result.meta.pendingToolCalls).toHaveLength(1);
    expect(result.meta.pendingToolCalls![0].name).toBe("hosted_tool");
  });

  it("preserves order across multiple client tool calls in one attempt (#52288)", async () => {
    // Regression: a turn that invokes three client tools must surface all
    // three through `pendingToolCalls`, in the order the LLM emitted them.
    // Pre-fix this slot was a single variable that only kept the last call.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: null,
        clientToolCalls: [
          { name: "create_graph", params: { nodes: ["a", "b"] } },
          { name: "activate_graph", params: {} },
          { name: "get_status", params: {} },
        ],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-multi-client-tool",
    });

    expect(result.meta.stopReason).toBe("tool_calls");
    expect(result.meta.pendingToolCalls).toHaveLength(3);
    expect(result.meta.pendingToolCalls!.map((c) => c.name)).toEqual([
      "create_graph",
      "activate_graph",
      "get_status",
    ]);
    expect(JSON.parse(result.meta.pendingToolCalls![0].arguments)).toEqual({
      nodes: ["a", "b"],
    });
  });

  it("normal attempt without yield has no stopReason override", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-no-yield",
    });

    // Neither clientToolCall nor yieldDetected → stopReason is undefined
    expect(result.meta.stopReason).toBeUndefined();
    expect(result.meta.pendingToolCalls).toBeUndefined();
  });
});
