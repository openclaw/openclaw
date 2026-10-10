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
import {
  prepareReplyToolAuthority,
  resolveFollowupRunToolAuthorityFingerprint,
} from "../../auto-reply/reply/reply-tool-authority.js";
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

async function admitted<T>(
  run: (context: {
    admittedRunContext: Awaited<ReturnType<ReturnType<typeof prepareAgentRunAdmission>["admit"]>>;
    close: () => void;
  }) => Promise<T>,
  operatorAuthority?: Parameters<typeof prepareAgentRunAdmission>[0]["operatorAuthority"],
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

function publishPreparedHandle(
  toolAuthorityFingerprint: string | undefined,
  queueMessage: ReturnType<typeof createEmbeddedRunHandle>["queueMessage"],
) {
  const handle = createEmbeddedRunHandle({
    runId: attempt.runId,
    toolAuthorityFingerprint,
    queueMessage,
  });
  setActiveEmbeddedRun(sessionId, handle, sessionKey, attempt.sessionFile);
  return handle;
}

async function published<T>(
  run: (owner: {
    handle: ReturnType<typeof createEmbeddedRunHandle>;
    queue: ReturnType<typeof vi.fn<ReturnType<typeof createEmbeddedRunHandle>["queueMessage"]>>;
    close: () => void;
  }) => Promise<T>,
  params: Partial<typeof attempt> &
    Pick<
      ReplyToolAuthorityOverlay,
      "toolsAllow" | "senderId" | "senderName" | "clientCaps" | "gatewayUiCommandTarget"
    > = {},
  operatorAuthority?: Parameters<typeof prepareAgentRunAdmission>[0]["operatorAuthority"],
) {
  return admitted(
    async ({ admittedRunContext, close }) =>
      withPreparedEmbeddedRunToolAuthority(
        { admittedRunContext },
        { ...attempt, ...params },
        undefined,
        async (prepared) => {
          const queue = vi.fn<ReturnType<typeof createEmbeddedRunHandle>["queueMessage"]>(
            async () => {},
          );
          const handle = publishPreparedHandle(prepared.toolAuthorityFingerprint, queue);
          try {
            return await run({ handle, queue, close });
          } finally {
            clearActiveEmbeddedRun(sessionId, handle, sessionKey);
          }
        },
      ),
    operatorAuthority,
  );
}

function steer(overlay: ReplyToolAuthorityOverlay, hash?: string) {
  return queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, "Use the release branch", {
    isInboundUserMessage: true,
    toolAuthorityOverlay: overlay,
    toolAuthorityFingerprint: hash,
    taskSuggestionDeliveryMode: undefined,
  });
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
        handle.messageInjectionV2 = {
          version: 2,
          isAvailable: () => true,
          queueMessage: async (_text, options, assertCurrent) => {
            assertCurrent();
            options?.onQueueAccepted?.(true);
            await releaseQueue.promise;
            queueReturned = true;
          },
        };
        const incoming: ReplyToolAuthorityOverlay = {
          ...own,
          operatorAuthority: authority("bob"),
          senderId: "bob-sender",
          senderName: "Bob",
          clientCaps: ["ui-commands"],
          gatewayUiCommandTarget: { connId: "bob-tab", profileId: "bob" },
        };
        let pending: Awaited<ReturnType<typeof beginReplyMessageInjectionTarget>> | undefined;
        try {
          const restricted = { ...handle, supportsCrossProfileSteering: false };
          setActiveEmbeddedRun(sessionId, restricted, sessionKey, attempt.sessionFile);
          const restrictedTarget =
            replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey)!;
          pending = await beginReplyMessageInjectionTarget(restrictedTarget, "Change my view", {
            isInboundUserMessage: true,
            toolAuthorityOverlay: incoming,
          });
          await expect(pending.acceptance).resolves.toBe(false);
          await expect(pending.outcome).resolves.toMatchObject({
            status: "rejected",
            reason: "tool_authority_mismatch",
          });
          expect(
            getGatewayToolCallerIdentity()?.personalToolParticipants?.resolve()?.profileId,
          ).toBe("alice");
          expect(retainSteerer).not.toHaveBeenCalled();
          setActiveEmbeddedRun(sessionId, handle, sessionKey, attempt.sessionFile);
          const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey);
          expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
          if (!target) {
            throw new Error("Expected the direct admitted owner to be injectable");
          }
          pending = await beginReplyMessageInjectionTarget(target, "Change my view", {
            isInboundUserMessage: true,
            toolAuthorityOverlay: incoming,
          });
          await expect(pending.acceptance).resolves.toBe(true);
          const ambiguous = await dispatch();
          expect(ambiguous.respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({
              code: "INVALID_REQUEST",
              message: expect.stringMatching(/Alice \(user: alice\)[\s\S]*Bob \(user: bob\)/),
            }),
          );
          expect(ambiguous.broadcastToConnIds).not.toHaveBeenCalled();
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
      {
        senderId: "alice-sender",
        senderName: "Alice",
        clientCaps: ["ui-commands"],
        gatewayUiCommandTarget: { connId: "alice-tab", profileId: "alice" },
      },
      authority("alice"),
    );
    expect(retainSteerer).toHaveBeenCalledOnce();
    expect(releaseSteerer).toHaveBeenCalledOnce();
    const closed = await withGatewayToolCallerIdentity(retained, () => dispatch("bob"));
    expect(closed.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("turn has ended"),
      }),
    );
    expect(closed.broadcastToConnIds).not.toHaveBeenCalled();
  });

  it.each([
    { change: "trace-only", outcome: { status: "accepted" } },
    { change: "permissions", outcome: { status: "rejected", reason: "tool_authority_mismatch" } },
    {
      change: "optional-reply",
      outcome: { status: "rejected", reason: "reply_expectation_mismatch" },
    },
    { change: "audio", outcome: { status: "rejected", reason: "audio_input_unsupported" } },
  ] as const)("keeps the direct owner's $change input contract", async ({ change, outcome }) => {
    await published(async ({ handle, queue }) => {
      handle.supportsTranscriptCommitWait = true;
      handle.terminalReplyExpectation = change === "optional-reply" ? "optional" : "required";
      handle.messageInjectionV2 = {
        version: 2,
        isAvailable: () => true,
        queueMessage: async (text, options, assertCurrent) => {
          assertCurrent();
          return queue(text, options);
        },
      };
      const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey);
      expect(target).toBeDefined();
      expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
      if (!target) {
        throw new Error("Expected the direct admitted owner to be injectable");
      }
      const injection = await beginReplyMessageInjectionTarget(target, "Apply the correction", {
        isInboundUserMessage: true,
        inboundAudio: change === "audio",
        toolAuthorityOverlay: {
          ...own,
          traceAuthorized: true,
          disableTools: change === "permissions",
        },
      });
      await expect(injection.outcome).resolves.toMatchObject(outcome);
      expect(queue).toHaveBeenCalledTimes(change === "trace-only" ? 1 : 0);
    });
  });

  it.each(["replacement", "closed-admission", "lifecycle-rotation"] as const)(
    "refuses a captured direct target after %s during runtime preparation",
    async (transition) => {
      await published(async ({ handle, queue, close }) => {
        const entered = createDeferred();
        const release = createDeferred();
        handle.supportsTranscriptCommitWait = true;
        handle.messageInjectionV2 = {
          version: 2,
          isAvailable: () => true,
          queueMessage: async (text, options, assertCurrent) => {
            assertCurrent();
            entered.resolve();
            await release.promise;
            assertCurrent();
            return queue(text, options);
          },
        };
        const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey);
        if (!target) {
          throw new Error("Expected the direct admitted owner to be injectable");
        }
        const pending = await beginReplyMessageInjectionTarget(target, "Apply the correction", {
          isInboundUserMessage: true,
          toolAuthorityOverlay: own,
          assertCurrent: () => {},
        });
        await entered.promise;
        if (transition === "closed-admission") {
          close();
        } else if (transition === "lifecycle-rotation") {
          rotateAgentEventLifecycleGeneration();
        } else {
          setActiveEmbeddedRun(sessionId, { ...handle }, sessionKey, attempt.sessionFile);
        }
        release.resolve();
        await expect(pending.outcome).resolves.toMatchObject({ status: "failed" });
        expect(queue).not.toHaveBeenCalled();
      });
    },
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
    async (closure) => {
      await admitted(async ({ admittedRunContext, close }) => {
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
          await withPreparedEmbeddedRunToolAuthority(
            { admittedRunContext },
            attempt,
            undefined,
            async () => {
              // Native callbacks can ask before publishing an embedded queue handle.
              question = registerPendingAgentQuestion({
                questionId: "early-native-question",
                sessionKey,
                questions: [{ id: "choice", header: "Choice", question: "Continue?" }],
                gatewayCall,
                answer: Promise.resolve({ status: "pending" }),
              });
              question.attachRegistration(Promise.resolve({ id: "early-native-question" }));
              if (closure === "wrapper") {
                return;
              }
              if (closure === "claim") {
                close();
              } else if (closure === "lifecycle") {
                rotateAgentEventLifecycleGeneration();
              }
              await expect(answer()).rejects.toThrow("no longer active");
            },
          );
          if (closure === "wrapper") {
            await expect(answer()).rejects.toThrow("no longer active");
          }
          expect(gatewayCall).not.toHaveBeenCalled();
        } finally {
          question?.dispose();
        }
      });
    },
  );

  it.each(["native", "secret"])(
    "checks %s question caller policy without a published handle",
    async (kind) => {
      await admitted(async ({ admittedRunContext }) =>
        withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext },
          attempt,
          undefined,
          async () => {
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
                ? registerPendingAgentQuestion({
                    questionId: "early-caller-policy",
                    sessionKey,
                    questions: [{ id: "choice", header: "Choice", question: "Continue?" }],
                    gatewayCall: { version: 2, call: dispatch },
                    answer: Promise.resolve({ status: "pending" }),
                  })
                : undefined;
            question?.attachRegistration(Promise.resolve({ id: "early-caller-policy" }));
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
          },
        ),
      );
    },
  );

  it("does not upgrade a legacy unbound question through the caller-gated entry", async () => {
    const gatewayCall = vi.fn(async () => ({ status: "answered" }));
    const question = registerPendingAgentQuestion({
      questionId: "legacy-unbound-question",
      sessionKey,
      questions: [{ id: "choice", header: "Choice", question: "Continue?" }],
      gatewayCall,
      answer: Promise.resolve({ status: "pending" }),
    });
    question.attachRegistration(Promise.resolve({ id: "legacy-unbound-question" }));
    try {
      await expect(
        claimPendingAgentQuestionAnswerFromCaller({
          sessionKey,
          text: "Continue",
          caller: own,
          assertSourceCurrent: () => {},
        }),
      ).rejects.toThrow("no prepared creator authority");
      expect(gatewayCall).not.toHaveBeenCalled();
      await expect(claimPendingAgentQuestionAnswer({ sessionKey, text: "Continue" })).resolves.toBe(
        true,
      );
    } finally {
      question.dispose();
    }
  });

  it.each(["authorized", "revoked"])(
    "revalidates %s voice admission before room cancellation",
    async (admission) => {
      await published(async ({ handle }) => {
        const abort = vi.spyOn(handle, "abort");
        const validateAdmission = vi.fn(() => {
          if (admission === "revoked") {
            throw new Error("Voice admission was revoked");
          }
          return { ...own, messageProvider: "discord-voice" };
        });
        const pending = controlRealtimeVoiceAgentRun({
          sessionKey,
          text: "cancel",
          getToolAuthorityOverlay: validateAdmission,
        });
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
          controlRealtimeVoiceAgentRun({
            sessionKey,
            text: "Use the release branch",
            getToolAuthorityOverlay: () => {
              clearActiveEmbeddedRun(sessionId, handle, sessionKey);
              replacement = publishPreparedHandle(
                handle.toolAuthorityFingerprint,
                replacementQueue,
              );
              return own;
            },
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
      handle.messageInjectionV2 = {
        version: 2,
        isAvailable: () => true,
        queueMessage: async (text, options, assertCurrent) => {
          assertCurrent();
          return queue(text, options);
        },
      };
      expect(getGatewayToolCallerIdentity()?.executionIdentityToken).toBeUndefined();
      expect(handle.toolAuthorityFingerprint).toMatch(/^[a-f0-9]{64}$/);
      const input = { sessionKey, text: "Use the release branch" };
      await expect(controlRealtimeVoiceAgentRun(input)).resolves.toMatchObject({
        ok: false,
        active: true,
        queued: false,
        reason: "tool_authority_mismatch",
        speak: true,
      });
      expect(queue).not.toHaveBeenCalled();
      await expect(
        controlRealtimeVoiceAgentRun({ ...input, getToolAuthorityOverlay: () => own }),
      ).resolves.toMatchObject({ ok: true, queued: true });
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
  ])(
    "rejects mismatched $name despite a copied target hash",
    async ({ changed, config, handleChange }) => {
      await published(
        async ({ handle, queue }) => {
          if (handleChange === "hash") {
            handle.toolAuthorityFingerprint = resolveFollowupRunToolAuthorityFingerprint({
              toolsAllow: [],
              run: {
                ...attempt,
                model: attempt.modelId,
                runtimePolicySessionKey: attempt.sandboxSessionKey,
              },
            });
          } else if (handleChange === "unbound") {
            withoutGatewayToolCallerIdentity(() =>
              setActiveEmbeddedRun(sessionId, { ...handle }, sessionKey),
            );
          }
          await expect(
            steer({ ...own, ...changed }, handle.toolAuthorityFingerprint),
          ).resolves.toMatchObject({
            queued: false,
            reason: "tool_authority_mismatch",
          });
          expect(queue).not.toHaveBeenCalled();
        },
        config ? { config } : {},
      );
    },
  );

  it("uses concrete modelId and sandbox key, not the descriptor or execution key", async () => {
    await admitted(async ({ admittedRunContext }) => {
      const direct = {
        ...attempt,
        model: { id: "descriptor-only" },
        sandboxSessionKey: "agent:main:voice",
        config: { agents: { defaults: { sandbox: { mode: "non-main" as const } } } },
      };
      const expected = resolveFollowupRunToolAuthorityFingerprint({
        run: {
          ...attempt,
          config: direct.config,
          model: attempt.modelId,
          runtimePolicySessionKey: direct.sandboxSessionKey,
        },
      });
      await withPreparedEmbeddedRunToolAuthority(
        { admittedRunContext },
        direct,
        undefined,
        async (prepared) => {
          expect(prepared.toolAuthorityFingerprint).toBe(expected);
          expect(prepared.toolAuthorityFingerprint).not.toBe(
            resolveFollowupRunToolAuthorityFingerprint({
              run: {
                ...attempt,
                config: direct.config,
                model: attempt.modelId,
                runtimePolicySessionKey: sessionKey,
              },
            }),
          );
        },
      );
    });
  });

  it.each(["false", "throw", "replacement"])(
    "revalidates captured authority after policy projection (%s)",
    async (failure) => {
      await admitted(async ({ admittedRunContext }) => {
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
            withPreparedEmbeddedRunToolAuthority(
              { admittedRunContext },
              attempt,
              undefined,
              async (prepared) => {
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
              },
            ),
        );
      });
    },
  );

  it("preserves hidden allowlist intersections and freezes the prepared policy", async () => {
    const toolsAllow = attachToolAllowlistIntersection(["exec"], [["exec"]]);
    await published(
      async ({ queue }) => {
        toolsAllow.push("message");
        await expect(
          steer({ ...own, toolsAllow: attachToolAllowlistIntersection(["exec"], [["exec"]]) }),
        ).resolves.toMatchObject({ queued: true });
        await expect(
          steer({
            ...own,
            toolsAllow: attachToolAllowlistIntersection(["exec"], [["exec"], ["message"]]),
          }),
        ).resolves.toMatchObject({ queued: false, reason: "tool_authority_mismatch" });
        expect(queue).toHaveBeenCalledOnce();
      },
      { toolsAllow },
    );
  });

  it.each(["claim", "wrapper", "lifecycle"])(
    "rejects retained projection after %s closure",
    async (reason) => {
      await admitted(async ({ admittedRunContext, close }) => {
        const queue = vi.fn(async () => {});
        let retained: ReturnType<typeof getGatewayToolCallerIdentity>;
        await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext },
          attempt,
          undefined,
          async (prepared) => {
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
          },
        );
        expect((await steer(own)).queued).toBe(false);
        await expect(
          withGatewayToolCallerIdentity(retained, () =>
            setActiveEmbeddedRun(
              sessionId,
              createEmbeddedRunHandle({ runId: attempt.runId }),
              sessionKey,
              attempt.sessionFile,
            ),
          ),
        ).rejects.toThrow("no longer active");
        expect(queue).not.toHaveBeenCalled();
      });
    },
  );

  it("does not inherit a registration binding into a distinct admitted instance", async () => {
    await admitted(async ({ admittedRunContext }) =>
      withPreparedEmbeddedRunToolAuthority({ admittedRunContext }, attempt, undefined, async () => {
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
      }),
    );
  });

  it("publishes maintenance authority without borrowing a lifecycle-only reply snapshot", async () => {
    await admitted(async ({ admittedRunContext }) => {
      const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
      const parent = createQueueTestRun({ prompt: "parent reply" });
      parent.run.traceAuthorized = true;
      operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(parent));
      try {
        await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext, replyOperation: operation },
          { ...attempt, toolsAllow: [] },
          undefined,
          async (prepared) => {
            const queue = vi.fn(async () => {});
            publishPreparedHandle(prepared.toolAuthorityFingerprint, queue);
            await expect(steer(own)).resolves.toMatchObject({
              queued: false,
              reason: "tool_authority_mismatch",
            });
            await expect(steer({ ...own, toolsAllow: [] })).resolves.toMatchObject({
              queued: true,
            });
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
        operation.bindToolAuthoritySnapshot({
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
              }),
              kind: "embedded" as const,
              cancel: () => {},
            };
            setActiveEmbeddedRun(sessionId, handle, sessionKey, attempt.sessionFile);
            operation.attachBackend(handle);
            operation.setPhase("running");
            const incoming = {
              senderIsOwner: false,
              disableTools: false,
              traceAuthorized: true,
              clientCaps: ["normal-client"],
              approvalReviewerDeviceId: "review-device",
            };
            await expect(steer(incoming)).resolves.toMatchObject({ queued: true });
            expect(prepared.toolAuthorityFingerprint).toBe(fingerprint);
            await expect(
              steer({
                ...incoming,
                get permissionMode() {
                  operation.attachBackend({ ...handle });
                  return undefined;
                },
              }),
            ).resolves.toMatchObject({ queued: false, reason: "tool_authority_mismatch" });
            operation.attachBackend(handle);
            failProjection = true;
            await expect(steer(incoming, fingerprint)).resolves.toMatchObject({
              queued: false,
              reason: "tool_authority_mismatch",
            });
            failProjection = false;
            operation.bindToolAuthorityRoute({ provider: "openai", model: "replacement-route" });
            await expect(steer(incoming, fingerprint)).resolves.toMatchObject({
              queued: false,
              reason: "tool_authority_mismatch",
            });
            operation.bindToolAuthorityRoute(route);
            operation.attachBackend({ ...handle });
            // A different attached backend cannot confer authority on the published handle.
            await expect(steer(incoming)).resolves.toMatchObject({
              queued: false,
              reason: "tool_authority_mismatch",
            });
            expect(queue).toHaveBeenCalledOnce();
          },
        );
        operation.complete();
      });
    },
  );
});
