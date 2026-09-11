import type {
  AgentHarnessHostCapabilities,
  AgentHarnessProviderTranscriptCommitParams,
  AgentHarnessProviderTranscriptCommitResult,
  AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  readSessionTranscriptEvents,
  type TranscriptEntryAnchor,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupAttemptTranscriptJournalFixtures,
  createFixture,
  event,
  transcriptMessages,
} from "./attempt-transcript-journal.test-helpers.js";
import { buildSuspendableToolResultMessage } from "./event-bridge-transcript.js";
import { createCopilotHostCapabilitiesWithoutTranscriptCommit } from "./host-capability.test-support.js";

type ProviderTranscriptCommit = NonNullable<
  AgentHarnessHostCapabilities["commitProviderTranscriptPrefix"]
>;

const commitPrefix = vi.hoisted(() => vi.fn<ProviderTranscriptCommit>());
const SUSPENDABLE_STARTED_AT = 2;

function transcriptAnchor(
  params: AgentHarnessProviderTranscriptCommitParams,
  index: number,
): TranscriptEntryAnchor {
  const entry = params.entries[index]!;
  const base = params.baseAnchor;
  return {
    agentId: base?.agentId ?? "main",
    sessionId: base?.sessionId ?? "session-1",
    sessionKey: base?.sessionKey ?? "agent:main:session-1",
    storePath: base?.storePath ?? "/test/sessions.json",
    generation: base?.generation ?? "test-generation",
    entryId: entry.eventId,
    rawSeq: (base?.rawSeq ?? 0) + index + 1,
    effectiveParentId: index === 0 ? (base?.entryId ?? null) : params.entries[index - 1]!.eventId,
    activeMessagePosition: (base?.activeMessagePosition ?? 0) + index + 1,
    idempotencyKey: entry.identity,
  };
}

function committedPrefix(
  params: AgentHarnessProviderTranscriptCommitParams,
  kind: "committed" | "replayed",
  messages: readonly AgentMessage[] = params.entries.map((entry) => entry.message),
): AgentHarnessProviderTranscriptCommitResult {
  return {
    kind,
    results: params.entries.map((entry, index) => {
      const message = messages[index];
      if (!message) {
        throw new Error("Provider transcript fixture omitted a committed message");
      }
      return {
        anchor: transcriptAnchor(params, index),
        identity: entry.identity,
        message,
      };
    }),
  };
}

function suspendableToolResult(params: {
  details?: Record<string, unknown>;
  text?: string;
  toolCallId: string;
  toolName?: string;
}) {
  const text = params.text ?? "waiting";
  return buildSuspendableToolResultMessage({
    providerResult: { resultType: "success", textResultForLlm: text },
    result: {
      content: [{ type: "text", text }],
      details: params.details ?? { status: "waiting" },
    },
    startedAt: SUSPENDABLE_STARTED_AT,
    toolCallId: params.toolCallId,
    toolName: params.toolName ?? "exec",
  });
}

afterEach(async () => {
  commitPrefix.mockReset();
  resetGlobalHookRunner();
  await cleanupAttemptTranscriptJournalFixtures();
});

async function createProviderFixture() {
  const fixture = await createFixture();
  const hostCapabilities = fixture.attempt.hostCapabilities;
  if (!hostCapabilities) {
    throw new Error("provider durability fixture requires host capabilities");
  }
  Object.assign(hostCapabilities, {
    commitProviderTranscriptPrefix: commitPrefix,
  });
  return fixture;
}

async function persistMixedProviderGroup() {
  const fixture = await createProviderFixture();
  await fixture.journal.persistInitialUser();
  fixture.session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
  fixture.session.emit(
    event("assistant.message", "assistant-mixed", {
      content: "checking",
      messageId: "assistant-mixed",
      toolRequests: [
        {
          arguments: { first: 1, second: 2 },
          name: "exec",
          toolCallId: "exec-waiting",
        },
        { arguments: {}, name: "computer", toolCallId: "computer-1" },
      ],
    }),
  );
  fixture.session.emit(
    event("tool.execution_complete", "computer-result", {
      result: { content: "frame" },
      success: true,
      toolCallId: "computer-1",
    }),
  );
  const receipt = fixture.journal.recordProviderToolResult(
    suspendableToolResult({ toolCallId: "exec-waiting" }),
  );
  await fixture.journal.barrier("mixed provider group");
  await expect(receipt).resolves.toBeUndefined();
  return fixture;
}

