import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createMessageInjectionAuthority } from "../../auto-reply/reply/message-injection-authority.js";
import {
  listSessionPendingInputs,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  PreparedQuestionAnswerRefusedError,
  QuestionDispatchRefusedError,
  type AgentHarnessQuestionGatewayCall,
} from "./gateway-question-dispatch.js";
import {
  cancelPendingAgentQuestionForSession,
  claimPendingAgentQuestionAnswer,
  claimPendingAgentQuestionAnswerFromCaller,
  claimPreparedPendingAgentQuestionAnswer,
  registerPendingAgentQuestion,
  runAgentHarnessGatewayQuestion,
} from "./gateway-question.js";
import { withQuestionGateway } from "./gateway-question.test-support.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";

const questionId = "ask_1234567890abcdef1234567890abcdef";
type Answer = { status: "answered"; answers: { answers: Record<string, string[]> } };
type QuestionOptions = Parameters<typeof runAgentHarnessGatewayQuestion>[0];

function settled<T>(promise: Promise<T>) {
  return promise.then(
    (accepted) => ({ accepted }),
    (error: unknown) => ({ error }),
  );
}

function expectUncalled(...mocks: Array<ReturnType<typeof vi.fn>>) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

const questions = [
  {
    id: "answer",
    header: "Answer",
    question: "What should happen?",
    isOther: true,
    options: [],
  },
] as const;

function startQuestion(
  sessionKey: string,
  gatewayCall: AgentHarnessQuestionGatewayCall | undefined,
  onBlockReply: QuestionOptions["delivery"]["onBlockReply"] = vi.fn(),
  extra: Partial<QuestionOptions> = {},
) {
  return runAgentHarnessGatewayQuestion({
    questions,
    sessionKey,
    questionId,
    gatewayCall,
    timeoutMs: 60_000,
    ...extra,
    delivery: { onBlockReply, ...extra.delivery },
  });
}

function cancelQuestion(
  sessionKey: string,
  authority?: Parameters<typeof cancelPendingAgentQuestionForSession>[0]["authority"],
) {
  return cancelPendingAgentQuestionForSession({ sessionKey, resolvedBy: "image-reply", authority });
}

function claimQuestion(sessionKey: string, text = "Continue") {
  return claimPendingAgentQuestionAnswer({ sessionKey, text });
}

function reserveQuestion(sessionKey: string, gatewayCall: AgentHarnessQuestionGatewayCall) {
  return registerPendingAgentQuestion({ questionId, sessionKey, questions, gatewayCall });
}

function answerGateway(cancel: () => unknown) {
  const answer = createDeferred<Answer>();
  const gatewayCall = gatewayStub({
    "question.request": (params) => ({ id: (params as { id: string }).id }),
    "question.waitAnswer": () => answer.promise,
    "question.resolve": (params) => {
      const resolved = (params as { answers?: Answer["answers"] }).answers;
      if (!resolved) {
        return cancel();
      }
      const result: Answer = { status: "answered", answers: resolved };
      answer.resolve(result);
      return result;
    },
  });
  return gatewayCall;
}

function gatewayStub(
  handlers: Record<string, (params: unknown) => unknown>,
): AgentHarnessQuestionGatewayCall {
  return async (method, _opts, params) => {
    const handler = handlers[method];
    if (!Object.hasOwn(handlers, method) || !handler) {
      throw new Error(`unexpected gateway method: ${method}`);
    }
    return handler(params);
  };
}

function answerResult(text: string) {
  return { status: "answered", answers: { answers: { answer: [text] } } };
}

function gatewayError(message: string, reason: string) {
  return Object.assign(new Error(message), {
    name: "GatewayClientRequestError",
    details: { reason },
  });
}

