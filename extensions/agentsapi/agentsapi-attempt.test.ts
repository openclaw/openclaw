import path from "node:path";
import {
  queueAgentHarnessMessage,
  type AgentHarnessAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry, SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import {
  createMockPluginRegistry,
  initializeGlobalHookRunner,
  loadUserTurnTranscriptRecorderFactoryForTest,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import * as transcriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentsApiAttempt, type AgentsApiPromptHistories } from "./agentsapi-attempt.js";
import type { AgentsApiBinding } from "./agentsapi-bindings.js";
import { AgentsApiClient, type AgentsApiItem } from "./agentsapi-client.js";
import { AgentsApiMessageProjection } from "./agentsapi-messages.js";
import { recordAgentsApiNativeToolTranscript } from "./agentsapi-transcript.js";
import { createHostedSession, createModel, createTurn } from "./agentsapi.test-support.js";

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

function completedSession(
  options: Parameters<typeof createSession>[0],
  turn = completedTurn,
  item = completedItem,
) {
  return {
    isAvailable: () => false,
    isSettled: () => true,
    wasSubmitted: () => true,
    queueMessage: async () => {},
    readUsageTurns: async () => [turn],
    run: async () => {
      options.onSettled?.();
      await options.onReconcile?.(turn, [item]);
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  createSession.mockReset();
  registerRun.mockReset();
  resetGlobalHookRunner();
});

describe("Agents API completed reply settlement", () => {
  it("preserves native tool ownership when another run reconciles prior turns", async () => {
    const fixture = await createAttempt();
    vi.spyOn(AgentsApiClient.prototype, "setReasoningEffort").mockResolvedValue();
    vi.spyOn(AgentsApiClient.prototype, "artifacts").mockResolvedValue([]);
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
    createSession.mockImplementationOnce((options) => ({
      ...completedSession(options),
      run: async () => {
        options.onSettled?.();
        await options.onReconcile?.(completedTurn, [command, completedItem]);
        return { turn: completedTurn, cancelled: false, terminatedByTool: false };
      },
    }));
    readItems.mockResolvedValue([command, completedItem]);
    expect((await fixture.run()).terminal).toEqual({ kind: "ok" });
    const original = (
      await SessionManager.openAsync(fixture.target, fixture.params.workspaceDir)
    ).buildSessionContext().messages;
    const nativeRows = original.filter(
      (message) =>
        "idempotencyKey" in message && String(message.idempotencyKey).includes("native-command"),
    );
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
    const nextTurn = createTurn({ id: "next-native-turn" });
    const nextItem = {
      ...completedItem,
      id: "next-answer",
      turn_id: nextTurn.id,
      content: [{ type: "output_text", text: "Follow-up completed." }],
    };
    fixture.params.runId = "next-openclaw-run";
    readTurn.mockResolvedValue(nextTurn);
    readItems.mockResolvedValue([nextItem]);
    createSession.mockImplementationOnce((options) => ({
      ...completedSession(options, nextTurn, nextItem),
      run: async () => {
        options.onSettled?.();
        await options.onReconcileHistory?.([
          { turn: completedTurn, items: [command, completedItem] },
        ]);
        await options.onReconcile?.(nextTurn, [nextItem]);
        return { turn: nextTurn, cancelled: false, terminatedByTool: false };
      },
    }));
    const result = await fixture.run();
    expect(result.terminal).toEqual({ kind: "ok" });
    expect(result.assistantTexts).toEqual(["Follow-up completed."]);
    const messages = (
      await SessionManager.openAsync(fixture.target, fixture.params.workspaceDir)
    ).buildSessionContext().messages;
    expect(
      messages.filter(
        (message) =>
          "idempotencyKey" in message && String(message.idempotencyKey).includes("native-command"),
      ),
    ).toEqual(nativeRows);
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
    const events: Parameters<NonNullable<AgentHarnessAttemptParamsV2["onAgentEvent"]>>[0][] = [];
    const projection = new AgentsApiMessageProjection(
      fixture.params,
      "session-fixture",
      (event) => {
        events.push(event);
      },
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
      expect(events.at(-1)).toMatchObject({
        stream: "assistant",
        data: {
          itemId: "agentsapi:session-fixture:turn-fixture:newer-preview",
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
        agentId: fixture.target.agentId,
        sessionId: fixture.target.sessionId,
        sessionKey: fixture.target.sessionKey,
        storePath: fixture.target.storePath,
        sessionEntry: undefined,
        update: {
          message: saved.message,
          messageId: saved.id,
          messageSeq: 1,
          runId: fixture.params.runId,
          assistantItemIds: [
            "agentsapi:session-fixture:turn-fixture:answer-fixture",
            "agentsapi:session-fixture:turn-fixture:reply",
          ],
        },
      });
      expect(events.at(-1)).toMatchObject({
        stream: "assistant",
        data: {
          itemId: "agentsapi:session-fixture:turn-fixture:reply",
          text: "The completed answer.",
        },
      });
    } finally {
      release.resolve();
      await completion;
    }
  });

  it("retains and presents one durable completed reply when artifact listing fails", async () => {
    const fixture = await createAttempt();
    const failure = new Error("fixture artifact listing failed");
    vi.spyOn(AgentsApiClient.prototype, "artifacts").mockRejectedValue(failure);

    const result = await fixture.run();

    expect(result).toHaveProperty("terminal", { kind: "failed", source: "prompt", error: failure });
    expect(result.assistantTexts).toEqual(["The completed answer."]);
    expect(result.assistantTranscriptOwned).toBe(true);
    expect(result.assistantTranscriptIdempotencyKey).toBe("agentsapi:session-fixture:turn-fixture");
    expect(result.currentAttemptCompletedAssistant).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "The completed answer." }],
      stopReason: "stop",
    });
    expect(fixture.onPartialReply).toHaveBeenCalledExactlyOnceWith({
      text: "The completed answer.",
    });
    const persisted = SessionManager.open(
      fixture.target,
      fixture.params.workspaceDir,
    ).buildSessionContext().messages;
    expect(persisted).toEqual([result.currentAttemptCompletedAssistant]);
    expect(result.messagesSnapshot).toEqual(persisted);
    expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  });

  it.each(["cancelled", "revoked"] as const)(
    "does not publish the completed reply when artifact listing leaves the attempt %s",
    async (interruption) => {
      const fixture = await createAttempt();
      const failure = new Error(`fixture attempt ${interruption}`);
      vi.spyOn(AgentsApiClient.prototype, "artifacts").mockImplementation(async () => {
        if (interruption === "cancelled") {
          fixture.controller.abort(failure);
        } else {
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
      expect(result.assistantTexts).toEqual([]);
      expect(fixture.onPartialReply).not.toHaveBeenCalled();
      expect(
        SessionManager.open(fixture.target, fixture.params.workspaceDir).buildSessionContext()
          .messages,
      ).toEqual([]);
    },
  );
});

it("leaves PDF steering uncommitted so its next turn transfers the original in the same session", async () => {
  await withOpenClawTestState({ label: "agentsapi-pdf-steering" }, async () => {
    const fixture = await createAttempt();
    const bytes = Buffer.from("%PDF-1.4\nThe launch window is October.\n%%EOF\n");
    const saved = await saveMediaBuffer(bytes, "application/pdf", "inbound");
    const media = [
      { url: `media://inbound/${saved.id}`, contentType: "application/pdf", fileName: "brief.pdf" },
    ];
    const prompt = "Read the attached brief.";
    const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
    const recorder = createRecorder({
      target: fixture.target,
      input: { text: prompt, media, idempotencyKey: "pdf-followup" },
    });
    vi.spyOn(AgentsApiClient.prototype, "setReasoningEffort").mockResolvedValue();
    vi.spyOn(AgentsApiClient.prototype, "artifacts").mockResolvedValue([]);
    const upload = vi
      .spyOn(AgentsApiClient.prototype, "uploadFile")
      .mockResolvedValue({ status: "uploaded" });
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    const submitted: string[] = [];
    const followupTurn = createTurn({ id: "turn-pdf-followup" });
    const followupItem = { ...completedItem, id: "answer-pdf-followup", turn_id: followupTurn.id };
    let firstTurn = true;
    createSession.mockImplementation((options) => {
      const activeTurn = firstTurn;
      const turn = activeTurn ? completedTurn : followupTurn;
      firstTurn = false;
      return {
        isAvailable: () => true,
        isSettled: () => false,
        wasSubmitted: () => true,
        queueMessage: async (_text, persistInput) => {
          await persistInput?.();
        },
        readUsageTurns: async () => [turn],
        run: async (text, persistInput, onSubmitted) => {
          await persistInput();
          onSubmitted();
          submitted.push(text);
          if (activeTurn) {
            started.resolve();
            await finish.promise;
          }
          options.onSettled?.();
          return { turn, cancelled: false, terminatedByTool: false };
        },
        close: async () => {},
        reconcileAfterClose: async () => turn,
      };
    });
    const first = fixture.run();
    try {
      await Promise.race([
        started.promise,
        first.then((result) => {
          throw new Error("Agents API attempt settled before native start", {
            cause: result.terminal,
          });
        }),
      ]);
      const handle = registerRun.mock.calls.at(-1)?.[1];
      if (!handle?.queueMessage) {
        throw new Error("Expected the registered Agents API run");
      }
      await expect(
        handle.queueMessage(prompt, { media, userTurnTranscriptRecorder: recorder }),
      ).rejects.toThrow("Agents API attachments require a separate turn");
      expect(recorder.hasPersisted()).toBe(false);
    } finally {
      finish.resolve();
      await first;
    }
    expect((await first).terminal).toEqual({ kind: "ok" });

    readTurn.mockResolvedValue(followupTurn);
    readItems.mockResolvedValue([followupItem]);
    fixture.params.runId = "pdf-followup-run";
    fixture.params.prompt = prompt;
    fixture.params.media = media;
    fixture.params.userTurnTranscriptRecorder = recorder;
    expect((await fixture.run()).terminal).toEqual({ kind: "ok" });
    expect(recorder.hasPersisted()).toBe(true);
    expect(createSession.mock.calls.map(([options]) => options.sessionId)).toEqual([
      "session-fixture",
      "session-fixture",
    ]);
    expect(upload).toHaveBeenCalledTimes(1);
    const file = upload.mock.calls[0]![1];
    expect(Buffer.from(file.data, "base64")).toEqual(bytes);
    expect(submitted[1]).toContain(prompt);
    expect(submitted[1]).toContain(
      JSON.stringify([{ attachment: 1, name: "brief.pdf", path: file.path }]),
    );
  });
});

describe("Agents API retry prompt history", () => {
  it.each(["same run", "new run", "reset binding", "new budget", "cancelled", "revoked"] as const)(
    "handles %s after steering without widening retry prompt history",
    async (retryScope) => {
      const fixture = await createAttempt();
      await SessionManager.open(fixture.target, fixture.params.workspaceDir).appendMessageAsync({
        role: "user",
        content: "Earlier request.",
        timestamp: 1,
      });
      const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
      const foreground = createRecorder({
        target: fixture.target,
        input: { text: fixture.params.prompt, idempotencyKey: "foreground-user" },
      });
      await foreground.persistApproved();
      fixture.params.userTurnTranscriptRecorder = foreground;
      fixture.params.toolAuthorityFingerprint = "fixture-steering-authority";
      const steering = createRecorder({
        target: fixture.target,
        input: { text: "Use the updated result.", idempotencyKey: "steering-user" },
      });
      const histories: unknown[][] = [];
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
      vi.spyOn(AgentsApiClient.prototype, "setReasoningEffort").mockResolvedValue();
      vi.spyOn(AgentsApiClient.prototype, "artifacts").mockResolvedValue([]);
      const started = createDeferred<void>();
      const finish = createDeferred<void>();
      const failure = new Error("fixture provider failure after accepted steering");
      createSession.mockImplementationOnce(() => ({
        isAvailable: () => true,
        isSettled: () => false,
        wasSubmitted: () => true,
        queueMessage: async (_text, persistInput) => {
          await persistInput?.();
        },
        readUsageTurns: async () => [],
        run: async (_prompt, persistInput, onSubmitted) => {
          await persistInput();
          onSubmitted();
          started.resolve();
          await finish.promise;
          throw failure;
        },
        close: async () => {},
        reconcileAfterClose: async () => undefined,
      }));

      const first = fixture.run();
      try {
        await Promise.race([
          started.promise,
          first.then((result) => {
            throw new Error("Agents API attempt settled before native start", {
              cause: result.terminal,
            });
          }),
        ]);
        const handle = registerRun.mock.calls.at(-1)?.[1];
        if (!handle) {
          throw new Error("Expected the registered Agents API run");
        }
        const queue = vi.spyOn(handle, "queueMessage");
        expect(
          queueAgentHarnessMessage(fixture.params.sessionId, "Use the updated result.", {
            isInboundUserMessage: true,
            toolAuthorityFingerprint: fixture.params.toolAuthorityFingerprint,
            waitForTranscriptCommit: true,
            userTurnTranscriptRecorder: steering,
          }),
        ).toBe(true);
        await queue.mock.results[0]?.value;
        await steering.confirmSteerTargetRunIdForPersistence?.(fixture.params.runId);
      } finally {
        finish.resolve();
        await first;
      }
      expect((await first).terminal).toEqual({ kind: "failed", source: "prompt", error: failure });
      expect(histories).toEqual([
        [expect.objectContaining({ role: "user", content: "Earlier request." })],
      ]);
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
      const retried = await fixture.run();

      if (retryScope !== "same run") {
        expect(retried.terminal).toEqual(
          retryScope === "cancelled"
            ? { kind: "aborted", source: "external" }
            : {
                kind: "failed",
                source: "prompt",
                error:
                  retryScope === "revoked"
                    ? interruption
                    : expect.objectContaining({
                        message: expect.stringContaining(
                          "Current-turn transcript admission identity changed:",
                        ),
                      }),
              },
        );
        expect(createSession).toHaveBeenCalledTimes(1);
        return;
      }

      expect(retried.terminal).toEqual({ kind: "ok" });
      expect(retried.assistantTexts).toEqual(["The completed answer."]);
      expect(histories[1]).toEqual([
        expect.objectContaining({ role: "user", content: "Earlier request." }),
      ]);
      expect(promptHook).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          currentUserMessage: "Create an output file and summarize the result.",
        }),
        expect.anything(),
      );
      expect(retried.messagesSnapshot).toEqual([
        expect.objectContaining({ role: "user", content: "Earlier request." }),
        expect.objectContaining({
          role: "user",
          content: "Create an output file and summarize the result.",
        }),
        expect.objectContaining({ role: "user", content: "Use the updated result." }),
        retried.currentAttemptCompletedAssistant,
      ]);

      const nextNativeTurn = createTurn({ id: "turn-next-user" });
      const nextNativeItem = {
        ...completedItem,
        id: "answer-next-user",
        turn_id: nextNativeTurn.id,
      };
      readTurn.mockResolvedValue(nextNativeTurn);
      readItems.mockResolvedValue([nextNativeItem]);
      createSession.mockImplementationOnce((options) =>
        completedSession(options, nextNativeTurn, nextNativeItem),
      );
      fixture.params.runId = "next-user-run";
      fixture.params.prompt = "Start the next request.";
      fixture.params.skipPreparedUserTurnMessage = false;
      const nextTurn = createRecorder({
        target: fixture.target,
        input: { text: fixture.params.prompt, idempotencyKey: "next-user" },
      });
      await nextTurn.persistApproved();
      fixture.params.userTurnTranscriptRecorder = nextTurn;
      expect((await fixture.run()).terminal).toEqual({ kind: "ok" });
      expect(histories[2]).toEqual([
        expect.objectContaining({ role: "user", content: "Earlier request." }),
        expect.objectContaining({
          role: "user",
          content: "Create an output file and summarize the result.",
        }),
        expect.objectContaining({ role: "user", content: "Use the updated result." }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "The completed answer." }],
        }),
      ]);
    },
  );
});

