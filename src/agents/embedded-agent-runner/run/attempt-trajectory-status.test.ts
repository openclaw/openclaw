// Coverage for terminal attempt trajectory status classification.
import { describe, expect, it } from "vitest";
import {
  resolveAttemptTrajectoryTerminal,
  resolveTerminalAssistantTexts,
} from "./attempt-trajectory-status.js";

const NON_DELIVERABLE_TERMINAL_TURN_REASON = "non_deliverable_terminal_turn";

type ResolveAttemptTrajectoryTerminalParams = Parameters<
  typeof resolveAttemptTrajectoryTerminal
>[0];

function baseParams(
  overrides: Partial<ResolveAttemptTrajectoryTerminalParams> = {},
): ResolveAttemptTrajectoryTerminalParams {
  // Default to a completed but non-deliverable attempt; tests opt in to each
  // kind of terminal progress.
  return {
    failed: false,
    interrupted: false,
    assistantTexts: [],
    toolMetas: [],
    didSendViaMessagingTool: false,
    didSendDeterministicApprovalPrompt: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    successfulCronAdds: 0,
    synthesizedPayloadCount: 0,
    ...overrides,
  };
}

describe("attempt trajectory status", () => {
  it("records length-limited visible text as success with no synthesized payload", () => {
    // The headline case: an ordinary text-only truncated reply. Finalization runs
    // before terminal preparation converts assistant text into payloads, so
    // synthesizedPayloadCount is still 0 here while the reply is delivered. The
    // durable record must not contradict that.
    expect(
      resolveAttemptTrajectoryTerminal(
        baseParams({
          assistantTexts: ["Partial answer."],
          synthesizedPayloadCount: 0,
          lastAssistantStopReason: "length",
        }),
      ),
    ).toEqual({ status: "success" });
  });

  it("keeps accepted session spawns as terminal progress", () => {
    expect(
      resolveAttemptTrajectoryTerminal(
        baseParams({
          acceptedSessionSpawns: [
            {
              runId: "run-child",
              childSessionKey: "agent:claude:subagent:child",
            },
          ],
          lastAssistantStopReason: "toolUse",
        }),
      ),
    ).toEqual({ status: "success" });
  });

  it("does not treat tool metadata alone as terminal progress", () => {
    expect(
      resolveAttemptTrajectoryTerminal(
        baseParams({
          toolMetas: [{ toolName: "read" }],
        }),
      ),
    ).toEqual({
      status: "error",
      terminalError: NON_DELIVERABLE_TERMINAL_TURN_REASON,
    });
  });

  it("uses safe last-assistant fallback text for terminal delivery status", () => {
    expect(
      resolveTerminalAssistantTexts({
        assistantTexts: [],
        lastAssistantStopReason: "stop",
        lastAssistantVisibleText: "Fallback answer.",
      }),
    ).toEqual(["Fallback answer."]);
    expect(
      resolveTerminalAssistantTexts({
        assistantTexts: [],
        lastAssistantStopReason: "error",
        lastAssistantVisibleText: "Raw provider error",
      }),
    ).toEqual([]);
  });

  it("preserves prompt errors and interrupts", () => {
    expect(resolveAttemptTrajectoryTerminal(baseParams({ failed: true }))).toEqual({
      status: "error",
    });
    expect(resolveAttemptTrajectoryTerminal(baseParams({ interrupted: true }))).toEqual({
      status: "interrupted",
    });
    expect(
      resolveAttemptTrajectoryTerminal(baseParams({ failed: true, interrupted: true })),
    ).toEqual({
      status: "interrupted",
    });
  });
});