describe("gateway harness questions", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      for (const dir of tempDirs.dirs) {
        await closeOpenClawAgentDatabasesAsync(dir);
      }
      cleanup();
    }),
  );
  it.each(["uncommitted", "question-replaced", "creator-closed", "unstaged"] as const)(
    "settles secret input only after current source persistence: %s",
    async (change) => {
      const sessionKey = "agent:main:secret-source-persistence";
      const attempt = {
        sessionId: "secret-source-session",
        sessionKey,
        runId: "secret-source-run",
        agentId: "main",
        config: {},
        sessionFile: "/tmp/secret-source-session.jsonl",
        workspaceDir: "/tmp/secret-source-workspace",
        provider: "openai",
        modelId: "gpt-test",
        messageProvider: "webchat",
        senderIsOwner: true,
      };
      const host = await createAdmittedHostCapabilityTestFixture(attempt);
      const controller = new AbortController();
      const source = new AbortController();
      let promptDelivered = createDeferred();
      const releasePersistence = createDeferred();
      const target = createTestUserTurnTranscriptTarget({
        sessionId: attempt.sessionId,
        sessionKey,
        storePath: path.join(tempDirs.make("secret-source-"), "sessions.sqlite"),
      });
      await replaceSessionEntry(target, { sessionId: attempt.sessionId, updatedAt: Date.now() });
      const sourceRecorder = createUserTurnTranscriptRecorder({
        target,
        input: { text: "example-input", idempotencyKey: "secret-source-input:user" },
        onPersistenceError: () => {},
      });
      if (change !== "unstaged") {
        expect(
          await sourceRecorder.stageApproved?.({
            runId: "secret-source-input",
            assertCurrent: () => source.signal.throwIfAborted(),
          }),
        ).toBe(true);
      }
      const stagedInputs = await listSessionPendingInputs(target);
      expect(stagedInputs.total).toBe(change === "unstaged" ? 0 : 1);
      const gatewayCall = vi.fn<AgentHarnessQuestionGatewayCall>();
      const ask = (signal: AbortSignal) =>
        withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext: host.admittedRunContext },
          { ...attempt, hostCapabilities: host.hostCapabilities },
          undefined,
          () =>
            startQuestion(sessionKey, gatewayCall, async () => promptDelivered.resolve(), {
              questions: [{ id: "answer", header: "Answer", question: "Input", isSecret: true }],
              signal,
              delivery: { hostCapabilities: host.hostCapabilities },
            }),
        );
      const question = ask(controller.signal);
      let answered = false;
      void question.then(() => {
        answered = true;
      });
      const persistApproved = sourceRecorder.persistApproved.bind(sourceRecorder);
      const persist = vi
        .spyOn(sourceRecorder, "persistApproved")
        .mockImplementation(async (options) => {
          await releasePersistence.promise;
          return change === "uncommitted" ? undefined : persistApproved(options);
        });
      const legacyPersist = vi.fn(async () => {});
      let claim: Promise<{ accepted: boolean } | { error: unknown }> | undefined;
      let replacement: ReturnType<typeof runAgentHarnessGatewayQuestion> | undefined;
      let replacementController: AbortController | undefined;
      try {
        await promptDelivered.promise;
        const claimParams = {
          sessionKey,
          text: "example-input",
          sourceRecorder,
          persist: legacyPersist,
          authority: {
            kind: "source-bound" as const,
            assertCurrent: () => source.signal.throwIfAborted(),
          },
        };
        claim = settled(claimPendingAgentQuestionAnswer(claimParams));
        if (change === "unstaged") {
          expect(await claim).toEqual({ accepted: true });
          await expect(question).resolves.toMatchObject({ status: "answered" });
          expect(persist).not.toHaveBeenCalled();
          expect(sourceRecorder.hasPersisted()).toBe(false);
          expectUncalled(legacyPersist, gatewayCall);
          return;
        }
        expect(persist).toHaveBeenCalledOnce();
        await Promise.resolve();
        expect(answered).toBe(false);
        if (change === "creator-closed") {
          host.closeHost();
        } else if (change === "question-replaced") {
          controller.abort();
          await expect(question).resolves.toEqual({ status: "cancelled" });
          promptDelivered = createDeferred();
          replacementController = new AbortController();
          replacement = ask(replacementController.signal);
          await promptDelivered.promise;
        }
        releasePersistence.resolve();
        expect(await claim).toMatchObject({ error: expect.any(QuestionDispatchRefusedError) });
        if (change === "uncommitted" || change === "question-replaced") {
          await expect(
            claimPendingAgentQuestionAnswer({
              sessionKey,
              text: "replacement-input",
              persist: async () => {},
              authority: { kind: "source-bound", assertCurrent: () => {} },
            }),
          ).resolves.toBe(true);
          await expect(replacement ?? question).resolves.toEqual(answerResult("replacement-input"));
        }
        expectUncalled(legacyPersist, gatewayCall);
      } finally {
        releasePersistence.resolve();
        controller.abort();
        replacementController?.abort();
        try {
          await claim;
          await question;
          await replacement;
        } finally {
          try {
            sourceRecorder.finishPendingInput?.("interrupted");
          } finally {
            host.closeHost();
            host.closeAdmission();
          }
        }
      }
    },
  );

  it.each(["route-refused", "source-revoked"] as const)(
    "revalidates prepared question input after registration and persistence: %s",
    async (outcome) => {
      const sessionKey = "agent:main:prepared-question-input";
      const registration = createDeferred();
      const persistenceStarted = createDeferred();
      const persistence = createDeferred();
      const preparationStarted = createDeferred();
      const preparation = createDeferred();
      const source = new AbortController();
      const gatewayCall = vi.fn<AgentHarnessQuestionGatewayCall>(async () => ({}));
      const question = reserveQuestion(sessionKey, gatewayCall);
      question.attachRegistration(registration.promise);
      const persist = vi.fn(async () => {
        persistenceStarted.resolve();
        await persistence.promise;
      });
      const prepare = vi.fn(async () => {
        preparationStarted.resolve();
        await preparation.promise;
        if (outcome === "route-refused") {
          throw new QuestionDispatchRefusedError("prepared route changed");
        }
      });
      const attempt = settled(
        claimPreparedPendingAgentQuestionAnswer(
          {
            sessionKey,
            text: "prepared answer",
            persist,
            authority: { kind: "run", assertCurrent: () => source.signal.throwIfAborted() },
          },
          prepare,
        ),
      );
      try {
        expectUncalled(persist, prepare);
        registration.resolve();
        await persistenceStarted.promise;
        expect(prepare).not.toHaveBeenCalled();
        persistence.resolve();
        await preparationStarted.promise;
        expect(gatewayCall).not.toHaveBeenCalled();
        if (outcome === "source-revoked") {
          source.abort();
        }
        preparation.resolve();
        expect(await attempt).toMatchObject({
          error: expect.any(PreparedQuestionAnswerRefusedError),
        });
        expect(gatewayCall).not.toHaveBeenCalled();
        await expect(
          claimPendingAgentQuestionAnswer({ sessionKey, text: "fresh answer" }),
        ).resolves.toBe(true);
        expect(gatewayCall).toHaveBeenCalledOnce();
        expect(persist).toHaveBeenCalledOnce();
        expect(prepare).toHaveBeenCalledOnce();
      } finally {
        registration.resolve();
        persistence.resolve();
        preparation.resolve();
        await attempt;
        question.dispose();
      }
    },
  );

  it("leaves an aborted caller without a pending question to ordinary admission", async () => {
    const source = new AbortController();
    source.abort();
    const persist = vi.fn();

    await expect(
      claimPendingAgentQuestionAnswerFromCaller({
        sessionKey: "agent:main:no-pending-question",
        text: "Continue",
        caller: {
          senderIsOwner: true,
          disableTools: false,
          traceAuthorized: false,
          messageProvider: "webchat",
        },
        assertSourceCurrent: () => source.signal.throwIfAborted(),
        persist,
      }),
    ).resolves.toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    { change: "open", cancel: false },
    { change: "reassigned", cancel: false },
    { change: "closed", cancel: true },
  ] as const)(
    "rechecks $change source authority at real question dispatch (cancel=$cancel)",
    async ({ change, cancel }) => {
      await withQuestionGateway(async (fixture) => {
        const source = new AbortController();
        const originalOwner = {};
        let currentOwner = originalOwner;
        const assertCurrent = createMessageInjectionAuthority(
          () => !source.signal.aborted && currentOwner === originalOwner,
        );
        const authority = {
          kind: "source-bound" as const,
          assertCurrent: () => {
            assertCurrent();
            fixture.backingRun.signal.throwIfAborted();
          },
        };
        const sessionKey = "agent:main:dispatch-authority";
        const promptDelivered = createDeferred();
        const run = startQuestion(sessionKey, undefined, async () => promptDelivered.resolve(), {
          runId: "live-backing-run",
          signal: fixture.backingRun.signal,
        });
        await Promise.all([fixture.waitStarted, promptDelivered.promise]);
        const hello = fixture.holdNextHello();
        const attempt = cancel
          ? cancelQuestion(sessionKey, authority)
          : claimPendingAgentQuestionAnswer({ sessionKey, text: "Old source answer", authority });
        const outcome = settled(attempt);
        const resolutions = () =>
          fixture.requests.filter((frame) => frame.method === "question.resolve");
        await hello.entered;
        expect(fixture.manager.get(questionId)?.status).toBe("pending");
        expect(resolutions()).toEqual([]);
        if (change === "closed") {
          source.abort();
        } else if (change === "reassigned") {
          currentOwner = {};
        }
        hello.release();
        const result = await outcome;
        expect(fixture.backingRun.signal.aborted).toBe(false);
        const revokedBeforeDispatch = change === "closed" || change === "reassigned";
        if (revokedBeforeDispatch) {
          expect.soft(resolutions()).toEqual([]);
          expect.soft(fixture.manager.get(questionId)?.status).toBe("pending");
          expect.soft(result).toHaveProperty("error");
          // Rejection must release the reservation without replacing the question or run.
          const later = await claimPendingAgentQuestionAnswer({
            sessionKey,
            text: "Current source answer",
            authority: { kind: "source-bound", assertCurrent: () => {} },
          });
          expect.soft(later).toBe(true);
          expect.soft(await run).toEqual(answerResult("Current source answer"));
        } else {
          expect(result).toEqual({ accepted: true });
          expect(await run).toEqual(answerResult("Old source answer"));
          expect(resolutions()).toHaveLength(1);
        }
      });
    },
  );

  it("does not request a gateway question when the session reservation conflicts", async () => {
    const gatewayCall = vi.fn<AgentHarnessQuestionGatewayCall>();
    const reservation = reserveQuestion("agent:main:conflict", gatewayCall);

    await expect(startQuestion("agent:main:conflict", gatewayCall)).rejects.toThrow(
      "session already has a pending agent input request",
    );
    expect(gatewayCall).not.toHaveBeenCalled();
    reservation.dispose();
  });

  it.each(["cancelled", "answered", "failed"] as const)(
    "settles a claim made during registration when registration is %s",
    async (outcome) => {
      const registration = createDeferred<{ id: string }>();
      const sessionKey = "agent:main:registering";
      let resolveCount = 0;
      const handlers: Parameters<typeof gatewayStub>[0] = {
        "question.request": () => registration.promise,
        "question.resolve": () => {
          resolveCount += 1;
          if (outcome !== "failed" && resolveCount === 1) {
            throw gatewayError("not registered yet", "QUESTION_NOT_FOUND");
          }
          if (outcome === "answered") {
            throw gatewayError("already answered", "QUESTION_ALREADY_TERMINAL");
          }
          return { status: "cancelled" };
        },
      };
      if (outcome === "answered") {
        handlers["question.waitAnswer"] = () => answerResult("Continue");
      }
      const gatewayCall = vi.fn(gatewayStub(handlers));
      const onBlockReply = vi.fn();
      const run = startQuestion(sessionKey, gatewayCall, onBlockReply);
      if (outcome === "failed") {
        const claim = claimQuestion(sessionKey);
        registration.reject(new Error("gateway unavailable"));
        await expect(claim).resolves.toBe(false);
        await expect(run).rejects.toThrow("gateway unavailable");
      } else {
        await expect(cancelQuestion(sessionKey)).resolves.toBe(true);
        registration.resolve({ id: questionId });
        await expect(run).resolves.toEqual(
          outcome === "answered" ? answerResult("Continue") : { status: "cancelled" },
        );
      }
      expect(onBlockReply).not.toHaveBeenCalled();
      if (outcome === "cancelled") {
        expect(resolveCount).toBe(2);
        expect(gatewayCall.mock.calls.some(([method]) => method === "question.waitAnswer")).toBe(
          false,
        );
      }
    },
  );

  it.each(["request", "wait"] as const)("handles an early %s rejection", async (phase) => {
    const error = new Error("gateway disconnected");
    const gatewayCall = gatewayStub({
      "question.request": async (params) => {
        expect(params).toMatchObject({ runId: "run-delivery" });
        if (phase === "request") {
          throw error;
        }
        return { id: (params as { id: string }).id };
      },
      "question.waitAnswer": async () => {
        if (phase === "wait") {
          throw error;
        }
        return answerResult("Continue");
      },
      "question.resolve": async () => {
        if (phase === "request") {
          throw gatewayError("already answered", "QUESTION_ALREADY_TERMINAL");
        }
        return { status: "cancelled" };
      },
    });
    const run = startQuestion("agent:main:delivery", gatewayCall, vi.fn(), {
      runId: "run-delivery",
    });
    if (phase === "wait") {
      await expect(run).rejects.toBe(error);
    } else {
      await expect(run).resolves.toEqual(answerResult("Continue"));
    }
  });

  it("accepts a later text answer after cancellation fails", async () => {
    let cancelAttempts = 0;
    const gatewayCall = answerGateway(() => {
      cancelAttempts += 1;
      throw new Error("temporary gateway failure");
    });
    const onBlockReply = vi.fn();
    const run = startQuestion("agent:main:cancel-retry", gatewayCall, onBlockReply);
    await vi.waitFor(() => expect(onBlockReply).toHaveBeenCalledOnce());
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        deliveryIntentId: `block-reply:v1:agent-question:${questionId}`,
      }),
    );

    await expect(cancelQuestion("agent:main:cancel-retry")).rejects.toThrow(
      "temporary gateway failure",
    );
    await expect(claimQuestion("agent:main:cancel-retry")).resolves.toBe(true);

    await expect(run).resolves.toEqual(answerResult("Continue"));
    expect(cancelAttempts).toBe(1);
  });

  it("returns a gateway answer without waiting for stalled prompt delivery", async () => {
    const gatewayCall = answerGateway(() => ({ status: "cancelled" }));
    let deliverySignal: AbortSignal | undefined;
    const onBlockReply = vi.fn(
      async (_payload, context?: { abortSignal?: AbortSignal }) =>
        await new Promise<void>(() => {
          deliverySignal = context?.abortSignal;
        }),
    );
    const run = startQuestion("agent:main:stalled-delivery", gatewayCall, onBlockReply);
    await vi.waitFor(() => expect(onBlockReply).toHaveBeenCalledOnce());
    await expect(claimQuestion("agent:main:stalled-delivery")).resolves.toBe(true);

    await expect(run).resolves.toEqual(answerResult("Continue"));
    expect(deliverySignal?.aborted).toBe(true);
  });
});
