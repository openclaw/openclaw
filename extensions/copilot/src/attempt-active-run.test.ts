import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { controlRealtimeVoiceAgentRun } from "openclaw/plugin-sdk/realtime-voice";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCopilotActiveRun } from "./attempt-active-run.js";
import type { AttemptTranscriptJournal } from "./attempt-transcript-journal.js";
import {
  createFixture,
  createFakeSession,
  event,
  transcriptMessages,
} from "./attempt-transcript-journal.test-helpers.js";
import type { AttemptParamsLike } from "./attempt-types.js";
import type { SessionLike } from "./event-bridge.js";
import type { CopilotUserInputBridge } from "./user-input-bridge.js";

const harnessMocks = vi.hoisted(() => ({
  cancelPendingAgentQuestionForSession: vi.fn(async () => false),
  claimPendingAgentQuestionAnswer: vi.fn(async () => false),
  setActiveEmbeddedRun: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    ...harnessMocks,
  };
});

type RunOptions = Partial<Parameters<typeof registerCopilotActiveRun>[0]> & {
  sessionKey?: string;
  receipt?: Promise<void>;
  send?: SessionLike["send"];
  journal?: AttemptTranscriptJournal;
};

function registerTestRun({
  receipt,
  send = vi.fn(async () => "steer-1"),
  journal,
  sessionKey,
  ...params
}: RunOptions = {}) {
  const waitForSdkUserPersisted = vi.fn(() => receipt ?? Promise.resolve());
  const handle = registerCopilotActiveRun({
    abortActiveSession: vi.fn(),
    agentId: "main",
    bridge: undefined,
    canAcceptSteering: () => true,
    startedAtMs: 1_750_000_000_000,
    input: { runId: "run-1", sessionId: "session-1", sessionKey } as AttemptParamsLike,
    isAborted: () => false,
    isSettled: () => false,
    session: { ...createFakeSession(), send },
    transcriptJournal:
      journal ??
      ({
        waitForSdkUserPersisted,
        sendSdkUser: (submit: () => Promise<string>) => submit(),
      } as unknown as AttemptTranscriptJournal),
    userInputBridge: {
      cancelPending: vi.fn(),
      onUserInputRequest: vi.fn(),
    } as unknown as CopilotUserInputBridge,
    ...params,
  });
  return { handle, send, waitForSdkUserPersisted };
}

function createSteeringRecorder(
  recorder: NonNullable<AttemptParamsLike["userTurnTranscriptRecorder"]>,
  sourceSessionKey = "agent:other:source",
  message: NonNullable<typeof recorder.message> & { content: string } = {
    role: "user",
    content: "change course",
    timestamp: 1,
    provenance: { kind: "inter_session", sourceSessionKey, sourceTool: "sessions_send" },
  },
) {
  return {
    ...recorder,
    message,
    resolveMessage: vi.fn(async () => message),
    markSentToProvider: vi.fn(),
    markRuntimePersisted: vi.fn(),
  };
}

async function steeringFixture() {
  const fixture = await createFixture();
  const emit = (type: string, id: string, data: Record<string, unknown>) =>
    fixture.session.emit(event(type, id, data));
  await fixture.journal.persistInitialUser();
  emit("user.message", "initial-user", { content: "inspect both files" });
  const { handle } = registerTestRun({ journal: fixture.journal, session: fixture.session });
  const queue = (
    recorder: ReturnType<typeof createSteeringRecorder>,
    text = recorder.message.content,
    onQueueAccepted?: (accepted: boolean) => void,
  ) =>
    handle.queueMessage(text, {
      userTurnTranscriptRecorder: recorder,
      waitForTranscriptCommit: true,
      onQueueAccepted,
    });
  const messages = async () =>
    transcriptMessages(await readSessionTranscriptEvents(fixture.target));
  return { ...fixture, emit, queue, messages };
}

function voiceControl(
  text: string,
  options: Partial<Parameters<typeof controlRealtimeVoiceAgentRun>[0]> = {},
) {
  return controlRealtimeVoiceAgentRun({ sessionKey: "agent:main:session-1", text, ...options });
}

