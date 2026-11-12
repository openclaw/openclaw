import path from "node:path";
import {
  queueAgentHarnessMessage,
  type AgentHarnessAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createMockPluginRegistry,
  initializeGlobalHookRunner,
  loadUserTurnTranscriptRecorderFactoryForTest,
  resetGlobalHookRunner,
  runInHarnessToolAuthorityForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import * as transcriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUserMessage } from "../test-support/message-fixtures.test-support.js";
import { runAgentsApiAttempt, type AgentsApiPromptHistories } from "./agentsapi-attempt.js";
import { createAttemptParams } from "./agentsapi-attempt.test-helpers.js";
import type { AgentsApiBinding } from "./agentsapi-bindings.js";
import { AgentsApiClient, type AgentsApiItem } from "./agentsapi-client.js";
import { AgentsApiMessageProjection } from "./agentsapi-messages.js";
import { recordAgentsApiNativeToolTranscript } from "./agentsapi-transcript.js";
import { createHostedSession, createTurn } from "./agentsapi.test-support.js";

const { createSession, registerRun } = vi.hoisted(() => ({
  createSession: vi.fn<typeof import("./agentsapi-session.js").createAgentsApiSession>(),
  registerRun:
    vi.fn<typeof import("openclaw/plugin-sdk/agent-harness-runtime").setActiveEmbeddedRun>(),
}));

vi.mock("./agentsapi-session.js", () => ({ createAgentsApiSession: createSession }));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    setActiveEmbeddedRun: (...args: Parameters<typeof actual.setActiveEmbeddedRun>) => {
      registerRun(...args);
      return actual.setActiveEmbeddedRun(...args);
    },
  };
});

const tempDirs = useSessionStoreTempDirs(afterAll, "agentsapi-completed-reply-");
const readItems = vi.fn<AgentsApiClient["items"]>();
const readTurn = vi.fn<AgentsApiClient["turn"]>();
const promptText = "Create an output file and summarize the result.";
const steeringText = "Use the updated result.";
const answerText = "The completed answer.";
const replyKey = "agentsapi:session-fixture:turn-fixture";
type SessionOptions = Parameters<typeof createSession>[0];
type AttemptFixture = Awaited<ReturnType<typeof createAttempt>>;
type History = Parameters<NonNullable<SessionOptions["onReconcileHistory"]>>[0];

function completedSession(
  options: SessionOptions,
  turn = completedTurn,
  item = completedItem,
  reconciliation?: {
    items?: AgentsApiItem[];
    history?: History;
  },
) {
  return {
    isAvailable: () => false,
    isSettled: () => true,
    wasSubmitted: () => true,
    queueMessage: async () => {},
    readUsageTurns: async () => [turn],
    run: async () => {
      options.onSettled?.();
      if (reconciliation?.history) {
        await options.onReconcileHistory?.(reconciliation.history);
      }
      await options.onReconcile?.(turn, reconciliation?.items ?? [item]);
      return { turn, cancelled: false, terminatedByTool: false };
    },
    close: async () => {},
    reconcileAfterClose: async () => {
      await options.onReconcile?.(turn, [item]);
      return turn;
    },
  };
}

beforeEach(() => {
  vi.spyOn(AgentsApiClient.prototype, "create").mockResolvedValue("session-fixture");
  readItems.mockReset().mockResolvedValue([completedItem]);
  readTurn.mockReset().mockResolvedValue(completedTurn);
  vi.spyOn(AgentsApiClient.prototype, "items").mockImplementation(readItems);
  vi.spyOn(AgentsApiClient.prototype, "turn").mockImplementation(readTurn);
  vi.spyOn(AgentsApiClient.prototype, "session").mockResolvedValue(hostedSession);
  createSession.mockImplementation(completedSession);
});

