import { describe, expect, it, vi } from "vitest";
import { createMessageInjectionAuthority } from "../../auto-reply/reply/message-injection-authority.js";
import { isEmbeddedMode, setEmbeddedMode } from "../../infra/embedded-mode.js";
import {
  EmbeddedQuestionBroker,
  clearEmbeddedQuestionBroker,
  setEmbeddedQuestionBroker,
} from "../../infra/embedded-question-broker.js";
import { createDeferredCore as deferred } from "../../shared/deferred.js";
import {
  createAskUserTool,
  isAskUserPromptPending,
  reserveAskUserPromptDelivery,
  settleAskUserPromptDelivery,
  waitForAskUserPromptReady,
} from "../tools/ask-user-tool.js";
import {
  QuestionAnswerUnconfirmedError,
  resolveAgentQuestionGatewayCall,
  type AgentHarnessQuestionGatewayCall,
  type AgentQuestionDispatcher,
} from "./gateway-question-dispatch.js";
import {
  cancelPendingAgentQuestionForSession,
  claimPendingAgentQuestionAnswer,
  registerPendingAgentQuestion,
  runAgentHarnessGatewayQuestion,
} from "./gateway-question.js";
import { callGatewayTool, withQuestionGateway } from "./gateway-question.test-support.js";

type Fixture = Parameters<Parameters<typeof withQuestionGateway>[0]>[0];
type Dispatcher = Exclude<
  Parameters<typeof runAgentHarnessGatewayQuestion>[0]["gatewayCall"],
  AgentHarnessQuestionGatewayCall | undefined
>;
const sessionKey = "agent:main:question-dispatch";
const questions = [
  { id: "answer", header: "Answer", question: "Continue?", isOther: true, options: [] },
];
const protocolQuestions = questions.map(({ id, ...question }) => ({ ...question, questionId: id }));

async function withEmbeddedBroker(
  embedded: boolean,
  registered: boolean,
  run: (broker: EmbeddedQuestionBroker) => Promise<void>,
) {
  const previousMode = isEmbeddedMode();
  const broker = new EmbeddedQuestionBroker();
  setEmbeddedMode(embedded);
  if (registered) {
    setEmbeddedQuestionBroker(broker);
  }
  try {
    await run(broker);
  } finally {
    clearEmbeddedQuestionBroker(broker);
    broker.stop();
    setEmbeddedMode(previousMode);
  }
}

function startQuestion(
  fixture: Fixture,
  owner: "harness" | "ask_user",
  gatewayCall?: Parameters<typeof runAgentHarnessGatewayQuestion>[0]["gatewayCall"],
  onPrompt?: () => void,
) {
  if (owner === "harness") {
    const delivered = deferred();
    const run = runAgentHarnessGatewayQuestion({
      sessionKey,
      questions,
      timeoutMs: 60_000,
      gatewayCall,
      signal: fixture.backingRun.signal,
      delivery: {
        onBlockReply: async () => {
          onPrompt?.();
          delivered.resolve();
        },
      },
    });
    return { run, showPrompt: () => delivered.promise };
  }
  const toolCallId = "source-dispatch-test";
  const question = { ...questions[0]!, options: [{ label: "Continue" }, { label: "Stop" }] };
  const reservation = reserveAskUserPromptDelivery({
    sessionKey,
    toolCallId,
    questions: [{ ...question, questionId: "answer" }],
  });
  if (!reservation) {
    throw new Error("expected prompt reservation");
  }
  const run = createAskUserTool({ sessionKey, gatewayCall })
    .execute(toolCallId, { questions: [question], timeoutSeconds: 60 }, fixture.backingRun.signal)
    .then((result) => result.details);
  return {
    run,
    showPrompt: async () => {
      expect(await waitForAskUserPromptReady(reservation.questionId)).toHaveLength(1);
      expect(await isAskUserPromptPending(reservation.questionId)).toBe(true);
      settleAskUserPromptDelivery(reservation.questionId);
    },
  };
}

