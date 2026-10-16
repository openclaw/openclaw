import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createPersonalToolScreenDispatcher } from "../../auto-reply/reply/personal-tool-turn.test-support.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import type { ReplyToolAuthorityOverlay } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import {
  beginReplyMessageInjectionTarget,
  createReplyOperation,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { resolveFollowupRunToolAuthorityFingerprintAsync } from "../../auto-reply/reply/reply-tool-authority.test-support.js";
import type { OpenClawConfig } from "../../config/types.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import {
  createOperationalRunInstanceRef,
  createAdmittedRunOperatorAuthority,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import {
  clearActiveEmbeddedRun,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveEmbeddedAgentSessionProgressState,
  setActiveEmbeddedRun,
} from "../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle, testing } from "../embedded-agent-runner/runs.test-support.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import { attachToolAllowlistIntersection } from "../tool-policy-shared.js";
import {
  getGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import type { AgentQuestionDispatcher } from "./gateway-question-dispatch.js";
import {
  claimPendingAgentQuestionAnswer,
  claimPendingAgentQuestionAnswerFromCaller,
  registerPendingAgentQuestion,
  runAgentHarnessGatewayQuestion,
} from "./gateway-question.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";

const sessionId = "authority-session";
const sessionKey = "agent:main:main";
const own: ReplyToolAuthorityOverlay = {
  senderIsOwner: true,
  disableTools: false,
  traceAuthorized: false,
  messageProvider: "webchat",
};
const attempt = {
  sessionId,
  sessionKey,
  runId: "authority-run",
  agentId: "main",
  config: {},
  sessionFile: "/tmp/authority-session.jsonl",
  workspaceDir: "/tmp/authority-workspace",
  provider: "openai",
  modelId: "gpt-test",
  sandboxSessionKey: sessionKey,
  senderIsOwner: true,
  messageProvider: "webchat",
  traceAuthorized: false,
};
type AdmittedContext = Awaited<ReturnType<ReturnType<typeof prepareAgentRunAdmission>["admit"]>>;
type Handle = ReturnType<typeof createEmbeddedRunHandle>;
type Queue = ReturnType<typeof vi.fn<Handle["queueMessage"]>>;
type OperatorAuthority = Parameters<typeof prepareAgentRunAdmission>[0]["operatorAuthority"];
type ReplyOperation = Parameters<typeof withPreparedEmbeddedRunToolAuthority>[0]["replyOperation"];
type AttemptOverrides = Partial<typeof attempt> & { toolAuthorityFingerprint?: string } & Pick<
    ReplyToolAuthorityOverlay,
    "toolsAllow" | "senderId" | "senderName" | "clientCaps" | "gatewayUiCommandTarget"
  >;

async function admitted<T>(
  run: (context: { admittedRunContext: AdmittedContext; close: () => void }) => Promise<T>,
  operatorAuthority?: OperatorAuthority,
) {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef(attempt.runId),
    operatorAuthority,
    facts: {
      agentId: "main",
      runId: attempt.runId,
      ingress: { kind: "system", state: "present", boundary: "tool-authority-test" },
    },
  });
  try {
    return await run({
      admittedRunContext: await admission.admit("embedded", "authority-test"),
      close: admission.close,
    });
  } finally {
    admission.close();
  }
}

function withAuthority<T>(
  admittedRunContext: AdmittedContext,
  run: (prepared: typeof attempt & { toolAuthorityFingerprint?: string }) => Promise<T>,
  params: AttemptOverrides = {},
  replyOperation?: ReplyOperation,
) {
  return withPreparedEmbeddedRunToolAuthority(
    { admittedRunContext, replyOperation },
    { ...attempt, ...params },
    undefined,
    run,
  );
}

function currentTarget() {
  const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey);
  if (!target) {
    throw new Error("Expected the direct admitted owner to be injectable");
  }
  return target;
}

function forwardMessages(handle: Handle, queue: Queue) {
  interceptMessages(handle, (text, options) => queue(text, options));
}