async function whileRunning(
  fixture: AttemptFixture,
  { failure, signal }: { failure?: Error; signal?: AbortSignal },
  run: (
    handle: Parameters<typeof registerRun>[1],
    attempt: ReturnType<AttemptFixture["run"]>,
  ) => Promise<void>,
) {
  const started = createDeferred<void>();
  const finish = createDeferred<void>();
  createSession.mockImplementationOnce((options) => ({
    ...completedSession(options),
    isAvailable: () => true,
    isSettled: () => false,
    queueMessage: async (_text, persistInput) => {
      await persistInput?.();
    },
    readUsageTurns: async () => (failure ? [] : [completedTurn]),
    reconcileAfterClose: async () => (failure ? undefined : completedTurn),
    run: async (_text, persistInput, onSubmitted) => {
      await persistInput();
      onSubmitted();
      started.resolve();
      await finish.promise;
      if (failure) {
        throw failure;
      }
      options.onSettled?.();
      return { turn: completedTurn, cancelled: false, terminatedByTool: false };
    },
  }));
  const attempt = fixture.run();
  try {
    const nativeStart = awaitGateBeforeSettlement(
      started.promise,
      attempt,
      "Attempt settled before native start",
    );
    await (signal ? withinTest(nativeStart, signal) : nativeStart);
    const handle = registerRun.mock.calls.at(-1)?.[1];
    assert(handle, "Expected the registered Agents API run");
    await run(handle, attempt);
  } finally {
    finish.resolve();
    await attempt;
  }
  return attempt;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  createSession.mockReset();
  registerRun.mockReset();
  resetGlobalHookRunner();
  clearRuntimeConfigSnapshot();
});

