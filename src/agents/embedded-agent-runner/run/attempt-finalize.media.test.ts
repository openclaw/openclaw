import { describe, expect, it, vi } from "vitest";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
} from "../../test-helpers/agent-message-fixtures.js";
import { finalizeEmbeddedAttempt } from "./attempt-finalize.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

describe("finalizeEmbeddedAttempt trajectory capture", () => {
  type AssistantStopReason = NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>["stopReason"];

  const assistant = (stopReason: AssistantStopReason) =>
    makeAgentAssistantMessage({
      stopReason,
      content: [{ type: "text", text: "attempt fallback" }],
      ...(stopReason === "error" ? { errorMessage: "provider failed" } : {}),
    });

  const captureTrajectory = (overrides: Partial<EmbeddedRunAttemptResult>) => {
    const recordEvent = vi.fn();
    const result = {
      terminal: { kind: "ok" },
      assistantTexts: [],
      toolMetas: [],
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      currentAttemptAssistant: assistant("stop"),
      ...overrides,
    } as EmbeddedRunAttemptResult;
    finalizeEmbeddedAttempt({
      result,
      trajectoryRecorder: { recordEvent, flush: async () => undefined },
      synthesizedPayloadCount: 0,
      emptyAssistantReplyIsSilent: false,
      hasTerminalOutput: false,
    });
    return Object.fromEntries(recordEvent.mock.calls) as Record<string, Record<string, unknown>>;
  };

  type TerminalCase = {
    input: Partial<EmbeddedRunAttemptResult>;
    stop: string | undefined;
    status: "success" | "error" | "interrupted";
  };
  const externalAbort = { kind: "aborted", source: "external" } as const;
  const yieldAbort = { kind: "aborted", source: "yield_cleanup" } as const;
  const failure = { source: "prompt", error: new Error("prompt failed") } as const;
  const yielded = {
    lastAssistant: assistant("aborted"),
    currentAttemptCompletedAssistant: assistant("stop"),
    yieldDetected: true,
  };
  const timeout = { kind: "timeout", phase: "prompt", source: "runtime" } as const;

  it.each`
    name                                     | input                                                                                                    | stop          | status
    ${"current over stale"}                  | ${{ lastAssistant: assistant("aborted") }}                                                               | ${"stop"}     | ${"success"}
    ${"normal completion"}                   | ${{ currentAttemptAssistant: assistant("length"), currentAttemptCompletedAssistant: assistant("stop") }} | ${"stop"}     | ${"success"}
    ${"length truncation with visible text"} | ${{ currentAttemptAssistant: assistant("length") }}                                                      | ${"length"}   | ${"success"}
    ${"yield plus prompt timeout"}           | ${{ ...yielded, terminal: timeout }}                                                                     | ${undefined}  | ${"interrupted"}
    ${"yield plus external abort"}           | ${{ ...yielded, terminal: externalAbort }}                                                               | ${"aborted"}  | ${"interrupted"}
    ${"external abort over prompt failure"}  | ${{ terminal: { ...externalAbort, failure } }}                                                           | ${"aborted"}  | ${"interrupted"}
    ${"partial provider error"}              | ${{ currentAttemptAssistant: assistant("error"), assistantTexts: ["x"] }}                                | ${"error"}    | ${"error"}
    ${"yield cleanup plus prompt failure"}   | ${{ ...yielded, terminal: { ...yieldAbort, failure }, currentAttemptAssistant: assistant("error") }}     | ${undefined}  | ${"error"}
    ${"yield over completed assistant"}      | ${{ ...yielded, terminal: yieldAbort, currentAttemptAssistant: assistant("length") }}                    | ${"end_turn"} | ${"success"}
  `("$name", ({ input, stop, status }: TerminalCase) => {
    const events = captureTrajectory({ lastAssistant: assistant("toolUse"), ...input });
    for (const name of ["model.completed", "trace.artifacts", "session.ended"]) {
      expect(events[name]).toHaveProperty("stopReason", stop);
    }
    expect(events["trace.artifacts"]).toHaveProperty("finalStatus", status);
  });

  it.each`
    name                       | input                                                                                                                                                                                    | delivered
    ${"tool metadata only"}    | ${{ currentAttemptAssistant: assistant("toolUse"), toolMetas: [{ toolName: "read" }] }}                                                                                                  | ${false}
    ${"accepted spawn"}        | ${{ currentAttemptAssistant: assistant("toolUse"), toolMetas: [{ toolName: "read" }], acceptedSessionSpawns: [{ runId: "run-child", childSessionKey: "agent:claude:subagent:child" }] }} | ${true}
    ${"unconsumed tool error"} | ${{ currentAttemptAssistant: undefined, lastToolError: { toolName: "bash", error: "Execution denied.", executionStarted: false } }}                                                      | ${false}
    ${"answered tool error"}   | ${{ lastToolError: { toolName: "bash", error: "Execution denied.", executionStarted: false } }}                                                                                          | ${true}
  `(
    "requires durable progress: $name",
    ({ input, delivered }: { input: Partial<EmbeddedRunAttemptResult>; delivered: boolean }) => {
      const events = captureTrajectory(input);
      expect(events["trace.artifacts"]).toHaveProperty(
        "finalStatus",
        delivered ? "success" : "error",
      );
      expect(events["session.ended"]).toMatchObject({
        status: delivered ? "success" : "error",
        terminalError: delivered ? undefined : "non_deliverable_terminal_turn",
      });
    },
  );

  it("records canonical message snapshots without reprojecting them", () => {
    const media = [{ path: "/media/canonical.png", contentType: "image/png" }];
    const message = castAgentMessage({ role: "user", content: "inspect", __openclaw: { media } });
    const expected = structuredClone(message);
    const events = captureTrajectory({ messagesSnapshot: [message] });
    expect(events["model.completed"]?.messagesSnapshot).toEqual([expected]);
  });
});