function interceptMessages(
  handle: Handle,
  receive: NonNullable<Handle["messageInjectionV2"]>["queueMessage"],
) {
  handle.messageInjectionV2 = {
    version: 2,
    isAvailable: () => true,
    queueMessage: async (text, options, assertCurrent, authorityKind) => {
      assertCurrent();
      return receive(text, options, assertCurrent, authorityKind);
    },
  };
}

async function expectBlocked(outcome: ReturnType<typeof steer>) {
  await expect(outcome).resolves.toMatchObject({
    queued: false,
    reason: "tool_authority_mismatch",
  });
}

async function expectQueued(outcome: ReturnType<typeof steer>) {
  await expect(outcome).resolves.toMatchObject({ queued: true });
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

function publishPreparedHandle(
  toolAuthorityFingerprint: string | undefined,
  queueMessage: Handle["queueMessage"],
) {
  const handle = createEmbeddedRunHandle({
    runId: attempt.runId,
    toolAuthorityFingerprint,
    queueMessage,
  });
  registerHandle(handle);
  return handle;
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

async function published<T>(
  run: (owner: { handle: Handle; queue: Queue; close: () => void }) => Promise<T>,
  params: AttemptOverrides = {},
  operatorAuthority?: OperatorAuthority,
  replyOperation?: ReplyOperation,
) {
  return admitted(async ({ admittedRunContext, close }) => {
    try {
      return await withAuthority(
        admittedRunContext,
        async (prepared) => {
          const queue = vi.fn<Handle["queueMessage"]>(async () => {});
          const handle = publishPreparedHandle(prepared.toolAuthorityFingerprint, queue);
          try {
            return await run({ handle, queue, close });
          } finally {
            clearActiveEmbeddedRun(sessionId, handle, sessionKey);
          }
        },
        params,
        replyOperation,
      );
    } finally {
      replyOperation?.complete();
    }
  }, operatorAuthority);
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

function steer(overlay: ReplyToolAuthorityOverlay, hash?: string) {
  return queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, "Use the release branch", {
    isInboundUserMessage: true,
    toolAuthorityOverlay: overlay,
    toolAuthorityFingerprint: hash,
    taskSuggestionDeliveryMode: undefined,
  });
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

function profile(profileId: string, senderName: string) {
  return {
    senderId: `${profileId}-sender`,
    senderName,
    clientCaps: ["ui-commands"],
    gatewayUiCommandTarget: { connId: `${profileId}-tab`, profileId },
  };
}

function expectUnavailable(
  dispatch: Awaited<ReturnType<Awaited<ReturnType<typeof createPersonalToolScreenDispatcher>>>>,
  message: ReturnType<typeof expect.stringMatching>,
) {
  expect(dispatch.respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "INVALID_REQUEST", message }),
  );
  expect(dispatch.broadcastToConnIds).not.toHaveBeenCalled();
}

afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetReplyRunRegistry();
  vi.restoreAllMocks();
});

