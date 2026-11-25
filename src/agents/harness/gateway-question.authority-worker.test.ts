import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import {
  createQueueTestRun,
  toolAuthorityOverlay,
} from "../../auto-reply/reply/reply-tool-authority.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  replaceSessionEntry,
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { assertNoRetainedSessionSharingReads } from "../../config/sessions/session-accessor.sqlite-diagnostics.test-support.js";
import * as sessionReads from "../../config/sessions/session-entry-read-runtime.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../../gateway/methods/registry.js";
import { QuestionManager } from "../../gateway/question-manager.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { createQuestionHandlers } from "../../gateway/server-methods/question.js";
import { createSecretStoreWriteService } from "../../gateway/server-methods/secrets.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { callGatewayTool } from "../tools/gateway.js";
import {
  QuestionDispatchRefusedError,
  type AgentQuestionDispatcher,
} from "./gateway-question-dispatch.js";
import {
  claimPendingAgentQuestionAnswerFromCaller,
  claimPendingAgentQuestionAnswer,
  cancelPendingAgentQuestionForSession,
  registerPendingAgentQuestion,
} from "./gateway-question.js";
import {
  createAgentQuestionAnswerAuthority,
  bindWorkerToolPreparation,
  prepareReplyToolAuthorityCallerRead,
  withAgentQuestionAnswerAuthority,
} from "./host-private-capabilities.js";

afterEach(() => vi.restoreAllMocks());

it("leaves image steering with its owner when there is no pending question", async () => {
  const compatibility = vi.fn(() => {
    throw new Error("question policy must not be projected for an absent question");
  });
  expect(
    await cancelPendingAgentQuestionForSession({
      sessionKey: "agent:main:no-pending-question",
      resolvedBy: "image-reply",
      authority: { kind: "source-bound", assertCurrent: compatibility },
    }),
  ).toBe(false);
  expect(compatibility).not.toHaveBeenCalled();
});