async function createAttempt() {
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
  const authStorage = AuthStorage.inMemory();
  const onPartialReply = vi.fn<NonNullable<AgentHarnessAttemptParamsV2["onPartialReply"]>>();
  const promptHistories: AgentsApiPromptHistories = new WeakMap();
  let binding: AgentsApiBinding | undefined;
  const params: AgentHarnessAttemptParamsV2 = {
    ...target,
    sessionTarget: target,
    sessionFile: path.join(workspaceDir, "session.jsonl"),
    workspaceDir,
    agentDir: workspaceDir,
    config: {},
    runId: "run-fixture",
    prompt: "Create an output file and summarize the result.",
    timeoutMs: 5_000,
    abortSignal: controller.signal,
    provider: "openai",
    modelId: "fixture-model",
    model: createModel(),
    resolvedApiKey: "fixture-not-a-real-api-key",
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    authProfileStore: { version: 1, profiles: {} },
    thinkLevel: "off",
    disableTools: true,
    hostCapabilities: {
      kind: "agent-harness-host-capability",
      version: 1,
      assertActive: assertCurrent,
      createToolSurfaceAsync: async () => [],
      bindToolSurface: (tools) => tools,
      runBeforeToolCall: async (request) => ({ blocked: false, params: request.params }),
      requestApproval: async () => undefined,
      waitForApproval: async () => undefined,
    },
    onPartialReply,
  };
  return {
    target,
    params,
    controller,
    onPartialReply,
    resetBinding: () => {
      binding = undefined;
    },
    revoke: (error: Error) => {
      revocation = error;
    },
    run: () => {
      // Cold workers must not consume this outcome fixture's execution budget.
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      return runAgentsApiAttempt(
        params,
        binding,
        async (next) => {
          binding = next;
        },
        assertCurrent,
        () => {},
        target,
        () => ({}),
        promptHistories,
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
  content: [{ type: "output_text", text: "The completed answer." }],
};

const hostedSession = createHostedSession();