describe("host-prepared embedded tool authority", () => {
  it("binds accepted direct-turn participants before queue settlement and releases them at close", async () => {
    const modelPolicy = prepareOperatorModelPolicy({ cfg: {}, policy: {} });
    const releaseSteerer = vi.fn();
    const retainSteerer = vi.fn(() => releaseSteerer);
    const authority = (profileId: string) =>
      createAdmittedRunOperatorAuthority({
        profileId,
        scopes: ["operator.read", "operator.write"],
        gatewayAccessGrant: null,
        modelPolicy,
        assertCurrent() {},
        ...(profileId === "bob" ? { retain: retainSteerer } : {}),
      });
    const dispatch = await createPersonalToolScreenDispatcher(["alice", "bob"]);
    const retained = await published(
      async ({ handle }) => {
        const releaseQueue = createDeferred();
        let queueReturned = false;
        handle.supportsTranscriptCommitWait = true;
        interceptMessages(handle, async (_text, options) => {
          options?.onQueueAccepted?.(true);
          await releaseQueue.promise;
          queueReturned = true;
        });
        const incoming: ReplyToolAuthorityOverlay = {
          ...own,
          ...profile("bob", "Bob"),
          operatorAuthority: authority("bob"),
        };
        let pending: Awaited<ReturnType<typeof beginReplyMessageInjectionTarget>> | undefined;
        try {
          registerHandle({ ...handle, supportsCrossProfileSteering: false });
          pending = await inject(incoming);
          await expect(pending.acceptance).resolves.toBe(false);
          await expect(pending.outcome).resolves.toMatchObject({
            status: "rejected",
            reason: "tool_authority_mismatch",
          });
          expect(
            getGatewayToolCallerIdentity()?.personalToolParticipants?.resolve()?.profileId,
          ).toBe("alice");
          expect(retainSteerer).not.toHaveBeenCalled();
          registerHandle(handle);
          expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
          pending = await inject(incoming);
          await expect(pending.acceptance).resolves.toBe(true);
          expectUnavailable(
            await dispatch(),
            expect.stringMatching(/Alice \(user: alice\)[\s\S]*Bob \(user: bob\)/),
          );
          const selected = await dispatch("bob");
          expect(selected.respond).toHaveBeenCalledWith(true, { ok: true });
          expect(selected.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
            "ui.command",
            { command: { kind: "sidebar", visible: false } },
            new Set(["bob-tab"]),
          );
          expect(queueReturned).toBe(false);
          releaseQueue.resolve();
          await expect(pending.outcome).resolves.toMatchObject({ status: "accepted" });
        } finally {
          releaseQueue.resolve();
          await pending?.outcome;
        }
        return getGatewayToolCallerIdentity();
      },
      profile("alice", "Alice"),
      authority("alice"),
    );
    expect(retainSteerer).toHaveBeenCalledOnce();
    expect(releaseSteerer).toHaveBeenCalledOnce();
    expectUnavailable(
      await withGatewayToolCallerIdentity(retained, () => dispatch("bob")),
      expect.stringContaining("turn has ended"),
    );
  });

  it.each([
    { change: "trace-only", outcome: { status: "accepted" } },
    { change: "permissions", outcome: { status: "rejected", reason: "tool_authority_mismatch" } },
    {
      change: "optional-reply",
      outcome: { status: "rejected", reason: "reply_expectation_mismatch" },
    },
    { change: "audio", outcome: { status: "rejected", reason: "audio_input_unsupported" } },
  ] as const)("keeps the direct owner's $change input contract", ({ change, outcome }) =>
    published(async ({ handle, queue }) => {
      handle.supportsTranscriptCommitWait = true;
      handle.terminalReplyExpectation = change === "optional-reply" ? "optional" : "required";
      forwardMessages(handle, queue);
      expect(currentTarget()).toBeDefined();
      expect(replyRunRegistry.get(sessionKey)).toBeUndefined();

      const injection = await inject(
        {
          ...own,
          traceAuthorized: true,
          disableTools: change === "permissions",
        },
        { inboundAudio: change === "audio" },
      );
      await expect(injection.outcome).resolves.toMatchObject(outcome);
      expect(queue).toHaveBeenCalledTimes(change === "trace-only" ? 1 : 0);
    }),
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

  it("captures only a matching admitted owner for legacy active-run registration", async () => {
    const params = {
      ...attempt,
      agentId: "ops",
      sessionKey: "global",
      sandboxSessionKey: "global",
    };
    const handle = createEmbeddedRunHandle({ runId: params.runId });
    const state = (agentId: string) =>
      resolveEmbeddedAgentSessionProgressState(params.sessionId, {
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
        setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
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
          setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
          expect(state("ops")).toBe("running");
          expect(state("main")).toBeUndefined();
        },
      );
      expect(state("ops")).toBe("running");
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
    (admission) =>
      published(async ({ handle }) => {
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
      }),
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
      forwardMessages(handle, queue);
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
    handleChange?: "hash" | "unbound";
  }>([
    { name: "permission mode", changed: { permissionMode: "guarded" } },
    { name: "tool override", changed: { toolOverrides: { webSearch: false } } },
    { name: "client capabilities", changed: { clientCaps: ["task_suggestions"] } },
    { name: "tool allowlist", changed: { toolsAllow: [] } },
    { name: "trace authority", changed: { traceAuthorized: true } },
    {
      name: "sender policy",
      changed: { senderIsOwner: false },
      config: { tools: { toolsBySender: { "*": { allow: [] } } } },
    },
    { name: "publisher hash", changed: { toolsAllow: [] }, handleChange: "hash" },
    { name: "unbound registration", changed: {}, handleChange: "unbound" },
  ])("rejects mismatched $name despite a copied target hash", ({ changed, config, handleChange }) =>
    published(
      async ({ handle, queue }) => {
        if (handleChange === "hash") {
          handle.toolAuthorityFingerprint = await fingerprintFor({}, []);
        } else if (handleChange === "unbound") {
          withoutGatewayToolCallerIdentity(() =>
            setActiveEmbeddedRun(sessionId, { ...handle }, sessionKey),
          );
        }
        await expectBlocked(steer({ ...own, ...changed }, handle.toolAuthorityFingerprint));
        expect(queue).not.toHaveBeenCalled();
      },
      config ? { config } : {},
    ),
  );

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
              expect(outcome.queued).toBe(false);
              if (failure !== "replacement") {
                expect(outcome).toMatchObject({ reason: "tool_authority_mismatch" });
              }
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
            expect((await steer(own)).queued).toBe(false);
          }
        });
        expect((await steer(own)).queued).toBe(false);
        await expect(
          withGatewayToolCallerIdentity(retained, () =>
            registerHandle(createEmbeddedRunHandle({ runId: attempt.runId })),
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
    const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
    const parent = createQueueTestRun({ prompt: "parent reply" });
    parent.run.traceAuthorized = true;
    await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(parent));
    await published(
      async ({ queue }) => {
        await expectBlocked(steer(own));
        await expectQueued(steer({ ...own, toolsAllow: [] }));
        expect(queue).toHaveBeenCalledOnce();
      },
      { toolsAllow: [] },
      undefined,
      operation,
    );
  });

  it.each(["candidate", "prepared-model", "unprepared"])(
    "keeps a normal reply's richer snapshot when the route is chosen at %s",
    async (selectionPhase) => {
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
      await published(
        async ({ handle: publishedHandle, queue }) => {
          const preparedFingerprint = publishedHandle.toolAuthorityFingerprint;
          const handle = Object.assign(publishedHandle, { kind: "embedded" as const, cancel() {} });
          operation.attachBackend(handle);
          operation.setPhase("running");
          const incoming = {
            senderIsOwner: false,
            disableTools: false,
            traceAuthorized: true,
            clientCaps: ["normal-client"],
            approvalReviewerDeviceId: "review-device",
          };
          await expectQueued(steer(incoming));
          expect(preparedFingerprint).toBe(fingerprint);
          await expectBlocked(
            steer({
              ...incoming,
              get permissionMode() {
                operation.attachBackend({ ...handle });
                return undefined;
              },
            }),
          );
          operation.attachBackend(handle);
          failProjection = true;
          await expectBlocked(steer(incoming, fingerprint));
          failProjection = false;
          operation.bindToolAuthorityRoute({ provider: "openai", model: "replacement-route" });
          await expectBlocked(steer(incoming, fingerprint));
          operation.bindToolAuthorityRoute(route);
          operation.attachBackend({ ...handle });
          // A different attached backend cannot confer authority on the published handle.
          await expectBlocked(steer(incoming));
          expect(queue).toHaveBeenCalledOnce();
        },
        {
          provider: route.provider,
          modelId: route.model,
          toolAuthorityFingerprint: initialFingerprint,
        },
        undefined,
        operation,
      );
    },
  );
});
