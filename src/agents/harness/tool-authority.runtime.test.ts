import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { resolveFollowupRunToolAuthorityFingerprintAsync } from "../../auto-reply/reply/reply-tool-authority.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type { ReplyToolAuthorityOverlay } from "../../sessions/session-controller.contracts.js";
import {
  beginReplyMessageInjectionTarget,
  createReplyOperation,
  getSessionControllerOperation,
  captureCurrentReplyMessageInjectionTarget,
} from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { resolveSessionRunProgressState } from "../../sessions/session-controller.queries.js";
import { testing as replyTesting } from "../../sessions/session-controller.test-support.js";
import { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import {
  attachActiveEmbeddedRun as publishActiveEmbeddedRun,
  detachActiveEmbeddedRun,
} from "../embedded-agent-runner/runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
  testing,
  steerTestSessionTurn,
} from "../embedded-agent-runner/runs.test-support.js";
import { attachToolAllowlistIntersection } from "../tool-policy-shared.js";
import {
  getGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { SessionControllerAdmissionRequiredError } from "./errors.js";
import type { AgentQuestionDispatcher } from "./gateway-question-dispatch.js";
import {
  claimPendingAgentQuestionAnswer,
  claimPendingAgentQuestionAnswerFromCaller,
  registerPendingAgentQuestion,
  runAgentHarnessGatewayQuestion,
} from "./gateway-question.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";
import {
  admitted,
  attempt,
  interceptMessages,
  published,
  publishPreparedHandle,
  sessionId,
  sessionKey,
} from "./tool-authority.runtime.test-support.js";

const own: ReplyToolAuthorityOverlay = {
  senderIsOwner: true,
  disableTools: false,
  traceAuthorized: false,
  messageProvider: "webchat",
};
type AdmittedContext = Awaited<ReturnType<ReturnType<typeof prepareAgentRunAdmission>["admit"]>>;
type Handle = ReturnType<typeof createEmbeddedRunHandle>;
function withAuthority<T>(
  admittedRunContext: AdmittedContext,
  run: (prepared: typeof attempt & { toolAuthorityFingerprint?: string }) => Promise<T>,
) {
  return withPreparedEmbeddedRunToolAuthority({ admittedRunContext }, attempt, undefined, run);
}

function currentTarget() {
  const target = captureCurrentReplyMessageInjectionTarget(sessionKey);
  if (!target) {
    throw new Error("Expected the direct admitted owner to be injectable");
  }
  return target;
}

async function expectBlocked(outcome: ReturnType<typeof steer>) {
  await expect(outcome).resolves.toMatchObject({
    status: "rejected",
    reason: "tool_authority_mismatch",
  });
}

async function expectQueued(outcome: ReturnType<typeof steer>) {
  await expect(outcome).resolves.toMatchObject({ status: "accepted" });
}

function pendingQuestion(
  questionId: string,
  gatewayCall: Parameters<typeof registerPendingAgentQuestion>[0]["gatewayCall"],
) {
  const question = registerPendingAgentQuestion({
    questionId,
    sessionKey,
    gatewayCall,
    questions: [{ id: "choice", header: "Choice", question: "Continue?" }],
    answer: Promise.resolve({ status: "pending" }),
  });
  question.attachRegistration(Promise.resolve({ id: questionId }));
  return question;
}

function registerHandle(handle: Handle) {
  setActiveEmbeddedRun(sessionId, handle, sessionKey, attempt.sessionFile);
}

function fingerprintFor(
  run: { config?: OpenClawConfig; runtimePolicySessionKey?: string } = {},
  toolsAllow?: string[],
) {
  return resolveFollowupRunToolAuthorityFingerprintAsync({
    toolsAllow,
    run: {
      ...attempt,
      model: attempt.modelId,
      runtimePolicySessionKey: attempt.sandboxSessionKey,
      ...run,
    },
  });
}

function inAuthority<T>(run: (context: AdmittedContext) => Promise<T>) {
  return admitted(({ admittedRunContext }) =>
    withAuthority(admittedRunContext, () => run(admittedRunContext)),
  );
}

function questionAnswer(caller?: ReplyToolAuthorityOverlay) {
  const input = { sessionKey, text: "Continue" };
  return caller
    ? claimPendingAgentQuestionAnswerFromCaller({ ...input, caller, assertSourceCurrent() {} })
    : claimPendingAgentQuestionAnswer(input);
}

function voiceControl(
  getToolAuthorityOverlay?: Parameters<
    typeof controlRealtimeVoiceAgentRun
  >[0]["getToolAuthorityOverlay"],
  text = "Use the release branch",
) {
  return controlRealtimeVoiceAgentRun({ sessionKey, text, getToolAuthorityOverlay });
}

function inject(
  overlay: ReplyToolAuthorityOverlay,
  options: Omit<
    NonNullable<Parameters<typeof beginReplyMessageInjectionTarget>[2]>,
    "isInboundUserMessage" | "toolAuthorityOverlay"
  > = {},
) {
  return beginReplyMessageInjectionTarget(currentTarget(), "Apply the correction", {
    isInboundUserMessage: true,
    toolAuthorityOverlay: overlay,
    ...options,
  });
}

/** Lost owner authority fails closed by throwing; the test records it as a refusal. */
function steer(overlay: ReplyToolAuthorityOverlay, hash?: string) {
  return steerTestSessionTurn(sessionId, "Use the release branch", {
    isInboundUserMessage: true,
    toolAuthorityOverlay: overlay,
    toolAuthorityFingerprint: hash,
    taskSuggestionDeliveryMode: undefined,
  }).catch((error: unknown) => ({ status: "refused" as const, error }));
}

afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetSessionControllerForTest();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

describe("host-prepared embedded tool authority", () => {
  it.each([
    { change: "trace-only", outcome: { status: "accepted" } },
    { change: "result-required", outcome: { status: "accepted" } },
    { change: "permissions", outcome: { status: "rejected", reason: "tool_authority_mismatch" } },
    {
      change: "optional-reply",
      outcome: { status: "rejected", reason: "reply_expectation_mismatch" },
    },
    { change: "audio", outcome: { status: "rejected", reason: "audio_input_unsupported" } },
    { change: "audio-media", outcome: { status: "rejected", reason: "audio_input_unsupported" } },
  ] as const)("keeps the direct owner's $change input contract", ({ change, outcome }) =>
    published(async ({ handle, queue }) => {
      handle.supportsTranscriptCommitWait = true;
      handle.terminalReplyExpectation =
        change === "optional-reply"
          ? "optional"
          : change === "result-required"
            ? "result-required"
            : "required";
      expect(currentTarget()).toBeDefined();
      expect(getSessionControllerOperation(sessionKey)).toBeDefined();

      const injection = await inject(
        {
          ...own,
          traceAuthorized: true,
          disableTools: change === "permissions",
        },
        {
          inboundAudio: change === "audio",
          media: change === "audio-media" ? [{ contentType: "audio/ogg" }] : undefined,
        },
      );
      await expect(injection.outcome).resolves.toMatchObject(outcome);
      expect(queue).toHaveBeenCalledTimes(outcome.status === "accepted" ? 1 : 0);
    }),
  );

  it.each(["native input", "question answer"] as const)(
    "keeps captured authority when another store reuses the session ID (%s)",
    async (kind) => {
      await published(async ({ handle, queue }) => {
        const target = currentTarget();
        const other = createReplyOperation({
          sessionId,
          sessionKey,
          resetTriggered: false,
          target: captureSessionTarget({
            storeScope: "/stores/other-authority.sqlite",
            sessionKey,
            incarnation: sessionId,
          }),
        });
        let question: ReturnType<typeof registerPendingAgentQuestion> | undefined;
        try {
          if (kind === "native input") {
            const injection = await beginReplyMessageInjectionTarget(
              target,
              "Apply the correction",
              { isInboundUserMessage: true, toolAuthorityOverlay: own },
            );
            await expect(injection.outcome).resolves.toMatchObject({ status: "accepted" });
            detachActiveEmbeddedRun(sessionId, handle, sessionKey, attempt.sessionFile);
            const detached = await beginReplyMessageInjectionTarget(
              target,
              "Do not send to the detached attempt",
              { isInboundUserMessage: true, toolAuthorityOverlay: own },
            );
            await expect(detached.outcome).resolves.toMatchObject({
              status: "rejected",
              reason: "no_active_run",
            });
            expect(queue).toHaveBeenCalledOnce();
          } else {
            const dispatch = vi.fn<AgentQuestionDispatcher["call"]>(async ({ authority }) => {
              if (authority.kind === "source-bound") {
                authority.assertCurrent();
              }
              return { status: "answered" };
            });
            question = pendingQuestion("shared-session-id-question", {
              version: 2,
              call: dispatch,
            });
            await expect(questionAnswer(own)).resolves.toBe(true);
            expect(dispatch).toHaveBeenCalledOnce();
            expect(queue).not.toHaveBeenCalled();
          }
          expect(other.abortSignal.aborted).toBe(false);
          expect(other.result).toBeNull();
        } finally {
          question?.dispose();
          other.complete();
        }
      });
    },
  );

  it.each(["guarded injection", "transcript commitment"] as const)(
    "refuses source-bound direct input when the backend loses %s support",
    async (capability) => {
      await published(async ({ handle, queue }) => {
        const source = new AbortController();
        const target = captureCurrentReplyMessageInjectionTarget(sessionKey);
        if (!target) {
          throw new Error("Expected the direct admitted owner to be injectable");
        }
        if (capability === "guarded injection") {
          delete handle.messageInjectionV2;
        } else {
          handle.supportsTranscriptCommitWait = false;
        }
        const injection = await beginReplyMessageInjectionTarget(target, "Apply the correction", {
          isInboundUserMessage: true,
          waitForTranscriptCommit: capability === "transcript commitment",
          toolAuthorityOverlay: own,
          assertCurrent: () => source.signal.throwIfAborted(),
        });
        await expect(injection.outcome).resolves.toMatchObject({
          status: "rejected",
          reason:
            capability === "guarded injection"
              ? "guarded_injection_unsupported"
              : "transcript_commit_wait_unsupported",
        });
        expect(queue).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["replacement", "closed-admission", "lifecycle-rotation"] as const)(
    "refuses a captured direct target after %s during runtime preparation",
    (transition) =>
      published(async ({ handle, queue, close }) => {
        const entered = createDeferred();
        const release = createDeferred();
        handle.supportsTranscriptCommitWait = true;
        interceptMessages(handle, async (text, options, assertCurrent) => {
          entered.resolve();
          await release.promise;
          assertCurrent();
          return queue(text, options);
        });
        const pending = await inject(own, { assertCurrent: () => {} });
        await entered.promise;
        if (transition === "closed-admission") {
          close();
        } else if (transition === "lifecycle-rotation") {
          rotateAgentEventLifecycleGeneration();
        } else {
          registerHandle({ ...handle });
        }
        release.resolve();
        await expect(pending.outcome).resolves.toMatchObject({ status: "failed" });
        expect(queue).not.toHaveBeenCalled();
      }),
  );

  it("publishes keyed native runs only from an admitted controller turn", async () => {
    const params = {
      ...attempt,
      agentId: "ops",
      sessionKey: "global",
      sandboxSessionKey: "global",
    };
    const handle = createEmbeddedRunHandle({ runId: params.runId });
    const state = (agentId: string) =>
      resolveSessionRunProgressState(params.sessionId, {
        agentId,
        defaultAgentId: "main",
      });
    const admission = prepareAgentRunAdmission({
      cfg: { agents: { entries: { main: {}, ops: {} } } },
      operationalRunInstance: createOperationalRunInstanceRef(params.runId),
      facts: {
        agentId: params.agentId,
        runId: params.runId,
        ingress: { kind: "system", state: "present", boundary: "tool-authority-test" },
      },
    });
    try {
      await withGatewayToolCallerIdentity({ agentId: "ops", sessionKey: "global" }, () => {
        expect(() =>
          publishActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile),
        ).toThrow(SessionControllerAdmissionRequiredError);
        expect(state("ops")).toBeUndefined();
      });
      clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
      const admittedRunContext = await admission.admit("embedded", "authority-test");
      await withPreparedEmbeddedRunToolAuthority(
        { admittedRunContext },
        params,
        undefined,
        async (prepared) => {
          handle.toolAuthorityFingerprint = prepared.toolAuthorityFingerprint;
          publishActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
          expect(state("ops")).toBe("running");
          expect(state("main")).toBeUndefined();
        },
      );
      expect(state("ops")).toBeUndefined();
      expect(state("main")).toBeUndefined();
    } finally {
      clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
      admission.close();
    }
  });

  it.each(["claim", "wrapper", "lifecycle", "persistence"] as const)(
    "refuses early native-question answers after creator %s closure",
    (closure) =>
      admitted(async ({ admittedRunContext, close }) => {
        const gatewayCall = vi.fn(async () => ({ status: "answered" }));
        let question: ReturnType<typeof registerPendingAgentQuestion> | undefined;
        const answer = () =>
          claimPendingAgentQuestionAnswer({
            sessionKey,
            text: "Continue",
            persist: async () => {
              if (closure === "persistence") {
                close();
              }
            },
          });
        try {
          await withAuthority(admittedRunContext, async () => {
            // Native callbacks can ask before publishing an embedded queue handle.
            question = pendingQuestion("early-native-question", gatewayCall);
            if (closure === "wrapper") {
              return;
            }
            if (closure === "claim") {
              close();
            } else if (closure === "lifecycle") {
              rotateAgentEventLifecycleGeneration();
            }
            await expect(answer()).rejects.toThrow("no longer active");
          });
          if (closure === "wrapper") {
            await expect(answer()).rejects.toThrow("no longer active");
          }
          expect(gatewayCall).not.toHaveBeenCalled();
        } finally {
          question?.dispose();
        }
      }),
  );

  it.each(["native", "secret"])(
    "checks %s question caller policy without a published handle",
    (kind) =>
      inAuthority(async () => {
        const dispatch = vi.fn<AgentQuestionDispatcher["call"]>(async ({ authority }) => {
          if (authority.kind === "source-bound") {
            authority.assertCurrent();
          }
          return { status: "answered" };
        });
        const controller = new AbortController();
        const pending =
          kind === "secret"
            ? runAgentHarnessGatewayQuestion({
                sessionKey,
                timeoutMs: 1_000,
                delivery: {},
                signal: controller.signal,
                questions: [
                  { id: "choice", header: "Choice", question: "Secret input?", isSecret: true },
                ],
              })
            : undefined;
        const question =
          kind === "native"
            ? pendingQuestion("early-caller-policy", { version: 2, call: dispatch })
            : undefined;
        const source = vi.fn();
        const answer = (caller: ReplyToolAuthorityOverlay) =>
          claimPendingAgentQuestionAnswerFromCaller({
            sessionKey,
            text: kind === "secret" ? "synthetic-input" : "Continue",
            caller,
            assertSourceCurrent: source,
          });
        try {
          await expect(answer({ ...own, toolsAllow: [] })).rejects.toThrow("caller policy");
          if (kind === "native") {
            await expect(answer({ ...own, permissionMode: "guarded" })).rejects.toThrow(
              "caller policy",
            );
            expect(dispatch).not.toHaveBeenCalled();
          }
          await expect(answer(own)).resolves.toBe(true);
          if (kind === "native") {
            expect(dispatch).toHaveBeenCalledOnce();
            expect(source).toHaveBeenCalled();
          } else {
            await expect(pending).resolves.toMatchObject({ status: "answered" });
          }
        } finally {
          question?.dispose();
          controller.abort();
          await pending;
        }
      }),
  );

  it("does not upgrade a legacy unbound question through the caller-gated entry", async () => {
    const gatewayCall = vi.fn(async () => ({ status: "answered" }));
    const question = pendingQuestion("legacy-unbound-question", gatewayCall);
    try {
      await expect(questionAnswer(own)).rejects.toThrow("no prepared creator authority");
      expect(gatewayCall).not.toHaveBeenCalled();
      await expect(questionAnswer()).resolves.toBe(true);
    } finally {
      question.dispose();
    }
  });

  it.each(["authorized", "revoked"])(
    "revalidates %s voice admission before room cancellation",
    async (admission) => {
      setRuntimeConfigSnapshot({});
      await published(async ({ handle }) => {
        const abort = vi.spyOn(handle, "abort");
        const validateAdmission = vi.fn(() => {
          if (admission === "revoked") {
            throw new Error("Voice admission was revoked");
          }
          return { ...own, messageProvider: "discord-voice" };
        });
        const pending = voiceControl(validateAdmission, "cancel");
        if (admission === "revoked") {
          await expect(pending).rejects.toThrow("Voice admission was revoked");
          expect(abort).not.toHaveBeenCalled();
        } else {
          await expect(pending).resolves.toMatchObject({ ok: true, aborted: true });
          expect(abort).toHaveBeenCalledOnce();
        }
        expect(validateAdmission).toHaveBeenCalledOnce();
      });
    },
  );

  it("does not retarget voice steering when caller preparation replaces the registered run", async () => {
    await published(async ({ handle, queue }) => {
      const replacementQueue = vi.fn(async () => {});
      let replacement: ReturnType<typeof createEmbeddedRunHandle> | undefined;
      try {
        await expect(
          voiceControl(() => {
            clearActiveEmbeddedRun(sessionId, handle, sessionKey);
            replacement = publishPreparedHandle(handle.toolAuthorityFingerprint, replacementQueue);
            return own;
          }),
        ).resolves.toMatchObject({ ok: false, queued: false, reason: "no_active_run" });
        expect(queue).not.toHaveBeenCalled();
        expect(replacementQueue).not.toHaveBeenCalled();
      } finally {
        if (replacement) {
          clearActiveEmbeddedRun(sessionId, replacement, sessionKey);
        }
      }
    });
  });

  it("requires voice caller evidence without audit identity and strips host evidence", async () => {
    await published(async ({ handle, queue }) => {
      expect(getGatewayToolCallerIdentity()?.executionIdentityToken).toBeUndefined();
      expect(handle.toolAuthorityFingerprint).toMatch(/^[a-f0-9]{64}$/);
      await expect(voiceControl()).resolves.toMatchObject({
        ok: false,
        active: true,
        queued: false,
        reason: "tool_authority_mismatch",
        speak: true,
      });
      expect(queue).not.toHaveBeenCalled();
      await expect(voiceControl(() => own)).resolves.toMatchObject({ ok: true, queued: true });
      expect(queue).toHaveBeenCalledOnce();
      expect(queue.mock.calls[0]?.[1]).not.toHaveProperty("toolAuthorityOverlay");
      expect(queue.mock.calls[0]?.[1]).toHaveProperty("taskSuggestionDeliveryMode", undefined);
    });
  });

  it.each<{
    name: string;
    changed: Partial<ReplyToolAuthorityOverlay>;
    config?: OpenClawConfig;
    handleChange?: "hash";
  }>([
    { name: "permission mode", changed: { permissionMode: "guarded" } },
    { name: "tool override", changed: { toolOverrides: { webSearch: false } } },
    { name: "client capabilities", changed: { clientCaps: ["task_suggestions"] } },
    { name: "tool allowlist", changed: { toolsAllow: [] } },
    {
      name: "sender policy",
      changed: { senderIsOwner: false },
      config: { tools: { toolsBySender: { "*": { allow: [] } } } },
    },
    { name: "publisher hash", changed: { toolsAllow: [] }, handleChange: "hash" },
  ])(
    "rejects mismatched $name despite a copied target hash",
    async ({ changed, config, handleChange }) => {
      await published(
        async ({ handle, queue }) => {
          if (handleChange === "hash") {
            handle.toolAuthorityFingerprint = await fingerprintFor({}, []);
          }
          await expect(
            steer({ ...own, ...changed }, handle.toolAuthorityFingerprint),
          ).resolves.toMatchObject(
            // A replaced publisher hash fails its own registration assertion closed.
            handleChange === "hash"
              ? { status: "refused" }
              : { status: "rejected", reason: "tool_authority_mismatch" },
          );
          expect(queue).not.toHaveBeenCalled();
        },
        config ? { config } : {},
      );
    },
  );

  it("rejects unadmitted native replacement without retiring the current owner", async () => {
    await published(async ({ handle, queue }) => {
      expect(() =>
        withoutGatewayToolCallerIdentity(() =>
          publishActiveEmbeddedRun(sessionId, { ...handle }, sessionKey),
        ),
      ).toThrow(SessionControllerAdmissionRequiredError);
      await expect(steer(own, handle.toolAuthorityFingerprint)).resolves.toMatchObject({
        status: "accepted",
      });
      expect(queue).toHaveBeenCalledOnce();
    });
  });

  it("uses concrete modelId and sandbox key, not the descriptor or execution key", async () => {
    await admitted(async ({ admittedRunContext }) => {
      const direct = {
        ...attempt,
        model: { id: "descriptor-only" },
        sandboxSessionKey: "agent:main:voice",
        config: { agents: { defaults: { sandbox: { mode: "non-main" as const } } } },
      };
      const expected = await fingerprintFor({
        config: direct.config,
        runtimePolicySessionKey: direct.sandboxSessionKey,
      });
      await withPreparedEmbeddedRunToolAuthority(
        { admittedRunContext },
        direct,
        undefined,
        async (prepared) => {
          expect(prepared.toolAuthorityFingerprint).toBe(expected);
          expect(prepared.toolAuthorityFingerprint).not.toBe(
            await fingerprintFor({ config: direct.config, runtimePolicySessionKey: sessionKey }),
          );
        },
      );
    });
  });

  it.each(["false", "throw", "replacement"])(
    "revalidates captured authority after policy projection (%s)",
    (failure) =>
      admitted(async ({ admittedRunContext }) => {
        let live = true;
        const successorQueue = vi.fn(async () => {});
        await withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey,
            operationalRunInstance: admittedRunContext.operationalRunInstance,
            receiptAuthority: () => {
              if (!live && failure === "throw") {
                throw new Error("closed source");
              }
              return live;
            },
          },
          () =>
            withAuthority(admittedRunContext, async (prepared) => {
              const queue = vi.fn(async () => {});
              publishPreparedHandle(prepared.toolAuthorityFingerprint, queue);
              const outcome = await steer({
                ...own,
                get permissionMode() {
                  if (failure === "replacement") {
                    withoutGatewayToolCallerIdentity(() =>
                      setActiveEmbeddedRun(
                        sessionId,
                        createEmbeddedRunHandle({
                          runId: "successor",
                          queueMessage: successorQueue,
                        }),
                        sessionKey,
                      ),
                    );
                  } else {
                    live = false;
                  }
                  return undefined;
                },
              });
              // A replaced owner rejects; a lost source fails the projection closed.
              expect(outcome.status).toBe(failure === "replacement" ? "rejected" : "refused");
              expect(successorQueue).not.toHaveBeenCalled();
              expect(queue).not.toHaveBeenCalled();
            }),
        );
      }),
  );

  it("preserves hidden allowlist intersections and freezes the prepared policy", async () => {
    const toolsAllow = attachToolAllowlistIntersection(["exec"], [["exec"]]);
    await published(
      async ({ queue }) => {
        toolsAllow.push("message");
        await expectQueued(
          steer({ ...own, toolsAllow: attachToolAllowlistIntersection(["exec"], [["exec"]]) }),
        );
        await expectBlocked(
          steer({
            ...own,
            toolsAllow: attachToolAllowlistIntersection(["exec"], [["exec"], ["message"]]),
          }),
        );
        expect(queue).toHaveBeenCalledOnce();
      },
      { toolsAllow },
    );
  });

  it.each(["claim", "wrapper", "lifecycle"])(
    "rejects retained projection after %s closure",
    (reason) =>
      admitted(async ({ admittedRunContext, close }) => {
        const queue = vi.fn(async () => {});
        let retained: ReturnType<typeof getGatewayToolCallerIdentity>;
        await withAuthority(admittedRunContext, async (prepared) => {
          retained = getGatewayToolCallerIdentity();
          publishPreparedHandle(prepared.toolAuthorityFingerprint, queue);
          if (reason === "claim") {
            close();
          }
          if (reason === "lifecycle") {
            rotateAgentEventLifecycleGeneration();
          }
          if (reason !== "wrapper") {
            expect((await steer(own)).status).not.toBe("accepted");
          }
        });
        expect((await steer(own)).status).toBe("rejected");
        await expect(
          withGatewayToolCallerIdentity(retained, () =>
            publishActiveEmbeddedRun(
              sessionId,
              createEmbeddedRunHandle({ runId: attempt.runId }),
              sessionKey,
              attempt.sessionFile,
            ),
          ),
        ).rejects.toThrow("no longer active");
        expect(queue).not.toHaveBeenCalled();
      }),
  );

  it("does not inherit a registration binding into a distinct admitted instance", async () => {
    await inAuthority(async (admittedRunContext) => {
      const current = getGatewayToolCallerIdentity();
      expect(current?.embeddedRunToolAuthorityBinding).toBeTypeOf("function");
      await withGatewayToolCallerIdentity({ agentId: "main", sessionKey }, () => {
        expect(getGatewayToolCallerIdentity()?.embeddedRunToolAuthorityBinding).toBe(
          current?.embeddedRunToolAuthorityBinding,
        );
      });
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey,
          operationalRunInstance: { ...admittedRunContext.operationalRunInstance },
        },
        () => {
          expect(getGatewayToolCallerIdentity()?.embeddedRunToolAuthorityBinding).toBeUndefined();
        },
      );
    });
  });

  it("publishes maintenance authority without borrowing a lifecycle-only reply snapshot", async () => {
    await admitted(async ({ admittedRunContext, close }) => {
      const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
      const parent = createQueueTestRun({ prompt: "parent reply" });
      parent.run.traceAuthorized = true;
      await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(parent));
      try {
        await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext, replyOperation: operation },
          { ...attempt, toolsAllow: [] },
          undefined,
          async (prepared) => {
            const queue = vi.fn(async () => {});
            publishPreparedHandle(prepared.toolAuthorityFingerprint, queue);
            await expect(steer(own)).resolves.toMatchObject({
              status: "rejected",
              reason: "tool_authority_mismatch",
            });
            await expect(steer({ ...own, toolsAllow: [] })).resolves.toMatchObject({
              status: "accepted",
            });
            close();
            await expect(
              steerTestSessionTurn(sessionId, "Use the release branch", {
                isInboundUserMessage: true,
                toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
              }),
            ).rejects.toThrow("admitted run authority is no longer active");
            expect(queue).toHaveBeenCalledOnce();
          },
        );
      } finally {
        operation.complete();
      }
    });
  });

  it.each(["candidate", "prepared-model", "unprepared"])(
    "keeps a normal reply's richer snapshot when the route is chosen at %s",
    async (selectionPhase) => {
      await admitted(async ({ admittedRunContext }) => {
        const original = createQueueTestRun({ prompt: "normal reply" });
        original.run.traceAuthorized = true;
        original.run.clientCaps = ["normal-client"];
        original.run.approvalReviewerDeviceId = "review-device";
        const route = { provider: "anthropic", model: "fallback-test" };
        const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
        const snapshot = prepareReplyToolAuthority(original);
        let failProjection = false;
        await operation.bindToolAuthoritySnapshotAsync({
          ...snapshot,
          project: (overlay, selectedRoute) => {
            if (failProjection) {
              throw new Error("projection failed");
            }
            return snapshot.project(overlay, selectedRoute);
          },
          projectAsync: async (overlay, selectedRoute) => {
            if (failProjection) {
              throw new Error("projection failed");
            }
            return snapshot.projectAsync(overlay, selectedRoute);
          },
        });
        const initialRoute =
          selectionPhase === "candidate"
            ? route
            : { provider: original.run.provider, model: original.run.model };
        if (selectionPhase !== "unprepared") {
          operation.bindToolAuthorityRoute(initialRoute);
        }
        const initialFingerprint = snapshot.fingerprint(initialRoute);
        const fingerprint = snapshot.fingerprint(route);
        await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext, replyOperation: operation },
          {
            ...attempt,
            provider: route.provider,
            modelId: route.model,
            toolAuthorityFingerprint: initialFingerprint,
          },
          undefined,
          async (prepared) => {
            const queue = vi.fn(async () => {});
            const handle = {
              ...createEmbeddedRunHandle({
                runId: attempt.runId,
                toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
                queueMessage: queue,
                guarded: true,
              }),
              kind: "embedded" as const,
              cancel: () => {},
            };
            setActiveEmbeddedRun(sessionId, handle, sessionKey, attempt.sessionFile);
            const incoming = {
              senderIsOwner: false,
              disableTools: false,
              traceAuthorized: true,
              clientCaps: ["normal-client"],
              approvalReviewerDeviceId: "review-device",
            };
            await expect(steer({ ...incoming, traceAuthorized: false })).resolves.toMatchObject({
              status: "rejected",
              reason: "tool_authority_mismatch",
            });
            expect(queue).not.toHaveBeenCalled();
            await expect(steer(incoming)).resolves.toMatchObject({ status: "accepted" });
            expect(prepared.toolAuthorityFingerprint).toBe(fingerprint);
            await expect(
              steer({
                ...incoming,
                get permissionMode() {
                  operation.attachBackend({ ...handle });
                  return undefined;
                },
              }),
            ).resolves.toMatchObject({ status: "rejected", reason: "no_active_run" });
            setActiveEmbeddedRun(sessionId, handle, sessionKey, attempt.sessionFile);
            failProjection = true;
            await expect(steer(incoming, fingerprint)).resolves.toMatchObject({
              status: "rejected",
              reason: "tool_authority_mismatch",
            });
            failProjection = false;
            operation.bindToolAuthorityRoute({ provider: "openai", model: "replacement-route" });
            await expect(steer(incoming, fingerprint)).resolves.toMatchObject({
              status: "rejected",
              reason: "tool_authority_mismatch",
            });
            operation.bindToolAuthorityRoute(route);
            const target = currentTarget();
            operation.attachBackend({ ...handle });
            // Replacing the backend retires the previously captured target.
            const injection = await beginReplyMessageInjectionTarget(
              target,
              "Use the release branch",
              {
                isInboundUserMessage: true,
                toolAuthorityOverlay: incoming,
              },
            );
            await expect(injection.outcome).resolves.toMatchObject({
              status: "rejected",
              reason: "no_active_run",
            });
            expect(queue).toHaveBeenCalledOnce();
          },
        );
        operation.complete();
      });
    },
  );
});