function expectNotCalled(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

describe("registerCopilotActiveRun", () => {
  afterEach(resetGlobalHookRunner);
  afterEach(() => clearRuntimeConfigSnapshot());
  beforeEach(() => {
    setRuntimeConfigSnapshot({});
    harnessMocks.cancelPendingAgentQuestionForSession.mockClear();
    harnessMocks.claimPendingAgentQuestionAnswer.mockReset();
    harnessMocks.claimPendingAgentQuestionAnswer.mockResolvedValue(false);
    harnessMocks.setActiveEmbeddedRun.mockClear();
  });

  it("retains the resolved agent for raw global registrations", () => {
    const { handle } = registerTestRun({ agentId: "ops", sessionKey: "global" });
    expect(harnessMocks.setActiveEmbeddedRun.mock.calls).toContainEqual([
      "session-1",
      handle,
      "global",
      undefined,
      "ops",
    ]);
  });

  it("refuses scoped controls before the real V1 handle while preserving unscoped injection", async () => {
    const runtime = await vi.importActual<
      typeof import("openclaw/plugin-sdk/agent-harness-runtime")
    >("openclaw/plugin-sdk/agent-harness-runtime");
    const { handle, send } = registerTestRun();
    const queue = vi.spyOn(handle.messageInjection, "queueMessage");
    const claim = vi.spyOn(handle, "claimPendingUserInputAnswer");
    const abort = vi.spyOn(handle, "abort");
    runtime.setActiveEmbeddedRun("session-1", handle, "agent:main:session-1");
    try {
      const result = await voiceControl("change course", {
        mode: "steer",
        runTarget: { runId: "run-1", signal: new AbortController().signal, isCurrent: () => true },
      });
      expect(result).toMatchObject({ ok: false, reason: "guarded_injection_unsupported" });
      expectNotCalled(queue, claim, harnessMocks.claimPendingAgentQuestionAnswer, send);
      const unscopedControl = await voiceControl("change course", { mode: "steer" });
      expect(unscopedControl).toMatchObject({
        ok: false,
        queued: false,
        reason: "guarded_injection_unsupported",
      });
      expectNotCalled(queue, claim, send);
      await expect(voiceControl("status")).resolves.toMatchObject({
        ok: true,
        active: true,
        mode: "status",
      });
      expect(runtime.queueAgentHarnessMessage("session-1", "unscoped change")).toBe(true);
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledExactlyOnceWith({ prompt: "unscoped change" }),
      );
      await expect(voiceControl("cancel")).resolves.toMatchObject({
        ok: true,
        active: true,
        mode: "cancel",
        aborted: true,
      });
      expect(abort).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledOnce();
    } finally {
      runtime.clearActiveEmbeddedRun("session-1", handle);
      vi.restoreAllMocks();
    }
  });

  it.each([
    [true, false],
    [false, false],
    [true, true],
    [false, true],
  ] as const)(
    "settles accepted steering after its receipt without revoking acceptance: wait=%s failed=%s",
    async (waitForTranscriptCommit, failed) => {
      const receipt = createDeferred<void>();
      const accepted = createDeferred<void>();
      const onQueueAccepted = vi.fn(() => accepted.resolve());
      const onQueueSettled = vi.fn();
      const { handle, send, waitForSdkUserPersisted } = registerTestRun({
        receipt: receipt.promise,
      });

      let deliverySettled = false;
      const delivery = handle
        .queueMessage("change course", {
          onQueueAccepted,
          onQueueSettled,
          waitForTranscriptCommit,
        })
        .finally(() => {
          deliverySettled = true;
        });

      await accepted.promise;
      expect(onQueueAccepted).toHaveBeenCalledExactlyOnceWith(true);
      expect(waitForSdkUserPersisted).toHaveBeenCalledExactlyOnceWith("steer-1");
      expect(send).toHaveBeenCalledWith({ prompt: "change course" });
      if (waitForTranscriptCommit) {
        expect(deliverySettled).toBe(false);
      } else {
        await expect(delivery).resolves.toBeUndefined();
      }
      expect(onQueueSettled).not.toHaveBeenCalled();

      if (failed) {
        receipt.reject(new Error("journal failed"));
        await expect(receipt.promise).rejects.toThrow("journal failed");
      } else {
        receipt.resolve();
        await receipt.promise;
      }
      await expect(delivery).resolves.toEqual(
        failed && waitForTranscriptCommit
          ? { transcriptCommit: "unconfirmed", errorMessage: "journal failed" }
          : undefined,
      );
      expect(onQueueAccepted).toHaveBeenCalledOnce();
      expect(onQueueSettled).toHaveBeenCalledOnce();
    },
  );

  it.each(["before response", "after response", "during tools", "hook replacement"])(
    "persists decorated reply steering with selected mentions once: %s",
    async (timing) => {
      const { journal, recorder, session, emit, queue, messages } = await steeringFixture();
      const message = {
        role: "user" as const,
        content: "Hi @Taylor",
        timestamp: 1,
        provenance: { kind: "external_user" as const },
        __openclaw: { humanMentions: [{ profileId: "profile-taylor", start: 3, end: 10 }] },
      };
      const steeringRecorder = createSteeringRecorder(recorder, undefined, message);
      const modelPrompt = `Reply context: earlier message\n\n${message.content}`;
      if (timing === "hook replacement") {
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            {
              hookName: "before_message_write",
              handler: () => ({
                message: { role: "user", content: message.content, timestamp: 1 },
              }),
            },
          ]),
        );
      }
      const sdkUserEvent = (options: Parameters<SessionLike["send"]>[0]) =>
        event("user.message", "steer-1", {
          content: options.displayPrompt ?? options.prompt,
          transformedContent: options.prompt,
        });
      const response = createDeferred<string>();
      const send = vi.fn<SessionLike["send"]>((options) => {
        if (timing !== "after response") {
          session.emit(sdkUserEvent(options));
        }
        return response.promise;
      });
      session.send = send;
      if (timing === "during tools") {
        emit("assistant.message", "assistant-tools", {
          content: "checking",
          messageId: "assistant-tools",
          toolRequests: [{ name: "read", arguments: {}, toolCallId: "read-1" }],
        });
        emit("tool.execution_start", "start-read", { toolCallId: "read-1", toolName: "read" });
      }
      const onQueueAccepted = vi.fn();
      let confirmed = false;
      const delivery = queue(steeringRecorder, modelPrompt, onQueueAccepted).finally(() => {
        confirmed = true;
      });
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      const sdkUser = sdkUserEvent(send.mock.calls[0]![0]);
      expect(onQueueAccepted).not.toHaveBeenCalled();
      response.resolve("steer-1");
      await vi.waitFor(() => expect(onQueueAccepted).toHaveBeenCalledWith(true));
      if (timing === "after response" || timing === "during tools") {
        expect(confirmed).toBe(false);
      }
      if (timing === "after response") {
        session.emit(sdkUser);
      } else if (timing === "during tools") {
        emit("tool.execution_complete", "result-read", {
          toolCallId: "read-1",
          success: true,
          result: { content: "done" },
        });
      }
      await expect(delivery).resolves.toBeUndefined();
      session.emit(sdkUser);
      await journal.barrier("steering replay");
      const steered = (await messages()).filter(
        (row) => row.message.idempotencyKey === "copilot-sdk:sdk-session:steer-1",
      );
      expect(steered).toHaveLength(1);
      expect(steered[0]?.message).toMatchObject({
        role: "user",
        content: message.content,
        provenance: message.provenance,
        __openclaw: message["__openclaw"],
        idempotencyKey: "copilot-sdk:sdk-session:steer-1",
      });
      expect(send).toHaveBeenCalledExactlyOnceWith({
        prompt: modelPrompt,
        displayPrompt: message.content,
      });
      expect(steeringRecorder.markRuntimePersisted).toHaveBeenCalledExactlyOnceWith(
        steered[0]?.message,
        expect.objectContaining({ entryId: steered[0]?.id }),
        { appended: true },
      );
      expect(steeringRecorder.persistApproved).not.toHaveBeenCalled();
      expect(steeringRecorder.markSentToProvider).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "correlates concurrent identical steering by SDK id and releases rejected sends: reject=%s",
    async (rejectFirst) => {
      const { journal, recorder, session, emit, queue, messages } = await steeringFixture();
      const first = createSteeringRecorder(recorder, "agent:first:source");
      const second = createSteeringRecorder(recorder, "agent:second:source");
      const response = createDeferred<string>();
      const send = vi
        .fn()
        .mockImplementationOnce(() => response.promise)
        .mockImplementationOnce(async () => {
          emit("user.message", "second", { content: second.message.content });
          return "second";
        });
      session.send = send;
      const firstDelivery = queue(first);
      const firstOutcome = firstDelivery.catch((error: unknown) => error);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      const secondAccepted = vi.fn();
      const secondDelivery = queue(second, second.message.content, secondAccepted);
      await vi.waitFor(() => expect(secondAccepted).toHaveBeenCalledWith(true));
      if (rejectFirst) {
        response.reject(new Error("send rejected"));
        await expect(firstOutcome).resolves.toMatchObject({ message: "send rejected" });
      } else {
        emit("user.message", "first", { content: first.message.content });
        response.resolve("first");
        await expect(firstOutcome).resolves.toBeUndefined();
      }
      await expect(secondDelivery).resolves.toBeUndefined();
      emit("user.message", "native", { content: first.message.content });
      await journal.barrier("concurrent steering");
      const users = (await messages()).filter((row) => row.message.role === "user").slice(1);
      const persisted = rejectFirst
        ? [["second", second] as const]
        : [["second", second] as const, ["first", first] as const];
      expect(users.map((row) => row.message)).toEqual([
        ...persisted.map(([id, source]) =>
          expect.objectContaining({
            idempotencyKey: `copilot-sdk:sdk-session:${id}`,
            provenance: source.message.provenance,
          }),
        ),
        expect.not.objectContaining({ provenance: expect.anything() }),
      ]);
      expect(first.markRuntimePersisted).toHaveBeenCalledTimes(rejectFirst ? 0 : 1);
      expect(second.markRuntimePersisted).toHaveBeenCalledOnce();
      expect(recorder.persistApproved).not.toHaveBeenCalled();
    },
  );

  it.each(["host answered", "host rejected", "SDK rejected"] as const)(
    "settles queue ownership without reopening failed delivery: %s",
    async (outcome) => {
      const error = new Error("delivery rejected");
      const hostQuestion = outcome !== "SDK rejected";
      if (outcome === "host rejected") {
        harnessMocks.claimPendingAgentQuestionAnswer.mockRejectedValueOnce(error);
      } else if (hostQuestion) {
        harnessMocks.claimPendingAgentQuestionAnswer.mockResolvedValueOnce(true);
      }
      const { handle, send, waitForSdkUserPersisted } = registerTestRun(
        hostQuestion ? {} : { send: vi.fn().mockRejectedValueOnce(error) },
      );
      const onQueueAccepted = vi.fn();
      const onQueueSettled = vi.fn();
      const delivery = handle.queueMessage(hostQuestion ? "answer" : "change course", {
        onQueueAccepted,
        onQueueSettled,
        ...(hostQuestion ? { isInboundUserMessage: true, waitForTranscriptCommit: true } : {}),
      });
      if (outcome === "host answered") {
        await expect(delivery).resolves.toBeUndefined();
      } else {
        await expect(delivery).rejects.toBe(error);
      }
      expect(onQueueAccepted.mock.calls).toEqual(
        outcome === "host rejected" ? [] : [[hostQuestion]],
      );
      expect(onQueueSettled).toHaveBeenCalledOnce();
      if (hostQuestion) {
        expect(harnessMocks.claimPendingAgentQuestionAnswer).toHaveBeenCalledOnce();
        expectNotCalled(send, waitForSdkUserPersisted);
      }
    },
  );

  it.each(["settled", "aborted", "unavailable"] as const)(
    "revalidates steering after resolving source text when the run becomes %s",
    async (changedState) => {
      const { recorder } = await createFixture();
      const resolution = createDeferred<Awaited<ReturnType<typeof recorder.resolveMessage>>>();
      recorder.resolveMessage.mockReturnValue(resolution.promise);
      let stateChanged = false;
      const { handle, send } = registerTestRun({
        isSettled: () => stateChanged && changedState === "settled",
        isAborted: () => stateChanged && changedState === "aborted",
        canAcceptSteering: () => !stateChanged || changedState !== "unavailable",
      });
      const onQueueAccepted = vi.fn();
      const outcome = handle
        .queueMessage("Reply context: earlier message\n\ninspect both files", {
          userTurnTranscriptRecorder: recorder,
          onQueueAccepted,
        })
        .catch((error: unknown) => error);

      await vi.waitFor(() => expect(recorder.resolveMessage).toHaveBeenCalledOnce());
      expectNotCalled(send, onQueueAccepted);
      stateChanged = true;
      resolution.resolve(recorder.message);

      await expect(outcome).resolves.toMatchObject({
        message:
          changedState === "unavailable"
            ? "Copilot steering is unavailable before initial user validation"
            : "Copilot steering is unavailable after the active run ended",
      });
      expect(send).not.toHaveBeenCalled();
      expect(onQueueAccepted).toHaveBeenCalledExactlyOnceWith(false);
    },
  );
});
