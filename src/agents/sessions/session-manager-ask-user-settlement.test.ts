import path from "node:path";
import { afterAll, assert, beforeAll, expect, it } from "vitest";
import {
  loadTranscriptEvents,
  readTranscriptMutationAtSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { SqliteTranscriptMutationConflictError } from "../../config/sessions/session-mutation-conflict-error.js";
import { QuestionManager } from "../../gateway/question-manager.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createBasicAskUserArgs } from "../embedded-agent-subscribe.handlers.tools.ask-user.test-support.js";
import { installSessionToolResultGuard } from "../session-tool-result-guard.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { createAskUserTool } from "../tools/ask-user-tool.js";
import { persistAgentSessionMessage } from "./agent-session-transcript.js";
import { sessionScope } from "./session-manager-fixtures.test-support.js";
import { SessionManager } from "./session-manager.js";
import { interceptSessionMetadataWorker } from "./session-metadata-worker.test-support.js";

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "ask-user-settlement" });
});
afterAll(async () => {
  await state.cleanup();
});

for (const outcome of ["timeout", "answer"] as const) {
  it.each(["own-before", "own-in-flight", "foreign"] as const)(
    `${outcome} settlement after %s rewrite`,
    async (mutation) => {
      const sessionId = `${outcome}-${mutation}`;
      const target = sessionScope(
        path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
        sessionId,
      );
      await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
      const manager = await SessionManager.openAsync(target, state.workspaceDir);
      installSessionToolResultGuard(manager);
      const persist = (message: Parameters<typeof persistAgentSessionMessage>[1]) =>
        persistAgentSessionMessage(manager, message, { invalidateSerializedPrefixCache: false });
      const userId = await persist({ role: "user", content: "Which target?", timestamp: 1 });
      assert(userId);
      const args = createBasicAskUserArgs();
      args.questions[0]!.question = "Which target?";
      const call = makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "ask", name: "ask_user", arguments: args }],
        stopReason: "toolUse",
      });
      const callId = await persist(call);
      assert(callId);
      const before = readTranscriptMutationAtSync(target);
      assert(typeof before === "number");
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestGatewayScheduler(clock.clock);
      const questions = new QuestionManager(scheduler);
      const waiting = createDeferredCore();
      let questionId = "";
      const pending = createAskUserTool({
        sessionKey: target.sessionKey,
        gatewayCall: async (method, _options, params) => {
          if (method === "question.request") {
            const request = params as Parameters<QuestionManager["request"]>[0];
            expect(request.timeoutMs).toBe(900_000);
            questionId = questions.request(request).id;
            return { id: questionId };
          }
          if (method === "question.waitAnswer") {
            const answer = questions.waitAnswer(questionId);
            waiting.resolve();
            return answer;
          }
          throw new Error(`Unexpected question method: ${method}`);
        },
      }).execute("ask", args);
      const rewriteReady = createDeferredCore();
      const releaseRewrite = createDeferredCore();
      const blocker =
        mutation === "own-in-flight"
          ? interceptSessionMetadataWorker((worker) => ({
              execute: async (command, commandOptions) => {
                if (command.type === "session.transcript.rewrite") {
                  rewriteReady.resolve();
                  await releaseRewrite.promise;
                }
                return worker.execute(command, commandOptions);
              },
            }))
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
        commit = rewrite.commit(new Map([[callId, rewrittenId]])).then(
          () => undefined,
          (error: unknown) => error,
        );
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
        }).then(
          (entryId) => ({ entryId }),
          (error: unknown) => ({ error }),
        );
        releaseRewrite.resolve();
        expect(await commit).toBeUndefined();
        const settled = await settlement;
        const after = readTranscriptMutationAtSync(target);
        expect(after).toBeGreaterThan(before);
        const events = await loadTranscriptEvents(target);
        if (mutation === "foreign") {
          expect(settled).toEqual({ error: expect.any(SqliteTranscriptMutationConflictError) });
          expect(events).toEqual(foreignSnapshot);
        } else {
          expect(settled).toEqual({ entryId: expect.any(String) });
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
    },
  );
}
