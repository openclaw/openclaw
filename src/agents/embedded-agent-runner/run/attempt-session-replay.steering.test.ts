import { expect, it } from "vitest";
import type { Context } from "../../../llm/types.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import {
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { withInterruptedTurn, withReplaySession } from "./attempt-session-replay.test-support.js";
import { removeTrailingMidTurnPrecheckAssistantError } from "./attempt-transcript-helpers.js";
import { MidTurnPrecheckSignal } from "./midturn-precheck.js";

registerAgentSessionLoopTestLifecycle();

it("resumes the unfinished keyed turn across accepted steering without growing its prompt", async () => {
  await withInterruptedTurn(
    true,
    async (fixture) => {
      const steering = createUserTurnTranscriptRecorder({
        target: { ...fixture.target, sessionEntry: undefined },
        input: { text: "Also include the appendix", timestamp: 2, idempotencyKey: "steering:user" },
      });
      await steering.stageApproved!({ runId: fixture.attempt.runId, assertCurrent: () => {} });
      const requests: Context["messages"][] = [];
      streamMocks.streamSimple.mockImplementation((_model, context) => {
        requests.push(structuredClone(context.messages));
        throw new MidTurnPrecheckSignal({
          pressure: "overflow",
          route: "truncate_tool_results_only",
          estimatedPromptTokens: 932_476,
          promptBudgetBeforeReserve: 922_000,
          overflowTokens: 10_476,
          toolResultReducibleChars: 396_955,
          effectiveReserveTokens: 78_000,
        });
      });
      try {
        for (let retry = 0; retry < 3; retry++) {
          fixture.attempt.replayCurrentTranscript = retry > 0 ? true : undefined;
          await withReplaySession(fixture, true, async (session, submit, sessionManager) => {
            if (retry === 0) {
              await session.steer("Also include the appendix", undefined, steering);
            }
            await submit();
            // The ingress has handed off this persisted steer; it no longer owns
            // a separate live pending request when recovery opens the next attempt.
            steering.releasePendingInput!();
            await removeTrailingMidTurnPrecheckAssistantError({
              activeSession: session,
              sessionManager,
            });
            expect(
              sessionManager
                .buildSessionContext()
                .messages.filter((message) => message.role === "user"),
            ).toHaveLength(2);
          });
        }
        expect(steering.hasPersisted()).toBe(true);
        expect(requests).toHaveLength(3);
        expect(requests[1]).toEqual(requests[0]);
        expect(requests[2]).toEqual(requests[0]);
        expect(JSON.stringify(requests[2])).toContain("Also include the appendix");
        expect(JSON.stringify(requests[2])).toContain("Already read: use this completed result");
      } finally {
        steering.finishPendingInput!("interrupted", "failed");
      }
    },
    { interruptedTurn: false, toolProgress: true },
  );
});
