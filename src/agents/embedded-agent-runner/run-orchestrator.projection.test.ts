import fs from "node:fs/promises";
import path from "node:path";
import { getAiTransportHost } from "@openclaw/ai";
import { streamOpenAIResponses } from "@openclaw/ai/internal/openai";
import type { Message } from "@openclaw/llm-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runAgentLoopContinue } from "../../../packages/agent-core/src/agent-loop.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  persistSessionTranscriptTurn,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import * as reconciliation from "../../config/sessions/session-transcript-reconcile.js";
import { useReconcileWorkerObserver } from "../../config/sessions/session-transcript-reconcile.test-support.js";
import type { SessionTranscriptReconcileWorkerMessage } from "../../config/sessions/session-transcript-reconcile.worker.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { SessionManager } from "../sessions/session-manager.js";
import {
  buildEmbeddedRunnerAssistant,
  createEmbeddedAgentRunnerOpenAiConfig,
  createResolvedEmbeddedRunnerModel,
  immediateEnqueue,
  makeEmbeddedRunnerAttempt,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "../test-helpers/embedded-agent-runner-e2e-mocks.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./run/types.js";

vi.mock("node:worker_threads", async () =>
  (
    await import("../../config/sessions/session-transcript-reconcile.test-support.js")
  ).createObservedWorkerThreads(),
);

const observer = useReconcileWorkerObserver();
const tempRoots = createTempDirTracker();
const runAttempt = vi.fn<(params: EmbeddedRunAttemptParams) => Promise<EmbeddedRunAttemptResult>>();
type ProductionRun = typeof import("./run.js").runEmbeddedAgent;
let runEmbeddedAgent: ProductionRun;

beforeAll(async () => {
  installEmbeddedRunnerBaseE2eMocks();
  installEmbeddedRunnerFastRunE2eMocks({ runEmbeddedAttempt: runAttempt });
  vi.doMock("../models-config.js", () => ({ ensureOpenClawModelsJson: vi.fn() }));
  vi.doMock("./model.js", () => ({
    resolveModelAsync: async (provider: string, modelId: string) =>
      createResolvedEmbeddedRunnerModel(provider, modelId),
  }));
  const { runEmbeddedAgent: run } = await import("./run.js");
  const { prepareSystemAgentRunAdmission } = await import("../admitted-run-context.js");
  runEmbeddedAgent = async (params) => {
    const admission = prepareSystemAgentRunAdmission(
      params.config ?? {},
      params.runId,
      params.agentId ?? "main",
      "retry-projection-test",
    );
    try {
      return await run({ ...params, preparedRunAdmission: admission });
    } finally {
      admission.close();
    }
  };
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  tempRoots.cleanup();
  runAttempt.mockReset();
});

function fenceProjection(target: SessionTranscriptRuntimeTarget) {
  const databaseOptions = { agentId: target.agentId };
  const database = openOpenClawAgentDatabase(databaseOptions);
  // Existing fault-injection pattern: the real owner must rebuild this projection.
  database.db
    .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
    .run(target.sessionId);
  const held = createDeferred();
  let releaseAcknowledgement: (() => void) | undefined;
  let released = false;
  observer.onTask = ({ input, port, observeMessage }) => {
    if (input.mode !== "disk" || input.path !== database.path) {
      return;
    }
    const postMessage = port.postMessage.bind(port);
    let startingTarget = false;
    observeMessage((message: SessionTranscriptReconcileWorkerMessage) => {
      startingTarget = message.type === "plan-start" && message.plan.sessionId === target.sessionId;
    });
    // Hold after the owner's claim, before any rebuilt projection is committed.
    port.postMessage = (message: unknown, transferList) => {
      const options = Array.isArray(transferList) ? { transfer: transferList } : transferList;
      if (startingTarget && !released) {
        startingTarget = false;
        releaseAcknowledgement = () => postMessage(message, options);
        held.resolve();
        return;
      }
      postMessage(message, options);
    };
  };
  reconciliation.startSessionTranscriptIndexReconcile({
    ...databaseOptions,
    preferredSessionId: target.sessionId,
  });
  const joined = reconciliation.waitForSessionTranscriptIndexReconcile(databaseOptions);
  return {
    held: Promise.race([
      held.promise,
      joined.then(() => {
        throw new Error("projection owner exited before its plan-start acknowledgement");
      }),
    ]),
    joined,
    expectDirty() {
      expect(reconciliation.isSessionTranscriptIndexReconcileRunning(databaseOptions)).toBe(true);
      expect(
        database.db
          .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
          .get(target.sessionId),
      ).toEqual({ needs_rebuild: 1 });
    },
    release() {
      released = true;
      releaseAcknowledgement?.();
      releaseAcknowledgement = undefined;
    },
  };
}

describe("embedded retry transcript ownership", () => {
  it.each([
    ["detached", false, "active", false, "disconnect"],
    ["detached", true, "active", false, "disconnect"],
    ["durable", true, "active", false, "disconnect"],
    ["durable", false, "active", false, "disconnect"],
    ["durable", false, "active", true, "disconnect"],
    ["detached", false, "absent", false, "disconnect"],
    ["durable", false, "idle", false, "disconnect"],
    ["detached", false, "absent", false, "output-limit"],
    ["durable", false, "active", false, "output-limit"],
  ] as const)(
    "%s metadata, caller manager=%s, projection=%s, abort=%s, failure=%s",
    async (sessionPersistence, suppliedManager, projection, abort, failure) => {
      const root = tempRoots.make("openclaw-retry-projection-");
      const stateDir = path.join(root, "state");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const workspaceDir = path.join(root, "workspace");
      const agentDir = path.join(root, "staged", "agent");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(agentDir, { recursive: true });
      const target = {
        agentId: "main",
        sessionId: "retry-projection",
        sessionKey: "agent:main:retry-projection",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      const callerOwned = suppliedManager || sessionPersistence === "detached";
      const callerManager = suppliedManager ? SessionManager.inMemory(workspaceDir) : undefined;
      const toolCalls = ["call_1", "call_2"];
      const model = {
        ...createResolvedEmbeddedRunnerModel("openai", "gpt-5.6-luna").model,
        api: "openai-responses" as const,
        input: ["text" as const],
      };
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockRejectedValue(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
      if (failure === "output-limit") {
        const item = {
          type: "function_call",
          id: "fc_unfinished",
          call_id: "unfinished",
          name: "exec",
          arguments: '{"command":',
          status: "incomplete",
        };
        const events = [
          { type: "response.output_item.added", output_index: 0, item },
          {
            type: "response.incomplete",
            response: {
              id: "response-output-limit",
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              output: [item],
              usage: { input_tokens: 440_445, output_tokens: 128_000 },
            },
          },
        ];
        fetchMock.mockResolvedValueOnce(
          new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          }),
        );
      }
      vi.spyOn(getAiTransportHost().plugin, "resolveTransportTurnState").mockReturnValue(undefined);
      vi.spyOn(getAiTransportHost(), "buildModelFetch").mockReturnValue(fetchMock);
      const history = [
        { role: "user", content: "Check the results.", timestamp: 1 },
        buildEmbeddedRunnerAssistant({
          model: model.id,
          stopReason: "toolUse",
          content: toolCalls.map((id) => ({ type: "toolCall", id, name: "exec", arguments: {} })),
        }),
        ...toolCalls.map((id) => ({
          role: "toolResult" as const,
          toolCallId: id,
          toolName: "exec",
          content: [{ type: "text" as const, text: "completed" }],
          isError: false,
          timestamp: 2,
        })),
      ] satisfies EmbeddedRunAttemptResult["messagesSnapshot"];
      const responseMessages = await runAgentLoopContinue(
        { systemPrompt: "", messages: [...history], tools: [] },
        { model, convertToLlm: (messages) => messages as Message[] },
        () => {},
        undefined,
        (_model, context, options) =>
          streamOpenAIResponses(model, context, {
            ...options,
            apiKey: "synthetic-transport-key",
          }),
      );
      const erroredAssistant = responseMessages.findLast((message) => message.role === "assistant");
      if (!erroredAssistant) {
        throw new Error("Expected the AgentCore terminal assistant message");
      }
      expect(responseMessages.some((message) => message.role === "toolResult")).toBe(false);
      expect(fetchMock).toHaveBeenCalledOnce();
      if (failure === "output-limit") {
        expect(erroredAssistant).toMatchObject({
          errorCode: "incomplete_tool_call",
          usage: { output: 128_000 },
          diagnostics: [
            expect.objectContaining({
              type: "openai_responses_terminal",
              details: expect.objectContaining({ incompleteReason: "max_output_tokens" }),
            }),
          ],
        });
      }
      history.push(erroredAssistant);
      const waiting = createDeferred();
      const secondAttempt = createDeferred();
      const waitForProjection = reconciliation.waitForSessionTranscriptProjection;
      const waitSpy = vi
        .spyOn(reconciliation, "waitForSessionTranscriptProjection")
        .mockImplementation((...args) => {
          const pending = waitForProjection(...args);
          waiting.resolve();
          return pending;
        });
      let fence: ReturnType<typeof fenceProjection> | undefined;
      let firstManager: EmbeddedRunAttemptParams["sessionManager"];
      const controller = new AbortController();
      runAttempt
        .mockImplementationOnce(async (attempt) => {
          expect(attempt).toMatchObject({ provider: model.provider, modelId: model.id });
          firstManager = attempt.sessionManager;
          if (callerOwned) {
            expect(firstManager).toBeDefined();
            expect(attempt.sessionTarget).toBeUndefined();
            if (callerManager) {
              expect(firstManager).toBe(callerManager);
            }
            for (const message of history) {
              firstManager!.appendMessage(message);
            }
          } else {
            expect(firstManager).toBeUndefined();
            expect(attempt.sessionTarget).toMatchObject(target);
          }
          if (projection === "active") {
            fence = fenceProjection(target);
            await fence.held;
            fence.expectDirty();
          }
          return makeEmbeddedRunnerAttempt({
            sessionIdUsed: target.sessionId,
            messagesSnapshot: history,
            lastAssistant: erroredAssistant,
            currentAttemptAssistant: erroredAssistant,
            toolMetas: toolCalls.map((toolCallId) => ({
              toolCallId,
              toolName: "exec",
              replaySafe: false,
            })),
            itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
          });
        })
        .mockImplementationOnce(async (attempt) => {
          secondAttempt.resolve();
          expect(attempt).toMatchObject({ provider: model.provider, modelId: model.id });
          expect(attempt.prompt).toContain(
            "Continue the current task from the existing transcript",
          );
          expect(attempt.suppressNextUserMessagePersistence).toBe(true);
          expect(attempt.skipPreparedUserTurnMessage).toBe(true);
          if (callerOwned) {
            expect(attempt.sessionManager).toBe(firstManager);
            expect(attempt.sessionTarget).toBeUndefined();
            expect(attempt.sessionManager?.buildSessionContext().messages).toEqual(history);
            fence?.expectDirty();
          } else {
            expect(attempt.sessionManager).toBeUndefined();
            expect(attempt.sessionTarget).toMatchObject(target);
            expect(SessionManager.open(target).buildSessionContext().messages).toEqual(history);
          }
          return makeEmbeddedRunnerAttempt({
            sessionIdUsed: target.sessionId,
            assistantTexts: ["Verified."],
            lastAssistant: buildEmbeddedRunnerAssistant({
              model: model.id,
              content: [{ type: "text", text: "Verified." }],
            }),
          });
        });
      let outcome: Promise<unknown> | undefined;
      try {
        if (projection !== "absent") {
          await persistSessionTranscriptTurn(target, {
            messages: history.map((message, index) => ({ eventId: `seed-${index}`, message })),
            touchSessionEntry: false,
          });
          await reconciliation.waitForSessionTranscriptIndexReconcile({ agentId: target.agentId });
        }
        outcome = runEmbeddedAgent({
          ...target,
          agentDir,
          workspaceDir,
          config: createEmbeddedAgentRunnerOpenAiConfig([model.id]),
          sessionPersistence,
          sessionManager: callerManager,
          prompt: "Check the results.",
          provider: model.provider,
          model: model.id,
          timeoutMs: 5_000,
          runId: "retry-projection-run",
          abortSignal: controller.signal,
          enqueue: immediateEnqueue,
        }).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        if (projection === "active") {
          const boundary = await Promise.race([
            waiting.promise.then(() => "projection-wait"),
            secondAttempt.promise.then(() => "second-attempt"),
            outcome.then(() => "run-ended"),
          ]);
          expect(boundary).toBe(callerOwned ? "second-attempt" : "projection-wait");
          fence!.expectDirty();
          if (!callerOwned) {
            expect(runAttempt).toHaveBeenCalledOnce();
            expect(waitSpy).toHaveBeenCalledOnce();
            if (abort) {
              controller.abort();
              await expect(outcome).resolves.toMatchObject({ error: { name: "AbortError" } });
              expect(runAttempt).toHaveBeenCalledOnce();
              fence!.expectDirty();
              return;
            }
            fence!.release();
          }
        }
        await expect(outcome).resolves.toMatchObject({
          result: { payloads: [{ text: "Verified." }] },
        });
        expect(runAttempt).toHaveBeenCalledTimes(2);
        expect(fetchMock).toHaveBeenCalledOnce();
        if (projection === "absent") {
          await expect(fs.access(path.join(stateDir, "agents"))).rejects.toThrow();
        }
      } finally {
        fence?.release();
        await outcome;
        await fence?.joined;
        await reconciliation.waitForSessionTranscriptIndexReconcilesInStateDir(stateDir);
        expect(
          reconciliation.isSessionTranscriptIndexReconcileRunning({ agentId: target.agentId }),
        ).toBe(false);
        waitSpy.mockRestore();
      }
    },
  );
});
