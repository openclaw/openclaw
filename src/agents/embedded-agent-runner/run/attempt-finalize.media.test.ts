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

  type TerminalCaseOptions = {
    texts?: string[];
    last?: AssistantStopReason;
    completed?: AssistantStopReason;
    yielded?: boolean;
  };
  type TerminalCase = {
    name: string;
    terminal: EmbeddedRunAttemptResult["terminal"];
    currentStopReason: AssistantStopReason;
    expectedStopReason: string | undefined;
    expectedFinalStatus: "success" | "error" | "interrupted";
    options: TerminalCaseOptions;
  };
  const ok = { kind: "ok" } as const;
  const externalAbort = { kind: "aborted", source: "external" } as const;
  const yieldAbort = { kind: "aborted", source: "yield_cleanup" } as const;
  const failure = { source: "prompt", error: new Error("prompt failed") } as const;
  const yielded = { last: "aborted", completed: "stop", yielded: true } as const;
  const timeout = { kind: "timeout", phase: "prompt", source: "runtime" } as const;

  it.each`
    name                                     | terminal                         | currentStopReason | expectedStopReason | expectedFinalStatus | options
    ${"current over stale"}                  | ${ok}                            | ${"stop"}         | ${"stop"}          | ${"success"}        | ${{ last: "aborted" }}
    ${"normal completion"}                   | ${ok}                            | ${"length"}       | ${"stop"}          | ${"success"}        | ${{ completed: "stop" }}
    ${"length truncation with visible text"} | ${ok}                            | ${"length"}       | ${"length"}        | ${"success"}        | ${{}}
    ${"yield plus prompt timeout"}           | ${timeout}                       | ${"stop"}         | ${undefined}       | ${"interrupted"}    | ${yielded}
    ${"yield plus external abort"}           | ${externalAbort}                 | ${"stop"}         | ${"aborted"}       | ${"interrupted"}    | ${yielded}
    ${"external abort over prompt failure"}  | ${{ ...externalAbort, failure }} | ${"stop"}         | ${"aborted"}       | ${"interrupted"}    | ${{}}
    ${"partial provider error"}              | ${ok}                            | ${"error"}        | ${"error"}         | ${"error"}          | ${{ texts: ["x"] }}
    ${"yield cleanup plus prompt failure"}   | ${{ ...yieldAbort, failure }}    | ${"error"}        | ${undefined}       | ${"error"}          | ${yielded}
    ${"yield over completed assistant"}      | ${yieldAbort}                    | ${"length"}       | ${"end_turn"}      | ${"success"}        | ${yielded}
  `(
    "$name",
    ({
      terminal,
      currentStopReason,
      expectedStopReason,
      expectedFinalStatus,
      options,
    }: TerminalCase) => {
      const events = captureTrajectory({
        terminal,
        assistantTexts: options.texts ?? [],
        lastAssistant: assistant(options.last ?? "toolUse"),
        currentAttemptAssistant: assistant(currentStopReason),
        currentAttemptCompletedAssistant: options.completed
          ? assistant(options.completed)
          : undefined,
        yieldDetected: options.yielded,
      });

      for (const name of ["model.completed", "trace.artifacts", "session.ended"]) {
        expect(events[name]).toHaveProperty("stopReason", expectedStopReason);
      }
      expect(events["trace.artifacts"]).toHaveProperty("finalStatus", expectedFinalStatus);
    },
  );

  it.each([false, true])(
    "requires durable progress rather than tool metadata (accepted spawn=%s)",
    (spawned) => {
      const events = captureTrajectory({
        currentAttemptAssistant: assistant("toolUse"),
        toolMetas: [{ toolName: "read" }],
        acceptedSessionSpawns: spawned
          ? [{ runId: "run-child", childSessionKey: "agent:claude:subagent:child" }]
          : undefined,
      });
      expect(events["trace.artifacts"]).toHaveProperty(
        "finalStatus",
        spawned ? "success" : "error",
      );
      expect(events["session.ended"]).toMatchObject({
        status: spawned ? "success" : "error",
        terminalError: spawned ? undefined : "non_deliverable_terminal_turn",
      });
    },
  );

  it("records canonical message snapshots without reprojecting them", () => {
    const media = [{ path: "/media/canonical.png", contentType: "image/png" }];
    const message = castAgentMessage({ role: "user", content: "inspect", __openclaw: { media } });
    const events = captureTrajectory({
      messagesSnapshot: [message],
    });
    const captured = (
      events["model.completed"]?.messagesSnapshot as Array<Record<string, unknown>> | undefined
    )?.[0];

    expect(captured).not.toHaveProperty("MediaPath");
    expect(captured).not.toHaveProperty("MediaType");
    expect(captured?.["__openclaw"]).toMatchObject({
      media: [{ path: "/media/canonical.png", contentType: "image/png" }],
    });
  });
});