function currentSource(fixture: Fixture) {
  const source = new AbortController();
  return {
    source,
    authority: {
      kind: "source-bound" as const,
      assertCurrent: createMessageInjectionAuthority(
        () => !source.signal.aborted && !fixture.backingRun.signal.aborted,
      ),
    },
  };
}

const ownerCases = (["harness", "ask_user"] as const).flatMap((owner) =>
  (
    [
      "registration",
      "persistence",
      "hello",
      "registration-cancel",
      "successive-refusals",
      "successor-answer",
    ] as const
  ).map((stage) => ({
    owner,
    stage,
  })),
);

describe("question dispatch ownership", () => {
  it.each([
    { embedded: true, registered: true },
    { embedded: true, registered: false },
    { embedded: false, registered: true },
  ])("routes locally only for embedded=$embedded, registered=$registered", async (mode) => {
    await withQuestionGateway(async (fixture) => {
      await withEmbeddedBroker(mode.embedded, mode.registered, async (broker) => {
        const call = resolveAgentQuestionGatewayCall();
        await call(
          "question.request",
          {},
          {
            id: "routing-question",
            questions: protocolQuestions,
          },
        );
        const local = mode.embedded && mode.registered;
        expect(broker.list().questions).toHaveLength(local ? 1 : 0);
        expect(fixture.manager.list()).toHaveLength(local ? 0 : 1);
        expect(fixture.requests.map((request) => request.method)).toEqual(
          local ? [] : ["question.request"],
        );
        await call("question.resolve", {}, { id: "routing-question", cancel: true });
      });
    });
  });

  it.each(["legacy", "version-2"] as const)(
    "preserves an explicit %s dispatcher while the embedded broker is registered",
    async (kind) => {
      await withEmbeddedBroker(true, true, async (broker) => {
        const dispatched: string[] = [];
        const custom: AgentHarnessQuestionGatewayCall = async (method) => {
          dispatched.push(method);
          return { questions: [] };
        };
        const dispatcher: AgentQuestionDispatcher = {
          version: 2,
          call: ({ method, options, params }) => custom(method, options, params),
        };
        const call = resolveAgentQuestionGatewayCall(kind === "legacy" ? custom : dispatcher);
        expect(await call("question.list", {}, {})).toEqual({ questions: [] });
        expect(dispatched).toEqual(["question.list"]);
        expect(broker.list().questions).toEqual([]);
      });
    },
  );

  it("keeps plain replies answerable locally and refuses retired source input", async () => {
    await withEmbeddedBroker(true, true, async (broker) => {
      const requested = deferred();
      broker.subscribe((event) => {
        if (event.event === "question.requested") {
          requested.resolve();
        }
      });
      const run = createAskUserTool({ sessionKey }).execute("local-question", {
        questions: [{ ...questions[0], options: [{ label: "Continue" }, { label: "Stop" }] }],
      });
      try {
        await requested.promise;
        await expect(
          claimPendingAgentQuestionAnswer({
            sessionKey,
            text: "obsolete",
            authority: {
              kind: "source-bound",
              assertCurrent: () => {
                throw new Error("retired source");
              },
            },
          }),
        ).rejects.toThrow("retired source");
        expect(broker.list().questions).toHaveLength(1);
        await expect(
          claimPendingAgentQuestionAnswer({ sessionKey, text: "Continue" }),
        ).resolves.toBe(true);
        expect((await run).details).toMatchObject({
          status: "answered",
          answers: { answers: { answer: ["Continue"] } },
        });
      } finally {
        broker.stop();
        await run;
      }
    });
  });

  it("rechecks source authority after loading the local dispatcher and before resolving", async () => {
    await withEmbeddedBroker(true, true, async (broker) => {
      const request = broker.request({
        questions: protocolQuestions,
      });
      let active = true;
      const resolving = resolveAgentQuestionGatewayCall()(
        "question.resolve",
        {},
        { id: request.id, answers: { answers: { answer: ["obsolete"] } } },
        {
          dispatchAuthority: {
            version: 2,
            kind: "source-bound",
            assertCurrent: () => {
              if (!active) {
                throw new Error("retired source");
              }
            },
          },
        },
      );
      active = false;
      await expect(resolving).rejects.toThrow("retired source");
      expect(broker.get({ id: request.id }).question.status).toBe("pending");
    });
  });

  it("keeps shutdown cancellation on the original local owner after deregistration", async () => {
    await withEmbeddedBroker(true, true, async (broker) => {
      const call = resolveAgentQuestionGatewayCall();
      await call(
        "question.request",
        {},
        {
          id: "shutdown-question",
          questions: protocolQuestions,
        },
      );
      clearEmbeddedQuestionBroker(broker);
      setEmbeddedMode(false);
      expect(await call("question.resolve", {}, { id: "shutdown-question", cancel: true })).toEqual(
        {
          status: "cancelled",
        },
      );
      expect(broker.list().questions).toEqual([]);
    });
  });

  it.each(ownerCases)(
    "preserves $owner question ownership across $stage",
    async ({ owner, stage }) => {
      await withQuestionGateway(async (fixture) => {
        const registration = fixture.holdRegistration();
        const onPrompt = vi.fn();
        const question = startQuestion(fixture, owner, undefined, onPrompt);
        const { source, authority } = currentSource(fixture);
        const persisting = deferred();
        const persisted = deferred();
        const successor = currentSource(fixture);
        const successorPersisting = deferred();
        const successorPersisted = deferred();
        const persist = vi.fn(async () => {
          persisting.resolve();
          await persisted.promise;
        });
        try {
          await registration.entered;
          const attempt =
            stage === "registration-cancel"
              ? cancelPendingAgentQuestionForSession({
                  sessionKey,
                  resolvedBy: "image-reply",
                  authority,
                })
              : claimPendingAgentQuestionAnswer({
                  sessionKey,
                  text: "obsolete",
                  authority,
                  persist,
                });
          const outcome = attempt.catch((error: unknown) => {
            if (stage !== "successive-refusals" && stage !== "successor-answer") {
              return error;
            }
            return claimPendingAgentQuestionAnswer({
              sessionKey,
              text: "successor",
              authority: successor.authority,
              persist: async () => {
                successorPersisting.resolve();
                await successorPersisted.promise;
              },
            }).catch((nextError: unknown) => nextError);
          });
          if (stage === "registration" || stage === "registration-cancel") {
            source.abort();
            registration.release();
          } else {
            registration.release();
            await Promise.all([persisting.promise, fixture.waitStarted]);
            if (stage === "hello") {
              const hello = fixture.holdNextHello();
              persisted.resolve();
              await hello.entered;
              source.abort();
              hello.release();
            } else {
              source.abort();
              persisted.resolve();
            }
          }
          if (stage === "successive-refusals" || stage === "successor-answer") {
            await successorPersisting.promise;
            if (stage === "successive-refusals") {
              successor.source.abort();
            }
            successorPersisted.resolve();
          }
          if (stage === "successor-answer") {
            expect(await outcome).toBe(true);
            expect(await question.run).toMatchObject({
              status: "answered",
              answers: { answers: { answer: ["successor"] } },
            });
            if (owner === "harness") {
              expect(onPrompt).not.toHaveBeenCalled();
            }
            expect(
              fixture.requests.filter((frame) => frame.method === "question.resolve"),
            ).toHaveLength(1);
            return;
          }
          expect(await outcome).toBeInstanceOf(Error);
          expect(persist).toHaveBeenCalledTimes(
            stage === "registration" || stage === "registration-cancel" ? 0 : 1,
          );
          expect(fixture.requests.filter((frame) => frame.method === "question.resolve")).toEqual(
            [],
          );
          expect(fixture.manager.list()).toHaveLength(1);
          expect(fixture.backingRun.signal.aborted).toBe(false);
          let promptShown = false;
          const prompt = question.showPrompt().then(() => {
            promptShown = true;
          });
          await vi.waitFor(() => expect(promptShown).toBe(true));
          await prompt;
          await expect(
            claimPendingAgentQuestionAnswer({
              sessionKey,
              text: "current",
              authority: currentSource(fixture).authority,
            }),
          ).resolves.toBe(true);
          expect(await question.run).toMatchObject({
            status: "answered",
            answers: { answers: { answer: ["current"] } },
          });
        } finally {
          registration.release();
          persisted.resolve();
          successorPersisted.resolve();
          fixture.backingRun.abort();
          await question.run.catch(() => undefined);
        }
      });
    },
  );

  it.each(["legacy-run", "legacy-source", "v2-open", "v2-closed"] as const)(
    "preserves explicit custom transport semantics for %s",
    async (mode) => {
      await withQuestionGateway(async (fixture) => {
        const preparing = deferred();
        const prepared = deferred();
        const { source, authority } = currentSource(fixture);
        const legacy: AgentHarnessQuestionGatewayCall = vi.fn(callGatewayTool);
        const dispatcher: Dispatcher = {
          version: 2,
          call: async ({ method, options, params, signal, authority: dispatchAuthority }) => {
            if (dispatchAuthority.kind === "source-bound") {
              preparing.resolve();
              await prepared.promise;
              dispatchAuthority.assertCurrent();
            }
            return callGatewayTool(method, options, params, {
              signal,
              ...(dispatchAuthority.kind === "source-bound"
                ? { dispatchAuthority: { version: 2, ...dispatchAuthority } }
                : {}),
            });
          },
        };
        const question = startQuestion(
          fixture,
          "harness",
          mode.startsWith("legacy") ? legacy : dispatcher,
        );
        const persist = vi.fn(async () => {});
        try {
          await Promise.all([fixture.waitStarted, question.showPrompt()]);
          const attempt = claimPendingAgentQuestionAnswer({
            sessionKey,
            text: "custom answer",
            persist,
            authority: mode === "legacy-run" ? { ...authority, kind: "run" } : authority,
          });
          const outcome = attempt.catch((error: unknown) => error);
          if (mode.startsWith("v2")) {
            await preparing.promise;
            if (mode === "v2-closed") {
              source.abort();
            }
            prepared.resolve();
          }
          const result = await outcome;
          if (mode === "legacy-source" || mode === "v2-closed") {
            expect(result).toBeInstanceOf(Error);
            expect(fixture.requests.filter((frame) => frame.method === "question.resolve")).toEqual(
              [],
            );
            expect(persist).toHaveBeenCalledTimes(mode === "legacy-source" ? 0 : 1);
            expect(fixture.manager.list()).toHaveLength(1);
            await expect(
              claimPendingAgentQuestionAnswer({ sessionKey, text: "later ordinary" }),
            ).resolves.toBe(true);
          } else {
            expect(result).toBe(true);
            expect(persist).toHaveBeenCalledOnce();
          }
          expect(await question.run).toMatchObject({ status: "answered" });
        } finally {
          prepared.resolve();
          fixture.backingRun.abort();
          await question.run.catch(() => undefined);
        }
      });
    },
  );

  it("does not recover a refused input as another surface's committed answer", async () => {
    await withQuestionGateway(async (fixture) => {
      const question = startQuestion(fixture, "harness");
      const { source, authority } = currentSource(fixture);
      await Promise.all([fixture.waitStarted, question.showPrompt()]);
      const hello = fixture.holdNextHello();
      const attempt = claimPendingAgentQuestionAnswer({ sessionKey, text: "obsolete", authority });
      const outcome = attempt.catch((error: unknown) => error);
      await hello.entered;
      source.abort();
      const pending = fixture.manager.list()[0]!;
      fixture.manager.resolve(pending.id, { answers: { answer: ["other surface"] } });
      await question.run;
      hello.release();
      expect(await outcome).toBeInstanceOf(Error);
      expect(fixture.requests.filter((frame) => frame.method === "question.resolve")).toEqual([]);
      expect(fixture.manager.get(pending.id)?.answers).toEqual({
        answers: { answer: ["other surface"] },
      });
    });
  });

  it.each([
    ["harness", undefined],
    ["harness", "other-resolver"],
    ["ask_user", undefined],
    ["ask_user", "other-resolver"],
  ] as const)(
    "does not consume a failed %s input when another resolver submits identical text (receipt=%s)",
    async (owner, resolutionId) => {
      await withQuestionGateway(async (fixture) => {
        const question = startQuestion(fixture, owner);
        const { source, authority } = currentSource(fixture);
        await Promise.all([fixture.waitStarted, question.showPrompt()]);
        const hello = fixture.holdNextHello();
        const attempt = claimPendingAgentQuestionAnswer({
          sessionKey,
          text: "same answer",
          authority,
        });
        const outcome = attempt.catch((error: unknown) => error);
        try {
          await hello.entered;
          const pending = fixture.manager.list()[0]!;
          fixture.manager.resolve(pending.id, { answers: { answer: ["same answer"] } }, "other", {
            resolutionId,
          });
          expect(await question.run).toMatchObject({
            status: "answered",
            answers: { answers: { answer: ["same answer"] } },
          });
          hello.fail();
          if (resolutionId === undefined) {
            expect(await outcome).toBeInstanceOf(QuestionAnswerUnconfirmedError);
          } else {
            expect(await outcome).toBe(false);
          }
          expect(source.signal.aborted).toBe(false);
          expect(fixture.backingRun.signal.aborted).toBe(false);
          expect(fixture.requests.filter((frame) => frame.method === "question.resolve")).toEqual(
            [],
          );
        } finally {
          hello.fail();
          fixture.backingRun.abort();
          await Promise.all([outcome, question.run.catch(() => undefined)]);
        }
      });
    },
  );

  it.each(
    (["harness", "ask_user"] as const).flatMap((owner) =>
      (["immediate", "delayed", "lost"] as const).map((receiptMode) => ({ owner, receiptMode })),
    ),
  )(
    "settles the $owner input after commit, source closure, and a lost response (receipt=$receiptMode)",
    async ({ owner, receiptMode }) => {
      await withQuestionGateway(async (fixture) => {
        const receipt = receiptMode === "immediate" ? undefined : fixture.holdWaitAnswerResponse();
        const question = startQuestion(fixture, owner);
        const observedQuestion = question.run.catch((error: unknown) => error);
        const { source, authority } = currentSource(fixture);
        const persist = vi.fn(async () => {});
        try {
          await Promise.all([fixture.waitStarted, question.showPrompt()]);
          fixture.dropNextResolveResponse();
          fixture.onResolved(() => source.abort());
          let settled = false;
          const outcome = claimPendingAgentQuestionAnswer({
            sessionKey,
            text: "committed",
            authority,
            persist,
          }).then(
            (result) => {
              settled = true;
              return result;
            },
            (error: unknown) => {
              settled = true;
              return error;
            },
          );
          if (receipt) {
            await receipt.entered;
            if (receiptMode === "delayed") {
              // A delayed independent response must not expire a committed claim.
              await new Promise((resolve) => {
                setTimeout(resolve, 1_500);
              });
              expect(settled).toBe(false);
              receipt.release();
            } else {
              receipt.fail();
            }
          }
          if (receiptMode === "lost") {
            expect(await outcome).toBeInstanceOf(QuestionAnswerUnconfirmedError);
            expect(await observedQuestion).toBeInstanceOf(Error);
          } else {
            expect(await outcome).toBe(true);
            expect(await question.run).toMatchObject({
              status: "answered",
              answers: { answers: { answer: ["committed"] } },
            });
          }
          const resolves = fixture.requests.filter(
            (frame) =>
              frame.method === "question.resolve" &&
              typeof frame.params === "object" &&
              frame.params !== null &&
              "answers" in frame.params,
          );
          expect(resolves).toHaveLength(1);
          expect(resolves[0]?.params).toMatchObject({
            resolutionId: expect.stringMatching(/^[a-f0-9]{32}$/),
          });
          expect(persist).toHaveBeenCalledOnce();
          expect(source.signal.aborted).toBe(true);
          expect(fixture.backingRun.signal.aborted).toBe(false);
        } finally {
          receipt?.release();
          fixture.backingRun.abort();
          await question.run.catch(() => undefined);
        }
      });
    },
  );

  it.each(["harness", "ask_user"] as const)(
    "releases a rejected %s answer without waiting for the human question deadline",
    async (owner) => {
      await withQuestionGateway(async (fixture) => {
        const question = startQuestion(fixture, owner);
        let outcome: Promise<unknown> | undefined;
        try {
          await Promise.all([fixture.waitStarted, question.showPrompt()]);
          let settled = false;
          outcome = claimPendingAgentQuestionAnswer({ sessionKey, text: "" }).catch(
            (error: unknown) => {
              settled = true;
              return error;
            },
          );
          await vi.waitFor(() => expect(settled).toBe(true));
          expect(await outcome).toMatchObject({
            name: "GatewayClientRequestError",
            gatewayCode: "INVALID_REQUEST",
            details: { reason: "QUESTION_INVALID_ANSWER" },
          });
          expect(fixture.manager.list()).toHaveLength(1);
          await expect(
            claimPendingAgentQuestionAnswer({ sessionKey, text: "valid" }),
          ).resolves.toBe(true);
          expect(await question.run).toMatchObject({ status: "answered" });
        } finally {
          fixture.backingRun.abort();
          await Promise.all([outcome, question.run.catch(() => undefined)]);
        }
      });
    },
  );

  it.each(
    (["harness", "ask_user"] as const).flatMap((owner) =>
      (["cancelled", "expired"] as const).map((status) => ({ owner, status })),
    ),
  )("releases the failed $owner input after authoritative $status", async ({ owner, status }) => {
    await withQuestionGateway(async (fixture) => {
      const question = startQuestion(fixture, owner);
      await Promise.all([fixture.waitStarted, question.showPrompt()]);
      const hello = fixture.holdNextHello();
      const outcome = claimPendingAgentQuestionAnswer({ sessionKey, text: "obsolete" }).catch(
        (error: unknown) => error,
      );
      try {
        await hello.entered;
        const pending = fixture.manager.list()[0]!;
        if (status === "cancelled") {
          fixture.manager.cancel(pending.id);
        } else {
          const clock = vi.spyOn(Date, "now").mockReturnValue(pending.expiresAtMs + 1);
          try {
            fixture.manager.get(pending.id);
          } finally {
            clock.mockRestore();
          }
        }
        expect(await question.run).toMatchObject({
          status: owner === "harness" ? status : "no_answer",
        });
        hello.fail();
        expect(await outcome).toBe(false);
        expect(fixture.requests.filter((frame) => frame.method === "question.resolve")).toEqual([]);
      } finally {
        hello.fail();
        fixture.backingRun.abort();
        await Promise.all([outcome, question.run.catch(() => undefined)]);
      }
    });
  });

  it("fences a replaced reservation even when its session and question IDs are unchanged", async () => {
    await withQuestionGateway(async (fixture) => {
      const questionId = "ask_77777777777777777777777777777777";
      await callGatewayTool(
        "question.request",
        {},
        {
          id: questionId,
          sessionKey,
          questions: [{ ...questions[0], questionId: "answer" }],
          timeoutMs: 60_000,
        },
      );
      const answer = fixture.manager.waitAnswer(questionId);
      const register = () => {
        const claim = registerPendingAgentQuestion({ questionId, sessionKey, questions, answer });
        claim.attachRegistration(Promise.resolve());
        return claim;
      };
      const old = register();
      const hello = fixture.holdNextHello();
      const attempt = claimPendingAgentQuestionAnswer({
        sessionKey,
        text: "old",
        authority: currentSource(fixture).authority,
      });
      const outcome = attempt.catch((error: unknown) => error);
      await hello.entered;
      old.dispose();
      const replacement = register();
      try {
        hello.release();
        expect(await outcome).toBeInstanceOf(Error);
        expect(fixture.requests.filter((frame) => frame.method === "question.resolve")).toEqual([]);
        expect(fixture.manager.get(questionId)?.status).toBe("pending");
        await expect(
          claimPendingAgentQuestionAnswer({
            sessionKey,
            text: "replacement",
            authority: currentSource(fixture).authority,
          }),
        ).resolves.toBe(true);
        expect(await answer).toMatchObject({
          status: "answered",
          answers: { answers: { answer: ["replacement"] } },
        });
      } finally {
        replacement.dispose();
      }
    });
  });
});