it("rejects unexpected remote functions before Gateway execution when forwarding is disabled", async () => {
  const fixture = await createAttempt({ forwarding: { gatewayTools: false, mcpServers: false } });
  fixture.params.disableTools = false;
  const construct = vi.spyOn(fixture.params.hostCapabilities, "createToolSurfaceAsync");
  const beforeTool = vi.spyOn(fixture.params.hostCapabilities, "runBeforeToolCall");
  const close = vi.fn(async () => {});
  createSession.mockImplementationOnce((options) => ({
    ...completedSession(options),
    close,
    run: async () => {
      await options.executeFunction!({
        type: "function_call",
        turn_id: completedTurn.id,
        call_id: "unexpected-call",
        name: "memory_search",
        arguments: { query: "must not execute" },
      });
      throw new Error("A disabled Gateway callback must not return normally");
    },
  }));
  const result = await fixture.run();
  expect(result.terminal).toMatchObject({
    kind: "failed",
    error: expect.objectContaining({
      message:
        "Agents API Gateway tool forwarding is disabled; refusing remote function call: memory_search",
    }),
  });
  expect(construct).not.toHaveBeenCalled();
  expect(beforeTool).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

describe("Agents API completed reply settlement", () => {
  it("preserves native tool ownership when another run reconciles prior turns", async () => {
    const fixture = await createAttempt();
    allowFollowup();
    const command: AgentsApiItem = {
      id: "native-command",
      type: "command_execution",
      turn_id: completedTurn.id,
      status: "completed",
      command: "printf replay-proof",
      cwd: "/workspace",
      exit_code: 0,
      output: "replay-proof",
    };
    createSession.mockImplementationOnce((options) =>
      completedSession(options, completedTurn, completedItem, { items: [command, completedItem] }),
    );
    readItems.mockResolvedValue([command, completedItem]);
    expect((await fixture.run()).terminal).toEqual({ kind: "ok" });
    const nativeRows = (await fixture.messages()).filter(isNativeCommand);
    expect(nativeRows).toHaveLength(2);
    expect(nativeRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant", __openclaw: { runId: "run-fixture" } }),
        expect.objectContaining({
          role: "toolResult",
          __openclaw: expect.objectContaining({ runId: "run-fixture" }),
        }),
      ]),
    );
    fixture.completeNext("next-openclaw-run", "Follow-up completed.", [
      { turn: completedTurn, items: [command, completedItem] },
    ]);
    const result = await fixture.run();
    expect(result.terminal).toEqual({ kind: "ok" });
    expect(result.assistantTexts).toEqual(["Follow-up completed."]);
    const messages = await fixture.messages();
    expect(messages.filter(isNativeCommand)).toEqual(nativeRows);
    expect(messages.at(-1)).toMatchObject({ __openclaw: { runId: "next-openclaw-run" } });
    await expect(
      recordAgentsApiNativeToolTranscript(
        fixture.params,
        "session-fixture",
        completedTurn.id,
        { ...command, command: "different command" },
        () => {},
        Date.now,
        { historical: true },
      ),
    ).rejects.toThrow("conflicts with the admitted message");
  });

  it("publishes exact committed item identities without acquiring a newer preview", async () => {
    const fixture = await createAttempt();
    const events = vi.fn<NonNullable<AgentHarnessAttemptParamsV2["onAgentEvent"]>>();
    const projection = new AgentsApiMessageProjection(
      fixture.params,
      "session-fixture",
      events,
      () => {},
    );
    const append = transcriptRuntime.appendSessionTranscriptMessageByIdentityStrict;
    const appending = createDeferred<void>();
    const release = createDeferred<void>();
    vi.spyOn(
      transcriptRuntime,
      "appendSessionTranscriptMessageByIdentityStrict",
    ).mockImplementation(async (params) => {
      appending.resolve();
      await release.promise;
      return append(params);
    });
    const publish = vi.spyOn(transcriptRuntime, "publishSessionTranscriptUpdateByIdentity");
    const completion = projection.commit(completedTurn, [completedItem]);
    try {
      await appending.promise;
      await projection.observe({
        type: "agent.session.turn.item.added",
        item: {
          ...completedItem,
          id: "newer-preview",
          status: "in_progress",
          content: [{ type: "output_text", text: "Still working." }],
        },
      });
      expect(events.mock.lastCall?.[0]).toMatchObject({
        stream: "assistant",
        data: {
          itemId: `${replyKey}:newer-preview`,
          text: "Still working.",
        },
      });
      release.resolve();
      await completion;

      const manager = await SessionManager.openAsync(fixture.target, fixture.params.workspaceDir);
      const saved = manager.getBranch().find((entry) => entry.type === "message");
      assert(saved?.type === "message");
      expect(saved.message).toMatchObject({ __openclaw: { runId: fixture.params.runId } });
      expect(publish).toHaveBeenCalledExactlyOnceWith({
        ...fixture.target,
        update: {
          message: saved.message,
          messageId: saved.id,
          messageSeq: 1,
          runId: fixture.params.runId,
          assistantItemIds: [`${replyKey}:answer-fixture`, `${replyKey}:reply`],
        },
      });
      expect(events.mock.lastCall?.[0]).toMatchObject({
        stream: "assistant",
        data: {
          itemId: `${replyKey}:reply`,
          text: answerText,
        },
      });
    } finally {
      release.resolve();
      await completion;
    }
  });

  it.each(["current", "cancelled", "revoked"] as const)(
    "settles the completed reply after artifact failure with %s custody",
    async (interruption) => {
      const fixture = await createAttempt();
      const failure = new Error(`fixture attempt ${interruption}`);
      vi.spyOn(AgentsApiClient.prototype, "artifacts").mockImplementation(async () => {
        if (interruption === "cancelled") {
          fixture.controller.abort(failure);
        } else if (interruption === "revoked") {
          fixture.revoke(failure);
        }
        throw failure;
      });

      const result = await fixture.run();

      expect(result).toHaveProperty(
        "terminal",
        interruption === "cancelled"
          ? { kind: "aborted", source: "external" }
          : { kind: "failed", source: "prompt", error: failure },
      );
      const persisted = await fixture.messages();
      if (interruption !== "current") {
        expect(result.assistantTexts).toEqual([]);
        expect(fixture.onPartialReply).not.toHaveBeenCalled();
        expect(persisted).toEqual([]);
        return;
      }
      expect(result).toMatchObject({
        assistantTexts: [answerText],
        assistantTranscriptOwned: true,
        assistantTranscriptIdempotencyKey: replyKey,
        currentAttemptCompletedAssistant: {
          role: "assistant",
          content: [{ type: "text", text: answerText }],
          stopReason: "stop",
        },
      });
      expect(fixture.onPartialReply).toHaveBeenCalledExactlyOnceWith({ text: answerText });
      expect(persisted).toEqual([result.currentAttemptCompletedAssistant]);
      expect(result.messagesSnapshot).toEqual(persisted);
      expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
    },
  );
});

it("rejects attachment steering without committing its recorder", async () => {
  const fixture = await createAttempt({ forwarding: { gatewayTools: false, mcpServers: false } });
  const media = [{ url: "media://inbound/brief.pdf", contentType: "application/pdf" }];
  const prompt = "Read the attached brief.";
  const recorder = await fixture.recorder(prompt, "pdf-followup", media);
  allowFollowup();
  const result = await whileRunning(fixture, {}, async (handle) => {
    await expect(
      handle.queueMessage(prompt, { media, userTurnTranscriptRecorder: recorder }),
    ).rejects.toThrow("Agents API attachments require a separate turn");
    expect(recorder.hasPersisted()).toBe(false);
  });
  expect(result.terminal).toEqual({ kind: "ok" });
});

