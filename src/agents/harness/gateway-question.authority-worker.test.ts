import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as sessionReads from "../../config/sessions/session-entry-read-runtime.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import { QuestionManager } from "../../gateway/question-manager.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { createQuestionHandlers } from "../../gateway/server-methods/question.js";
import { createSecretStoreWriteService } from "../../gateway/server-methods/secrets.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
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
    (["current", "foreign-policy", "creator-closed"] as const).map((change) => ({ path, change })),
  ),
  ...(["legacy-run", "custom-run"] as const).flatMap((path) =>
    (["current", "persist-policy", "persist-generation"] as const).map((change) => ({
      path,
      change,
    })),
  ),
])("rechecks $change authority for $path at the question effect", async ({ path, change }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionKey = "agent:main:question-execution";
    const policyKey = "agent:policy:question-policy";
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
    await upsertSessionEntryCore(
      { agentId: "policy", sessionKey: policyKey },
      {
        sessionId: "policy-session",
        lifecycleRevision: "policy-generation",
        updatedAt: 1,
        sandboxMode: "off",
      },
    );
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
    const authority = createAgentQuestionAnswerAuthority({
      sessionKey,
      fingerprint,
      project: (caller) => snapshot.project(caller, run.run),
      prepareCaller: async (caller) =>
        prepareReplyToolAuthorityCallerRead(
          snapshot.projectAsync,
          caller,
          fingerprint,
          run.run,
          assertCurrent,
        ),
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
      createGatewayMethodRegistry(
        Object.entries(handlers).map(([name, handler]) => ({
          name,
          handler,
          scope: "operator.questions",
          owner: { kind: "core", area: "questions" },
        })),
      );
    manager.request({
      id: "caller-policy-question",
      sessionKey,
      timeoutMs: 60_000,
      questions: [
        {
          questionId: "answer",
          header: "Answer",
          question: "Continue?",
          options: [],
          isOther: true,
        },
      ],
    });
    const compatibility = path === "legacy-run" || path === "custom-run";
    const question = withAgentQuestionAnswerAuthority(authority, () =>
      registerPendingAgentQuestion({
        questionId: "caller-policy-question",
        sessionKey,
        questions: [
          { id: "answer", header: "Answer", question: "Continue?", options: [], isOther: true },
        ],
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
        answer: manager.waitAnswer("caller-policy-question", undefined, true),
      }),
    );
    question.attachRegistration(Promise.resolve());
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const originalRead = sessionReads.withSessionEntriesFromStoresInWorker;
    let hold = true;
    const readBatches = vi
      .spyOn(sessionReads, "withSessionEntriesFromStoresInWorker")
      .mockImplementation(async (inputs, consume, options) => {
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
      });
    const caller = {
      senderIsOwner: run.run.senderIsOwner === true,
      disableTools: run.disableTools === true,
      traceAuthorized: run.run.traceAuthorized === true,
    };
    const preparation = bindWorkerToolPreparation({
      assertCurrent,
      compatAssertCurrent: () => authority.assertCaller(caller),
      prepareCurrent: async () => {
        const read = await prepareReplyToolAuthorityCallerRead(
          snapshot.projectAsync,
          caller,
          fingerprint,
          run.run,
          assertCurrent,
        );
        await read!.prepareCurrent();
      },
    });
    const inputAuthority = {
      kind: compatibility ? ("run" as const) : ("source-bound" as const),
      assertCurrent,
      toolAuthorityPreparation: preparation,
    };
    const revokePolicy = () =>
      // Setup starts worker maintenance; share its writer lane without publishing the mutation.
      runOpenClawAgentWriteAdmission({ agentId: "policy", env: state.env }, ({ canonicalPath }) => {
        const peer = new DatabaseSync(canonicalPath);
        try {
          peer
            .prepare(
              "UPDATE session_nodes SET entry_json = json_remove(entry_json, '$.sandboxMode') WHERE session_key = ?",
            )
            .run(policyKey);
        } finally {
          peer.close();
        }
      });
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
                      await replaceSessionEntry(
                        { agentId: "policy", sessionKey: policyKey },
                        {
                          sessionId: "policy-session",
                          lifecycleRevision:
                            change === "persist-generation"
                              ? "replacement-generation"
                              : "policy-generation",
                          updatedAt: 1,
                          sandboxMode: change === "persist-generation" ? "off" : undefined,
                        },
                      );
                      if (change === "persist-generation") {
                        expect(snapshot.project(caller, run.run)).toBe(fingerprint);
                      } else {
                        expect(snapshot.project(caller, run.run)).not.toBe(fingerprint);
                      }
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
          pending.then((accepted) => {
            throw new Error(
              `question claim settled before final read: ${JSON.stringify({ accepted, status: manager.observe("caller-policy-question")?.record.status, handlerCalls: resolveQuestion.mock.calls.length, readKeys: readBatches.mock.calls.map(([inputs]) => inputs.map((input) => input.sessionKeys)) })}`,
            );
          }),
          "question did not reach its final session read",
        );
      }
      if (change === "foreign-policy") {
        await revokePolicy();
      } else if (change === "creator-closed") {
        controller.abort(new Error("question creator closed during final read"));
      }
      const sql = observeHostDataSql();
      try {
        resume.resolve();
        const result = await settled;
        if (change === "current") {
          expect(result).toBe(true);
        } else {
          expect(result).toBeInstanceOf(QuestionDispatchRefusedError);
        }
        expect(manager.get("caller-policy-question")?.status).toBe(
          change === "current"
            ? path === "prepared-cancel"
              ? "cancelled"
              : "answered"
            : "pending",
        );
        if (compatibility) {
          expect(resolveQuestion).toHaveBeenCalledTimes(change === "current" ? 1 : 0);
        } else {
          expect(
            sql.queries.filter((query) => /\bsession_(?:nodes|participants|windows)\b/.test(query)),
          ).toEqual([]);
        }
      } finally {
        sql.restore();
      }
    } finally {
      resume.resolve();
      await settled;
      question.dispose();
      manager.close();
      await manager.drain();
    }
  });
});
