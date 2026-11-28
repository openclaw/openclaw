import { expect, it } from "vitest";
import type { Context } from "../../../llm/types.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import {
  createAssistant,
  holdAssistantResponse,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
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

it("saves the answer to steering that arrives while a compacted turn is resent in place", async () => {
  await withInterruptedTurn(
    true,
    async (fixture) => {
      // The compaction retry resends the persisted turn, as the runner prepares it.
      fixture.attempt.replayCurrentTranscript = true;
      fixture.attempt.suppressNextUserMessagePersistence = true;
      const followUp = createUserTurnTranscriptRecorder({
        target: { ...fixture.target, sessionEntry: undefined },
        input: { text: "Reply with EDGE-ALIVE-PINE", timestamp: 5, idempotencyKey: "next:user" },
      });
      await followUp.stageApproved!({ runId: fixture.attempt.runId, assertCurrent: () => {} });
      try {
        await withReplaySession(fixture, true, async (session, submit, sessionManager) => {
          const fixtureOperations: Promise<PromiseSettledResult<unknown>[]>[] = [];
          streamMocks.streamSimple
            .mockImplementationOnce(() => {
              const resumed = holdAssistantResponse("Resumed work finished.");
              fixtureOperations.push(
                Promise.allSettled([
                  session
                    .steer("Reply with EDGE-ALIVE-PINE", undefined, followUp)
                    .finally(resumed.release),
                ]),
              );
              return resumed.response;
            })
            .mockImplementation((model) => {
              const answer = holdAssistantResponse(() => createAssistant(model, "EDGE-ALIVE-PINE"));
              // The follow-up's ingress commits its row while the run answers it.
              fixtureOperations.push(
                Promise.allSettled([followUp.persistApproved().finally(answer.release)]),
              );
              return answer.response;
            });
          const submission = await Promise.allSettled([submit()]);
          const operations = (await Promise.all(fixtureOperations)).flat();
          for (const result of [...operations, ...submission]) {
            if (result.status === "rejected") {
              throw result.reason;
            }
          }
          expect(session.getLastAssistantText()).toBe("EDGE-ALIVE-PINE");
          const entries = (
            await SessionManager.openAsync(fixture.target, fixture.attempt.workspaceDir)
          ).getEntries();
          const followUpRows = entries.filter(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "user" &&
              JSON.stringify(entry.message.content).includes("EDGE-ALIVE-PINE"),
          );
          expect(followUpRows).toHaveLength(1);
          expect(entries.at(-1)).toMatchObject({
            parentId: followUpRows[0]!.id,
            message: { role: "assistant", content: [{ type: "text", text: "EDGE-ALIVE-PINE" }] },
          });
          expect(sessionManager.getLeafEntry()?.id).toBe(entries.at(-1)!.id);
        });
      } finally {
        followUp.finishPendingInput!("interrupted", "failed");
      }
    },
    { interruptedTurn: false, toolProgress: true, compactedInput: true, admittedReceipt: true },
  );
});