it.for(["same run", "new run", "reset binding", "new budget", "cancelled", "revoked"] as const)(
  "handles %s after steering without widening retry prompt history",
  async (retryScope, { signal }) => {
    const fixture = await createAttempt();
    await SessionManager.open(fixture.target, fixture.params.workspaceDir).appendMessageAsync(
      makeUserMessage("Earlier request.", 1),
    );
    const foreground = await fixture.recorder(fixture.params.prompt, "foreground-user");
    await foreground.persistApproved();
    fixture.params.userTurnTranscriptRecorder = foreground;
    const steering = await fixture.recorder(steeringText, "steering-user");
    const histories: unknown[][] = [];
    const priorHistory = [userMessage("Earlier request.")];
    const admittedHistory = [...priorHistory, userMessage(promptText), userMessage(steeringText)];
    const promptHook = vi
      .fn()
      .mockImplementation((event: { messages: Array<{ content: unknown }> }) => {
        histories.push(structuredClone(event.messages));
        if (histories.length === 1) {
          event.messages[0]!.content = "Hook-only mutation.";
        }
        return { prependContext: `Attempt context ${histories.length}.` };
      });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_prompt_build", handler: promptHook }]),
    );
    allowFollowup();
    const failure = new Error("fixture provider failure after accepted steering");
    const first = await whileRunning(fixture, { failure, signal }, async (handle, attempt) => {
      const confirmSteerTarget = steering.confirmSteerTargetRunIdForPersistence;
      assert(confirmSteerTarget);
      const confirmed = createDeferred<void>();
      vi.spyOn(steering, "confirmSteerTargetRunIdForPersistence").mockImplementation(
        (targetRunId) => {
          const confirmation = confirmSteerTarget.call(steering, targetRunId);
          confirmed.resolve(confirmation);
          return confirmation;
        },
      );
      expect(
        queueAgentHarnessMessage(fixture.params.sessionId, steeringText, {
          isInboundUserMessage: true,
          toolAuthorityFingerprint: handle.toolAuthorityFingerprint,
          waitForTranscriptCommit: true,
          userTurnTranscriptRecorder: steering,
        }),
      ).toBe(true);
      await withinTest(
        awaitGateBeforeSettlement(
          confirmed.promise,
          attempt,
          "Agents API attempt settled before steering confirmation",
        ),
        signal,
      );
    });
    expect(first.terminal).toEqual({ kind: "failed", source: "prompt", error: failure });
    expect(histories).toEqual([priorHistory]);
    expect(steering.getPersistedMessage?.()).toMatchObject({
      __openclaw: { steerTargetRunId: fixture.params.runId },
    });

    fixture.params.prompt = "Continue the current task from the existing transcript.";
    fixture.params.skipPreparedUserTurnMessage = true;
    const interruption = new Error(`fixture ${retryScope}`);
    if (retryScope === "new run") {
      fixture.params.runId = "another-run";
    } else if (retryScope === "reset binding") {
      fixture.resetBinding();
    } else if (retryScope === "new budget") {
      fixture.params.contextTokenBudget = 32_000;
    } else if (retryScope === "cancelled") {
      fixture.controller.abort(interruption);
    } else if (retryScope === "revoked") {
      fixture.revoke(interruption);
    }
    const historyReads = vi.spyOn(SessionManager, "openModelContextAsync");
    if (retryScope === "cancelled" || retryScope === "revoked") {
      await expect(fixture.run()).rejects.toBe(interruption);
      expect(historyReads).not.toHaveBeenCalled();
      expect(createSession).toHaveBeenCalledTimes(1);
      return;
    }
    const retried = await fixture.run();

    // Steering confirmation keeps the foreground admission, so a changed scope
    // rereads the same fenced prefix instead of reusing the first attempt's history.
    expect(historyReads).toHaveBeenCalledTimes(retryScope === "same run" ? 0 : 1);
    expect(retried.terminal).toEqual({ kind: "ok" });
    expect(retried.assistantTexts).toEqual([answerText]);
    expect(histories[1]).toEqual(priorHistory);
    expect(promptHook).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ currentUserMessage: promptText }),
      expect.anything(),
    );
    expect(retried.messagesSnapshot).toEqual([
      ...admittedHistory,
      retried.currentAttemptCompletedAssistant,
    ]);

    fixture.completeNext("next-user-run");
    fixture.params.prompt = "Start the next request.";
    fixture.params.skipPreparedUserTurnMessage = false;
    const nextTurn = await fixture.recorder(fixture.params.prompt, "next-user");
    await nextTurn.persistApproved();
    fixture.params.userTurnTranscriptRecorder = nextTurn;
    expect((await fixture.run()).terminal).toEqual({ kind: "ok" });
    expect(histories[2]).toEqual([
      ...admittedHistory,
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: answerText }],
      }),
    ]);
  },
);
async function createAttempt(pluginConfig: unknown = {}) {
  const config = {};
  setRuntimeConfigSnapshot(config);
  const workspaceDir = tempDirs.make();
  const target = {
    agentId: "main",
    sessionId: "artifact-reply",
    sessionKey: "agent:main:artifact-reply",
    sessionEntry: undefined,
    storePath: path.join(workspaceDir, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });
  const controller = new AbortController();
  let revocation: Error | undefined;
  const assertCurrent = () => {
    if (revocation) {
      throw revocation;
    }
  };
  const onPartialReply = vi.fn<NonNullable<AgentHarnessAttemptParamsV2["onPartialReply"]>>();
  const promptHistories: AgentsApiPromptHistories = new WeakMap();
  let binding: AgentsApiBinding | undefined;
  const params = createAttemptParams({
    ...target,
    sessionTarget: target,
    sessionFile: path.join(workspaceDir, "session.jsonl"),
    workspaceDir,
    agentDir: workspaceDir,
    config,
    prompt: promptText,
    timeoutMs: 5_000,
    abortSignal: controller.signal,
    disableTools: true,
    hostCapabilities: {
      assertActive: assertCurrent,
      createToolSurfaceAsync: async () => [],
    },
    onPartialReply,
  });
  return {
    target,
    params,
    controller,
    onPartialReply,
    completeNext(runId: string, text = answerText, history?: History) {
      const turn = createTurn({ id: `turn-${runId}` });
      const item = {
        ...completedItem,
        id: `answer-${runId}`,
        turn_id: turn.id,
        content: [{ type: "output_text", text }],
      };
      params.runId = runId;
      readTurn.mockResolvedValue(turn);
      readItems.mockResolvedValue([item]);
      createSession.mockImplementationOnce((options) =>
        completedSession(options, turn, item, { history }),
      );
    },
    async recorder(
      text: string,
      idempotencyKey: string,
      media?: AgentHarnessAttemptParamsV2["media"],
    ) {
      const create = await loadUserTurnTranscriptRecorderFactoryForTest();
      return create({ target, input: { text, idempotencyKey, media } });
    },
    messages: async () =>
      (await SessionManager.openAsync(target, params.workspaceDir)).buildSessionContext().messages,
    resetBinding: () => {
      binding = undefined;
    },
    revoke: (error: Error) => {
      revocation = error;
    },
    run: () => {
      // Cold workers must not consume this outcome fixture's execution budget.
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      return runInHarnessToolAuthorityForTest(params, "agentsapi", (admitted) =>
        runAgentsApiAttempt(
          admitted,
          binding,
          async (next) => {
            binding = next;
          },
          assertCurrent,
          () => {},
          target,
          () => pluginConfig,
          promptHistories,
        ),
      );
    },
  };
}

const completedTurn = createTurn();

const completedItem: AgentsApiItem = {
  id: "answer-fixture",
  turn_id: completedTurn.id,
  type: "message",
  role: "assistant",
  phase: "final_answer",
  status: "completed",
  content: [{ type: "output_text", text: answerText }],
};

const hostedSession = createHostedSession();

function allowFollowup() {
  vi.spyOn(AgentsApiClient.prototype, "setReasoningEffort").mockResolvedValue();
  vi.spyOn(AgentsApiClient.prototype, "artifacts").mockResolvedValue([]);
}

function isNativeCommand(message: Awaited<ReturnType<AttemptFixture["messages"]>>[number]) {
  return "idempotencyKey" in message && String(message.idempotencyKey).includes("native-command");
}

function userMessage(content: string) {
  return expect.objectContaining({ role: "user", content });
}