it.each([
  ...(["caller", "prepared-claim", "prepared-cancel"] as const).flatMap((path) =>
    (["current", "policy", "creator-closed"] as const).map((change) => ({ path, change })),
  ),
  ...(["legacy-run", "custom-run"] as const).flatMap((path) =>
    (["current", "persist-policy", "persist-generation"] as const).map((change) => ({
      path,
      change,
    })),
  ),
])("rechecks $change authority for $path at the question effect", async ({ path, change }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const sessionKey = "agent:main:question";
    const policyKey = "agent:policy:question";
    const id = "caller-policy-question";
    const policyTarget = { agentId: "policy", sessionKey: policyKey };
    const policyEntry = {
      sessionId: "policy-session",
      lifecycleRevision: "policy-generation",
      updatedAt: 1,
      sandboxMode: "off" as const,
    };
    const questionItem = {
      id: "answer",
      header: "Answer",
      question: "Continue?",
      options: [],
      isOther: true,
    };
    const run = createQueueTestRun({ prompt: "question" });
    const config = {
      agents: {
        entries: { main: {}, policy: {} },
        defaults: { sandbox: { mode: "all" as const } },
      },
      tools: { sandbox: { tools: { deny: ["exec"] } } },
    };
    setRuntimeConfigSnapshot(config);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: run.run.sessionId, updatedAt: 1 },
    );
    await upsertSessionEntryCore(policyTarget, policyEntry);
    Object.assign(run.run, {
      sessionKey,
      runtimePolicySessionKey: policyKey,
      agentId: "main",
      senderIsOwner: true,
      config,
    });
    const snapshot = prepareReplyToolAuthority(run);
    const fingerprint = await snapshot.fingerprintAsync(run.run);
    const controller = new AbortController();
    const assertCurrent = () => controller.signal.throwIfAborted();
    const prepareCaller = (caller: Parameters<typeof prepareReplyToolAuthorityCallerRead>[1]) =>
      prepareReplyToolAuthorityCallerRead(
        snapshot.projectAsync,
        caller,
        fingerprint,
        run.run,
        assertCurrent,
      );
    const authority = createAgentQuestionAnswerAuthority({
      sessionKey,
      fingerprint,
      project: (caller) => snapshot.project(caller, run.run),
      prepareCaller,
      assertActive: assertCurrent,
    });
    const scheduler = createTestGatewayScheduler();
    const manager = new QuestionManager(scheduler);
    const context = createDirectChatContext({
      getRuntimeConfig: () => config,
      questionManager: manager,
    });
    context.resolveGatewayContext = () => context;
    const handlers = createQuestionHandlers(
      manager,
      createSecretStoreWriteService({ reloadSecrets: async () => ({ warningCount: 0 }) }),
      scheduler,
    );
    const resolveQuestion = vi.fn(handlers["question.resolve"]!);
    handlers["question.resolve"] = resolveQuestion;
    context.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry(createCoreGatewayMethodDescriptors(handlers));
    const { id: questionId, ...wireQuestion } = questionItem;
    manager.request({
      id,
      sessionKey,
      timeoutMs: 60_000,
      questions: [{ ...wireQuestion, questionId }],
    });
    const compatibility = path === "legacy-run" || path === "custom-run";
    const question = withAgentQuestionAnswerAuthority(authority, () =>
      registerPendingAgentQuestion({
        questionId: id,
        sessionKey,
        questions: [questionItem],
        gatewayCall:
          path === "legacy-run"
            ? callGatewayTool
            : path === "custom-run"
              ? {
                  version: 2,
                  call: (request: Parameters<AgentQuestionDispatcher["call"]>[0]) =>
                    callGatewayTool(request.method, request.options, request.params),
                }
              : undefined,
        answer: manager.waitAnswer(id, undefined, true),
      }),
    );
    question.attachRegistration(Promise.resolve());
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const originalRead = sessionReads.withSessionEntriesFromStoresInWorker;
    let hold = true;
    vi.spyOn(sessionReads, "withSessionEntriesFromStoresInWorker").mockImplementation(
      async (inputs, consume, options) => {
        if (
          hold &&
          !compatibility &&
          resolveQuestion.mock.calls.length > 0 &&
          inputs.some((input) => input.sessionKeys?.includes(policyKey))
        ) {
          hold = false;
          entered.resolve();
          await resume.promise;
        }
        return originalRead(inputs, consume, options);
      },
    );
    const caller = toolAuthorityOverlay(run);
    const preparation = bindWorkerToolPreparation({
      assertCurrent,
      compatAssertCurrent: () => authority.assertCaller(caller),
      prepareCurrent: async () => {
        const read = await prepareCaller(caller);
        await read!.prepareCurrent();
      },
    });
    const inputAuthority = {
      kind: compatibility ? ("run" as const) : ("source-bound" as const),
      assertCurrent,
      toolAuthorityPreparation: preparation,
    };
    const pending = withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey, gatewayContextResolver: () => context },
      () =>
        path === "caller"
          ? claimPendingAgentQuestionAnswerFromCaller({
              sessionKey,
              text: "Continue",
              caller,
              assertSourceCurrent: assertCurrent,
            })
          : path === "prepared-claim" || compatibility
            ? claimPendingAgentQuestionAnswer({
                sessionKey,
                text: "Continue",
                authority: inputAuthority,
                persist: change.startsWith("persist-")
                  ? async () => {
                      await replaceSessionEntry(policyTarget, {
                        ...policyEntry,
                        ...(change === "persist-generation"
                          ? { lifecycleRevision: "replacement-generation" }
                          : { sandboxMode: undefined }),
                      });
                    }
                  : undefined,
              })
            : cancelPendingAgentQuestionForSession({
                sessionKey,
                resolvedBy: "image-reply",
                authority: inputAuthority,
              }),
    );
    const settled = pending.catch((error: unknown) => error);
    try {
      if (!compatibility) {
        await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "question claim settled before its final session read",
        );
      }
      if (change === "policy") {
        await updateSessionEntry(policyTarget, () => ({ sandboxMode: undefined }));
      } else if (change === "creator-closed") {
        controller.abort(new Error("question creator closed during final read"));
      }
      resume.resolve();
      expect(await settled).toEqual(
        change === "current" ? true : expect.any(QuestionDispatchRefusedError),
      );
      expect(manager.get(id)?.status).toBe(
        change === "current" ? (path === "prepared-cancel" ? "cancelled" : "answered") : "pending",
      );
    } finally {
      resume.resolve();
      await settled;
      question.dispose();
      snapshot.close();
      manager.close();
      await manager.drain();
    }
    // Non-isolated workers share retained sharing facts with the next test file.
    assertNoRetainedSessionSharingReads();
  });
});
