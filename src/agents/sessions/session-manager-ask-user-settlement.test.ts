import { assert, expect, it, vi } from "vitest";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { SqliteTranscriptMutationConflictError } from "../../config/sessions/session-mutation-conflict-error.js";
import { QuestionManager } from "../../gateway/question-manager.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import type { AgentHarnessQuestionGatewayCall as GatewayCall } from "../harness/gateway-question-dispatch.js";
import { installSessionToolResultGuard } from "../session-tool-result-guard.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { createAskUserTool } from "../tools/ask-user-tool.js";
import { persistAgentSessionMessage } from "./agent-session-transcript.js";
import { withSessionState } from "./session-manager-fixtures.test-support.js";
import * as metadataRuntime from "./session-manager-metadata-runtime.js";
import { SessionManager } from "./session-manager.js";

for (const outcome of ["timeout", "answer"] as const) {
  it.each(["own-before", "own-in-flight", "foreign"] as const)(
    `${outcome} settlement after %s rewrite`,
    (mutation) =>
      withSessionState(`${outcome}-${mutation}`, async ({ state, scope: target }) => {
        const manager = await SessionManager.openAsync(target, state.workspaceDir);
        installSessionToolResultGuard(manager);
        const persist = (message: Parameters<typeof persistAgentSessionMessage>[1]) =>
          persistAgentSessionMessage(manager, message, { invalidateSerializedPrefixCache: false });
        const userId = await persist({ role: "user", content: "Which target?", timestamp: 1 });
        assert(userId);
        const question = { id: "target", header: "Target", question: "Which target?" };
        const options = [{ label: "Staging" }, { label: "Production" }];
        const args = { questions: [{ ...question, options }] };
        const call = makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: "ask", name: "ask_user", arguments: args }],
          stopReason: "toolUse",
        });
        const callId = await persist(call);
        assert(callId);
        const clock = createGatewaySchedulerClock(Date.now());
        const scheduler = createTestGatewayScheduler(clock.clock);
        const questions = new QuestionManager(scheduler);
        const waiting = createDeferredCore();
        let questionId = "";
        const gatewayCall: GatewayCall = async (method, _options, params) => {
          if (method === "question.request") {
            questionId = questions.request(params as Parameters<QuestionManager["request"]>[0]).id;
            return { id: questionId };
          }
          if (method === "question.waitAnswer") {
            const answer = questions.waitAnswer(questionId);
            waiting.resolve();
            return answer;
          }
          throw new Error(`Unexpected question method: ${method}`);
        };
        const tool = createAskUserTool({ sessionKey: target.sessionKey, gatewayCall });
        const pending = tool.execute("ask", args);
        const rewriteReady = createDeferredCore();
        const releaseRewrite = createDeferredCore();
        const withWorker = metadataRuntime.withSessionMetadataWorker;
        const blocker =
          mutation === "own-in-flight"
            ? vi
                .spyOn(metadataRuntime, "withSessionMetadataWorker")
                .mockImplementation((...workerArgs) => {
                  const operation = workerArgs[3];
                  workerArgs[3] = (worker) =>
                    operation({
                      execute: async (command, commandOptions) => {
                        if (command.type === "session.transcript.rewrite") {
                          rewriteReady.resolve();
                          await releaseRewrite.promise;
                        }
                        return worker.execute(command, commandOptions);
                      },
                    });
                  return withWorker(...workerArgs);
                })
            : undefined;
        let commit: Promise<unknown> | undefined;
        let settlement: Promise<unknown> | undefined;
        try {
          await waiting.promise;
          expect(questions.get(questionId)?.status).toBe("pending");
          const owner =
            mutation === "foreign"
              ? await SessionManager.openAsync(target, state.workspaceDir)
              : manager;
          const rewrite = await owner.prepareTranscriptRewriteAsync();
          await rewrite.sessionManager.branchAsync(userId);
          const rewrittenId = await rewrite.sessionManager.appendMessageAsync({
            ...call,
            content: [...call.content, { type: "text", text: "Rewritten assistant context" }],
          });
          assert(rewrittenId);
          // Keep the admitted user and tool-call identity; only the assistant entry is rewritten.
          commit = rewrite
            .commit(new Map([[callId, rewrittenId]]))
            .catch((error: unknown) => error);
          if (mutation === "own-in-flight") {
            await rewriteReady.promise;
          } else {
            expect(await commit).toBeUndefined();
          }
          const foreignSnapshot =
            mutation === "foreign" ? await loadTranscriptEvents(target) : undefined;
          if (outcome === "timeout") {
            await clock.advanceBy(900_000);
            expect(questions.get(questionId)?.status).toBe("expired");
          } else {
            questions.resolve(questionId, { answers: { target: ["Staging"] } });
          }
          const result = await pending;
          const details =
            outcome === "timeout"
              ? { status: "no_answer" }
              : { status: "answered", answers: { answers: { target: ["Staging"] } } };
          expect(result.details).toEqual(details);
          settlement = persist({
            role: "toolResult",
            toolCallId: "ask",
            toolName: "ask_user",
            content: result.content,
            details: result.details,
            isError: false,
            timestamp: 3,
          }).catch((error: unknown) => error);
          releaseRewrite.resolve();
          expect(await commit).toBeUndefined();
          const settled = await settlement;
          const events = await loadTranscriptEvents(target);
          if (mutation === "foreign") {
            expect(settled).toBeInstanceOf(SqliteTranscriptMutationConflictError);
            expect(events).toEqual(foreignSnapshot);
          } else {
            expect(settled).toBeTypeOf("string");
            expect(events.at(-1)).toMatchObject({
              parentId: rewrittenId,
              message: { role: "toolResult", toolCallId: "ask", toolName: "ask_user", details },
            });
            expect(manager.getPersistedEntries()).toEqual(events);
          }
        } finally {
          releaseRewrite.resolve();
          questions.close();
          await Promise.allSettled([pending, commit, settlement]);
          blocker?.mockRestore();
          await questions.drain();
          await scheduler.stop();
        }
      }),
  );
}
