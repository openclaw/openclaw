import path from "node:path";
import { afterAll, assert, beforeAll, expect, it, vi } from "vitest";
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
import { installSessionToolResultGuard } from "../session-tool-result-guard.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { createAskUserTool } from "../tools/ask-user-tool.js";
import { persistAgentSessionMessage } from "./agent-session-transcript.js";
import * as metadataRuntime from "./session-manager-metadata-runtime.js";
import { SessionManager } from "./session-manager.js";

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
      const target = {
        agentId: "main",
        sessionId,
        sessionKey: `agent:main:${sessionId}`,
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
      const manager = await SessionManager.openAsync(target, state.workspaceDir);
      installSessionToolResultGuard(manager);
      const persist = (message: Parameters<typeof persistAgentSessionMessage>[1]) =>
        persistAgentSessionMessage(manager, message, { invalidateSerializedPrefixCache: false });
      const userId = await persist({ role: "user", content: "Which target?", timestamp: 1 });
      assert(userId);
      const args = {
        questions: [
          {
            id: "target",
            header: "Target",
            question: "Which target?",
            options: [{ label: "Staging" }, { label: "Production" }],
          },
        ],
      };
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
      type GatewayCall = Extract<
        NonNullable<Parameters<typeof createAskUserTool>[0]["gatewayCall"]>,
        (...args: never[]) => unknown
      >;
      const gatewayCall = (async (
        method: string,
        _options: unknown,
        params: Record<string, unknown>,
      ) => {
        if (method === "question.request") {
          expect(params.timeoutMs).toBe(900_000);
          questionId = questions.request(params as Parameters<QuestionManager["request"]>[0]).id;
          return { id: questionId };
        }
        if (method === "question.waitAnswer") {
          const answer = questions.waitAnswer(questionId);
          waiting.resolve();
          return answer;
        }
        throw new Error(`Unexpected question method: ${method}`);
      }) as GatewayCall;
      const pending = createAskUserTool({ sessionKey: target.sessionKey, gatewayCall }).execute(
        "ask",
        args,
      );
      const rewriteReady = createDeferredCore();
      const releaseRewrite = createDeferredCore();
      const withWorker = metadataRuntime.withSessionMetadataWorker;
      const blocker =
        mutation === "own-in-flight"
          ? vi
              .spyOn(metadataRuntime, "withSessionMetadataWorker")
              .mockImplementation((options, database, assertCurrent, operation, controls) =>
                withWorker(
                  options,
                  database,
                  assertCurrent,
                  (worker) =>
                    operation({
                      execute: async (command, commandOptions) => {
                        if (command.type === "session.transcript.rewrite") {
                          rewriteReady.resolve();
                          await releaseRewrite.promise;
                        }
                        return worker.execute(command, commandOptions);
                      },
                    }),
                  controls,
                ),
              )
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
