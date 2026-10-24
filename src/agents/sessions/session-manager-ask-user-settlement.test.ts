import path from "node:path";
import { afterAll, assert, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  loadTranscriptEvents,
  readTranscriptMutationAtSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { SqliteTranscriptMutationConflictError } from "../../config/sessions/session-mutation-conflict-error.js";
import { QuestionManager } from "../../gateway/question-manager.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as questionDispatch from "../harness/gateway-question-dispatch.js";
import type { AgentHarnessQuestionGatewayCall as GatewayCall } from "../harness/gateway-question-dispatch.js";
import { claimPendingAgentQuestionAnswer } from "../harness/gateway-question.js";
import { createAdmittedHostCapabilityTestFixture } from "../harness/host-capability.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "../harness/tool-authority.runtime.js";
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
      const dispatch = questionDispatch.resolveAgentQuestionGatewayCall(gatewayCall);
      const gatewaySpy = vi
        .spyOn(questionDispatch, "resolveAgentQuestionGatewayCall")
        .mockReturnValue(dispatch);
      onTestFinished(() => gatewaySpy.mockRestore());
      const pending = createAskUserTool({ sessionKey: target.sessionKey }).execute("ask", args);
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

// #174994: a plain-text answer appended by the ingress path (a different manager,
// bypassing the blocked run's tool-result guard) while ask_user is armed must not
// kill the settlement. The settlement runs inside the blocked run's
// production tool-authority wrapper; the ingress claim admits the
// answer into that custody after persistApproved(). The blocked run's toolResult
// append holds a stale prepared parent; it must re-base onto the new tail and
// succeed.
it.each(["answer", "unrelated-user"] as const)(
  "guards concurrent inbound answer settlement through the production owner: %s (#174994)",
  async (scenario) => {
    const sessionId = `concurrent-append-${scenario}`;
    const target = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    const recorderTarget = {
      agentId: "main",
      sessionId,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
      sessionEntry: undefined,
      cwd: state.workspaceDir,
    };
    await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(target, state.workspaceDir);
    installSessionToolResultGuard(manager);
    const persist = (message: Parameters<typeof persistAgentSessionMessage>[1]) =>
      persistAgentSessionMessage(manager, message, { invalidateSerializedPrefixCache: false });
    // The blocked run's original user turn is a real admitted recorder.
    const creator = createUserTurnTranscriptRecorder({
      target: recorderTarget,
      input: { text: "Which target?", idempotencyKey: "creator:user" },
    });
    const creatorResult = await creator.persistApproved();
    assert(creatorResult);
    await manager.reloadPersistedTranscriptAsync();
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
      if (method === "question.resolve") {
        return questions.resolve(
          params.id as string,
          params.answers as Parameters<QuestionManager["resolve"]>[1],
          params.resolvedBy as string | undefined,
          { resolutionId: params.resolutionId as string | undefined },
        );
      }
      throw new Error(`Unexpected question method: ${method}`);
    }) as GatewayCall;
    const dispatch = questionDispatch.resolveAgentQuestionGatewayCall(gatewayCall);
    const gatewaySpy = vi
      .spyOn(questionDispatch, "resolveAgentQuestionGatewayCall")
      .mockReturnValue(dispatch);
    onTestFinished(() => gatewaySpy.mockRestore());
    const attempt = {
      agentId: target.agentId,
      sessionId,
      sessionKey: target.sessionKey,
      sessionFile: creatorResult.sessionFile,
      runId: `question-${scenario}`,
      workspaceDir: state.workspaceDir,
      config: {},
      provider: "fixture",
      modelId: "fixture",
      messageProvider: "webchat",
      senderIsOwner: true,
      userTurnTranscriptRecorder: creator,
    };
    const host = await createAdmittedHostCapabilityTestFixture(attempt);
    const releaseSettlement = createDeferredCore();
    const details = { status: "answered", answers: { answers: { target: ["Staging"] } } };
    const run = withPreparedEmbeddedRunToolAuthority(
      { admittedRunContext: host.admittedRunContext },
      { ...attempt, hostCapabilities: host.hostCapabilities },
      undefined,
      async () => {
        const result = await createAskUserTool({
          agentId: target.agentId,
          runId: attempt.runId,
          sessionKey: target.sessionKey,
        }).execute("ask", args);
        await releaseSettlement.promise;
        expect(result.details).toEqual(details);
        return persist({
          role: "toolResult",
          toolCallId: "ask",
          toolName: "ask_user",
          content: result.content,
          details: result.details,
          isError: false,
          timestamp: 3,
        });
      },
    );
    const outcome = run.then(
      (entryId) => ({ entryId, error: undefined }),
      (error: unknown) => ({ entryId: undefined, error }),
    );
    try {
      await awaitGateBeforeSettlement(
        waiting.promise,
        run,
        "Tool authority preparation ended before ask_user started waiting",
      );
      expect(questions.get(questionId)?.status).toBe("pending");
      // Ingress owns a different async scope. Only the claim may admit its real
      // persisted answer into the blocked production run's custody.
      const source = createUserTurnTranscriptRecorder({
        target: recorderTarget,
        input: { text: "Staging", idempotencyKey: "source:user" },
      });
      const claimed = await claimPendingAgentQuestionAnswer({
        sessionKey: target.sessionKey,
        text: "Staging",
        sourceRecorder: source,
        authority: { kind: "run", assertCurrent: () => {} },
      });
      expect(claimed).toBe(true);
      const answerId = source.getAdmissionReceipt()?.entryId;
      assert(answerId);
      if (scenario === "unrelated-user") {
        await createUserTurnTranscriptRecorder({
          target: recorderTarget,
          input: { text: "An unrelated new turn", idempotencyKey: "unrelated:user" },
        }).persistApproved();
      }
      const beforeSettlement = await loadTranscriptEvents(target);
      releaseSettlement.resolve();
      const settled = await outcome;
      const events = await loadTranscriptEvents(target);
      if (scenario === "unrelated-user") {
        expect(settled.error).toBeInstanceOf(SqliteTranscriptMutationConflictError);
        expect(settled.entryId).toBeUndefined();
        expect(events).toEqual(beforeSettlement);
      } else {
        expect(settled.error).toBeUndefined();
        expect(settled.entryId).toEqual(expect.any(String));
        expect(readTranscriptMutationAtSync(target)).toBeGreaterThan(before);
        expect(events.at(-1)).toMatchObject({
          parentId: answerId,
          message: { role: "toolResult", toolCallId: "ask", toolName: "ask_user", details },
        });
        await manager.reloadPersistedTranscriptAsync();
        expect(manager.getPersistedEntries()).toEqual(events);
      }
    } finally {
      // A refused claim or assertion must unblock waitAnswer before we await run.
      questions.close();
      releaseSettlement.resolve();
      await outcome;
      try {
        await questions.drain();
        await scheduler.stop();
      } finally {
        host.closeHost();
        host.closeAdmission();
      }
    }
  },
);