describe("Copilot provider transcript durability", () => {
  it("fails atomically when the host lacks provider transcript authority", async () => {
    const { attempt, journal, session, target } = await createFixture();
    const abort = vi.spyOn(session, "abort");
    attempt.hostCapabilities = createCopilotHostCapabilitiesWithoutTranscriptCommit();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
    session.emit(
      event("assistant.message", "assistant-waiting", {
        content: "",
        messageId: "assistant-waiting",
        toolRequests: [{ arguments: {}, name: "exec", toolCallId: "exec-waiting" }],
      }),
    );
    const receipt = journal.recordProviderToolResult(
      suspendableToolResult({ toolCallId: "exec-waiting" }),
    );
    const rejectedReceipt = receipt.catch((error: unknown) => error);

    await expect(journal.barrier("missing host transcript capability")).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: "provider transcript commit requires host transcript capability",
      }),
      code: "transcript_persistence_failed",
    });
    await expect(rejectedReceipt).resolves.toMatchObject({
      message: "provider transcript commit requires host transcript capability",
    });
    expect(journal.hasFailed()).toBe(true);
    expect(journal.snapshot().replayInvalid).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
    const rows = transcriptMessages(await readSessionTranscriptEvents(target));
    expect(rows).toHaveLength(1);
    expect(rows.map((row) => row.message)).toEqual([
      expect.objectContaining({ content: "inspect both files", role: "user" }),
    ]);
  });

  it("commits one canonical assistant/result group for an outer waiting result", async () => {
    commitPrefix.mockImplementation(async (params) => committedPrefix(params, "committed"));
    const { journal, session } = await createProviderFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "pause" }));
    session.emit(
      event("assistant.message", "assistant-waiting", {
        content: "",
        messageId: "assistant-waiting",
        toolRequests: [{ arguments: {}, name: "exec", toolCallId: "exec-waiting-1" }],
      }),
    );

    const waitingMessage = suspendableToolResult({
      details: { runId: "run-waiting-1", status: "waiting" },
      toolCallId: "exec-waiting-1",
    });
    expect(waitingMessage.details).toEqual({
      runId: "run-waiting-1",
      status: "waiting",
    });
    expect(waitingMessage.details).not.toHaveProperty("details");
    expect(
      buildSuspendableToolResultMessage({
        providerResult: { resultType: "success", textResultForLlm: "done" },
        result: { content: [{ type: "text", text: "done" }] },
        startedAt: SUSPENDABLE_STARTED_AT,
        toolCallId: "exec-complete-1",
        toolName: "exec",
      }),
    ).not.toHaveProperty("details");
    const receipt = journal.recordProviderToolResult(waitingMessage);
    session.emit(
      event("tool.execution_complete", "sdk-duplicate", {
        result: { content: "waiting" },
        success: true,
        toolCallId: "exec-waiting-1",
      }),
    );

    expect(commitPrefix).not.toHaveBeenCalled();
    await journal.barrier("waiting result");
    await expect(receipt).resolves.toBeUndefined();
    expect(commitPrefix).toHaveBeenCalledOnce();
    expect(commitPrefix.mock.calls[0]?.[0].assertCurrent).toEqual(expect.any(Function));
    expect(commitPrefix.mock.calls[0]?.[0].entries.map((entry) => entry.message.role)).toEqual([
      "assistant",
      "toolResult",
    ]);
    const committedResult = commitPrefix.mock.calls[0]?.[0].entries.at(-1)?.message;
    expect(committedResult).toMatchObject({
      details: { runId: "run-waiting-1", status: "waiting" },
      role: "toolResult",
    });
    expect(asOptionalRecord(asOptionalRecord(committedResult)?.details)).not.toHaveProperty(
      "details",
    );
    expect(journal.snapshot().messagesSnapshot.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
  });

  it.each([false, true])(
    "settles deferred steering while abandoning a provider-terminal group: suppressed=%s",
    async (suppressed) => {
      const { journal, recorder, session, target } = await createProviderFixture();
      const abort = vi.spyOn(session, "abort");
      if (suppressed) {
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            {
              hookName: "before_message_write",
              handler: (input: unknown) => {
                const message = (input as { message: AgentMessage }).message;
                return message.role === "user" && message.content === "change course"
                  ? { block: true }
                  : undefined;
              },
            },
          ]),
        );
      }
      const steeringMessage = {
        role: "user" as const,
        content: "change course",
        timestamp: 2,
        provenance: {
          kind: "inter_session" as const,
          sourceSessionKey: "agent:ops:source",
          sourceTool: "sessions_send",
        },
      };
      const steeringRecorder = {
        ...recorder,
        message: steeringMessage,
        resolveMessage: vi.fn(async () => steeringMessage),
        markBlocked: vi.fn(),
        markRuntimePersisted: vi.fn(),
        markRuntimePersistencePending: vi.fn(),
        markSentToProvider: vi.fn(),
      };
      await journal.persistInitialUser();
      session.emit(event("user.message", "initial-user", { content: "pause" }));
      session.emit(
        event("assistant.message", "assistant-abandoned", {
          content: "",
          messageId: "assistant-abandoned",
          toolRequests: [{ arguments: {}, name: "wait", toolCallId: "wait-abandoned" }],
        }),
      );
      const messageId = await journal.sendSdkUser(async () => {
        session.emit(event("user.message", "steer-terminal", { content: "change course" }));
        return "steer-terminal";
      }, steeringRecorder);
      expect(messageId).toBe("steer-terminal");
      const receiptOutcome = journal
        .waitForSdkUserPersisted(messageId)
        .then(() => "persisted" as const)
        .catch(() => "rejected" as const);

      await journal.finalizeProviderTerminal();
      const lateSend = vi.fn(async () => "late-steer");
      await expect(journal.sendSdkUser(lateSend, steeringRecorder)).rejects.toThrow(
        "steering is unavailable after provider termination",
      );
      expect(lateSend).not.toHaveBeenCalled();
      session.emit(
        event("tool.execution_complete", "result-abandoned", {
          result: { content: "cleanup result" },
          success: false,
          toolCallId: "wait-abandoned",
        }),
      );
      await journal.barrier("provider terminal cleanup");

      expect(await receiptOutcome).toBe(suppressed ? "rejected" : "persisted");
      expect(journal.hasFailed()).toBe(false);
      expect(journal.snapshot().replayInvalid).toBe(true);
      expect(abort).not.toHaveBeenCalled();
      const messages = transcriptMessages(await readSessionTranscriptEvents(target)).map(
        (row) => row.message,
      );
      expect(messages.map((message) => message.role)).toEqual(
        suppressed ? ["user"] : ["user", "user"],
      );
      if (!suppressed) {
        expect(messages.at(-1)).toMatchObject({
          ...steeringMessage,
          timestamp: expect.any(Number),
        });
        expect(steeringRecorder.markRuntimePersisted).toHaveBeenCalledOnce();
      } else {
        expect(steeringRecorder.markBlocked).toHaveBeenCalledOnce();
      }
    },
  );

  it("rejects an admitted steering receipt when provider termination outruns its SDK echo", async () => {
    const { journal, recorder, session } = await createProviderFixture();
    const abort = vi.spyOn(session, "abort");
    const sendResponse = createDeferred<string>();
    let persistence: Promise<void> | undefined;
    const steeringRecorder = {
      ...recorder,
      markRuntimePersistencePending: vi.fn((pending: Promise<void>) => {
        persistence = pending;
      }),
    };
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "pause" }));
    session.emit(
      event("assistant.message", "assistant-abandoned", {
        content: "",
        messageId: "assistant-abandoned",
        toolRequests: [{ arguments: {}, name: "wait", toolCallId: "wait-abandoned" }],
      }),
    );

    const accepted = journal.sendSdkUser(() => sendResponse.promise, steeringRecorder);
    const finalization = journal.finalizeProviderTerminal();
    const lateSend = vi.fn(async () => "late-steer");
    await expect(journal.sendSdkUser(lateSend, steeringRecorder)).rejects.toThrow(
      "steering is unavailable after provider termination",
    );
    expect(lateSend).not.toHaveBeenCalled();
    sendResponse.resolve("steer-without-echo");

    await expect(accepted).resolves.toBe("steer-without-echo");
    await finalization;
    await expect(persistence).rejects.toThrow(
      "steering ended before its SDK user event could persist",
    );
    expect(journal.hasFailed()).toBe(false);
    expect(journal.snapshot().replayInvalid).toBe(true);
    expect(abort).not.toHaveBeenCalled();
  });

  it("commits concurrent completions in the assistant's declared order", async () => {
    commitPrefix.mockImplementation(async (params) => committedPrefix(params, "committed"));
    const { journal, session } = await createProviderFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "pause" }));
    session.emit(
      event("assistant.message", "assistant-mixed", {
        content: "",
        messageId: "assistant-mixed",
        toolRequests: [
          { arguments: {}, name: "exec", toolCallId: "exec-waiting" },
          { arguments: {}, name: "computer", toolCallId: "computer-1" },
        ],
      }),
    );
    session.emit(
      event("tool.execution_complete", "computer-result", {
        result: { content: "frame" },
        success: true,
        toolCallId: "computer-1",
      }),
    );
    const receipt = journal.recordProviderToolResult(
      suspendableToolResult({ toolCallId: "exec-waiting" }),
    );
    await journal.barrier("mixed group");
    await expect(receipt).resolves.toBeUndefined();

    expect(commitPrefix).toHaveBeenCalledOnce();
    expect(commitPrefix.mock.calls[0]?.[0].entries.map((entry) => entry.message.role)).toEqual([
      "assistant",
      "toolResult",
      "toolResult",
    ]);
    expect(
      commitPrefix.mock.calls[0]?.[0].entries.map((entry) =>
        entry.message.role === "toolResult" ? entry.message.toolCallId : "assistant",
      ),
    ).toEqual(["assistant", "exec-waiting", "computer-1"]);
    const commit = commitPrefix.mock.calls[0]?.[0];
    if (!commit?.validatePreparedPrefix) {
      throw new Error("Expected provider prefix validator");
    }
    const prepared = commit.entries.map((entry) => entry.message);
    expect(commit.validatePreparedPrefix(prepared)).toBe(true);
    expect(
      commit.validatePreparedPrefix(
        prepared.map((message: AgentMessage) =>
          message.role === "toolResult"
            ? { ...message, content: [{ type: "text", text: "redacted" }] }
            : message,
        ),
      ),
    ).toBe(true);
    expect(commit.validatePreparedPrefix(prepared.slice(0, -1))).toBe(false);
    expect(commit.validatePreparedPrefix([prepared[0]!, prepared[2]!, prepared[1]!])).toBe(false);
    const changedAssistantId = structuredClone(prepared);
    const assistant = changedAssistantId[0];
    if (assistant?.role === "assistant") {
      const call = assistant.content.find((part) => part.type === "toolCall");
      if (call?.type === "toolCall") {
        call.id = "changed-call";
      }
    }
    expect(commit.validatePreparedPrefix(changedAssistantId)).toBe(false);
    const changedResultId = structuredClone(prepared);
    const result = changedResultId[1];
    if (result?.role === "toolResult") {
      result.toolCallId = "changed-call";
    }
    expect(commit.validatePreparedPrefix(changedResultId)).toBe(false);
  });

  describe.each(["committed", "replayed"] as const)("%s provider payload", (kind) => {
    it.each([
      [
        "assistant content",
        (messages: AgentMessage[]) => {
          const assistant = messages.find((message) => message.role === "assistant");
          if (assistant?.role === "assistant") {
            const text = assistant.content.find((part) => part.type === "text");
            if (text?.type === "text") {
              text.text = "rewritten";
            }
          }
          return messages;
        },
      ],
      [
        "tool result content",
        (messages: AgentMessage[]) => {
          const result = messages.find(
            (message) => message.role === "toolResult" && message.toolCallId === "exec-waiting",
          );
          if (result?.role === "toolResult") {
            result.content = [{ type: "text", text: "rewritten" }];
          }
          return messages;
        },
      ],
      [
        "tool arguments",
        (messages: AgentMessage[]) => {
          const assistant = messages.find((message) => message.role === "assistant");
          if (assistant?.role === "assistant") {
            const call = assistant.content.find(
              (part) => part.type === "toolCall" && part.id === "exec-waiting",
            );
            if (call?.type === "toolCall") {
              call.arguments = { first: 9, second: 2 };
            }
          }
          return messages;
        },
      ],
      [
        "tool identity",
        (messages: AgentMessage[]) => {
          const result = messages.find(
            (message) => message.role === "toolResult" && message.toolCallId === "exec-waiting",
          );
          if (result?.role === "toolResult") {
            result.toolCallId = "changed-call";
          }
          return messages;
        },
      ],
      ["message order", (messages: AgentMessage[]) => [messages[0]!, messages[2]!, messages[1]!]],
    ])("resolves durability but invalidates replay after %s drift", async (_label, mutate) => {
      commitPrefix.mockImplementation(async (params) =>
        committedPrefix(
          params,
          kind,
          mutate(params.entries.map((entry) => structuredClone(entry.message))),
        ),
      );

      const { journal } = await persistMixedProviderGroup();

      expect(journal.snapshot().replayInvalid).toBe(true);
    });
  });

  it.each(["committed", "replayed"] as const)(
    "keeps %s provider replay valid for cloned key order and private metadata",
    async (kind) => {
      commitPrefix.mockImplementation(async (params) =>
        committedPrefix(
          params,
          kind,
          params.entries.map((entry) => {
            const message = structuredClone(entry.message);
            const metadataMessage = Object.assign({}, message, {
              __openclaw: { privateReceipt: "ignored" },
            }) satisfies AgentMessage & {
              __openclaw: { privateReceipt: string };
            };
            if (metadataMessage.role === "assistant") {
              return Object.assign({}, metadataMessage, {
                content: metadataMessage.content.map((part) =>
                  part.type === "toolCall" && part.id === "exec-waiting"
                    ? { ...part, arguments: { second: 2, first: 1 } }
                    : structuredClone(part),
                ),
              });
            }
            return metadataMessage.role === "toolResult"
              ? Object.assign({}, metadataMessage, {
                  details: { privateReceipt: "ignored" },
                })
              : metadataMessage;
          }),
        ),
      );

      const { journal } = await persistMixedProviderGroup();

      expect(journal.snapshot().replayInvalid).toBe(false);
    },
  );

  it("rejects a malformed provider replay message", async () => {
    commitPrefix.mockImplementation(async (params) => {
      const messages = params.entries.map((entry) => structuredClone(entry.message));
      Reflect.deleteProperty(messages.at(-1) ?? {}, "toolCallId");
      return committedPrefix(params, "replayed", messages);
    });
    const { journal, session } = await createProviderFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "pause" }));
    session.emit(
      event("assistant.message", "assistant-malformed", {
        content: "",
        messageId: "assistant-malformed",
        toolRequests: [{ arguments: {}, name: "exec", toolCallId: "exec-malformed" }],
      }),
    );
    const receipt = journal
      .recordProviderToolResult(suspendableToolResult({ toolCallId: "exec-malformed" }))
      .catch((error: unknown) => error);

    await expect(journal.barrier("malformed replay")).rejects.toThrow(
      "replayed an invalid message",
    );
    await expect(receipt).resolves.toBeInstanceOf(Error);
  });

  it("rejects every late provider receipt with the original commit failure", async () => {
    const failure = new Error("injected provider commit failure");
    commitPrefix.mockRejectedValue(failure);
    const { journal, session } = await createProviderFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "pause" }));
    session.emit(
      event("assistant.message", "assistant-failed", {
        content: "",
        messageId: "assistant-failed",
        toolRequests: [{ arguments: {}, name: "exec", toolCallId: "exec-failed" }],
      }),
    );
    const receipt = journal.recordProviderToolResult(
      suspendableToolResult({ toolCallId: "exec-failed" }),
    );
    const rejectedReceipt = receipt.catch((error: unknown) => error);

    await expect(journal.barrier("final response")).rejects.toThrow(
      "injected provider commit failure",
    );
    await expect(rejectedReceipt).resolves.toBe(failure);
    const lateMessage = suspendableToolResult({
      text: "late waiting",
      toolCallId: "exec-failed",
    });
    await expect(
      Promise.all([
        journal.recordProviderToolResult(lateMessage).catch((error: unknown) => error),
        journal.recordProviderToolResult(lateMessage).catch((error: unknown) => error),
      ]),
    ).resolves.toEqual([failure, failure]);
    expect(commitPrefix).toHaveBeenCalledOnce();
  });
});
