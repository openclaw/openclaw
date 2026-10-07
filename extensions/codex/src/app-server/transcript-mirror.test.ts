// Codex tests cover transcript mirror plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import {
  embeddedAgentLog,
  type AgentMessage,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerEventProjector } from "./event-projector.js";
import {
  buildEmptyToolTelemetry,
  createParams as createProjectorParams,
  forCurrentTurn,
  registerCodexEventProjectorTestLifecycle,
  turnCompleted,
} from "./event-projector.test-harness.js";
import type { CodexThread } from "./protocol.js";
import { readCodexMirroredSessionHistoryMessages } from "./session-history.js";
import { projectBoundedCodexThreadHistory } from "./transcript-history-projection.js";
import { attachCodexMirrorRunId } from "./transcript-mirror-attestation.js";
import {
  codexTranscriptMirrorRuntime,
  importCodexThreadHistoryToTranscript,
  mirrorPromptAtTurnStartBestEffort,
} from "./transcript-mirror.js";
import {
  createTranscriptMirrorTestHarness,
  readMirrorMessages,
  readMirrorRaw,
} from "./transcript-mirror.test-harness.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";
import { buildCodexUserPromptMessage } from "./user-prompt-message.js";

const mirrorCodexAppServerTranscript = codexTranscriptMirrorRuntime.mirror;
const mirrorTranscriptBestEffort = codexTranscriptMirrorRuntime.mirrorBestEffort;

const publishSessionTranscriptUpdateByIdentityMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>();
  return {
    ...actual,
    publishSessionTranscriptUpdateByIdentity: publishSessionTranscriptUpdateByIdentityMock,
  };
});

type MirroredAgentMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>;

function messageContent(message: AgentMessage | undefined) {
  if (!message || !("content" in message)) {
    throw new Error("expected transcript message content");
  }
  return message.content;
}

const { makeRoot, createSqliteMirrorTarget } = createTranscriptMirrorTestHarness();

afterEach(() => {
  resetGlobalHookRunner();
  publishSessionTranscriptUpdateByIdentityMock.mockReset();
});

function mirroredUser(text: string, identity: string, timestamp: number) {
  return attachCodexMirrorIdentity(
    makeAgentUserMessage({ content: [{ type: "text", text }], timestamp }),
    identity,
  );
}

function mirroredAssistant(text: string, identity: string, timestamp: number) {
  return attachCodexMirrorIdentity(
    makeAgentAssistantMessage({ content: [{ type: "text", text }], timestamp }),
    identity,
  );
}

describe("buildCodexUserPromptMessage", () => {
  it("uses transcriptPrompt when an embedded caller does not provide a recorder", () => {
    const message = buildCodexUserPromptMessage({
      prompt:
        "[Audible call-opening context]\nAssistant: Welcome.\n[End audible call-opening context]\n\nCurrent caller message:\nHello",
      transcriptPrompt: "Hello",
      messageProvider: "voice",
      inputProvenance: { kind: "external_user", sourceChannel: "voice" },
    } as unknown as Parameters<typeof buildCodexUserPromptMessage>[0]);

    expect(message).toMatchObject({
      role: "user",
      content: "Hello",
      sourceChannel: "voice",
      provenance: { kind: "external_user", sourceChannel: "voice" },
    });
  });

  it("uses the prepared user transcript message for app-server prompt mirrors", () => {
    const message = buildCodexUserPromptMessage({
      prompt: "[Mon 2026-05-25 19:14 GMT+1] What is in this image?",
      messageChannel: "webchat",
      userTurnTranscriptRecorder: {
        message: {
          role: "user",
          content: "What is in this image?",
          timestamp: 1779732875151,
          MediaPath: "/tmp/image.png",
          MediaPaths: ["/tmp/image.png"],
          MediaType: "image/png",
          MediaTypes: ["image/png"],
        },
      },
    } as unknown as Parameters<typeof buildCodexUserPromptMessage>[0]);

    expect(message).toMatchObject({
      role: "user",
      content: "What is in this image?",
      timestamp: 1779732875151,
      sourceChannel: "webchat",
      MediaPath: "/tmp/image.png",
      MediaPaths: ["/tmp/image.png"],
      MediaType: "image/png",
      MediaTypes: ["image/png"],
    });
  });
});

describe("importCodexThreadHistoryToTranscript", () => {
  it.each([
    {
      label: "mixed text, image, and audio input in source order",
      caseId: "mixed",
      content: [
        { type: "text", text: "Before the recording" },
        { type: "audio", url: "data:audio/wav;base64,c2VjcmV0LWF1ZGlv" },
        { type: "text", text: "After the recording" },
        { type: "image", url: "data:image/png;base64,c2VjcmV0LWltYWdl" },
        { type: "localAudio", path: "/private/codex/secret-mixed-recording.wav" },
        { type: "local_audio", path: "/private/codex/secret-mixed-legacy.wav" },
      ],
      expectedText:
        "Before the recording\n[Audio attachment]\nAfter the recording\n" +
        "[Image attachment]\n[Audio attachment]\n[Audio attachment]",
      privateValues: [
        "data:audio/wav",
        "c2VjcmV0LWF1ZGlv",
        "data:image/png",
        "c2VjcmV0LWltYWdl",
        "/private/codex/secret-mixed-recording.wav",
        "/private/codex/secret-mixed-legacy.wav",
      ],
    },
  ])(
    "preserves $label without leaking attachment contents or locations",
    async ({ caseId, content, expectedText, privateValues }) => {
      const target = await createSqliteMirrorTarget(`openclaw-codex-audio-history-${caseId}-`, {
        sessionId: `session-audio-${caseId}`,
      });
      const thread = {
        id: `thread-audio-${caseId}`,
        turns: [
          {
            id: "turn-audio",
            status: "completed",
            items: [
              { id: "user-audio", type: "userMessage", content },
              {
                id: "assistant-audio",
                type: "agentMessage",
                text: "The recording was received.",
                phase: "final_answer",
              },
            ],
          },
        ],
      } as unknown as CodexThread;

      const projection = projectBoundedCodexThreadHistory({
        thread,
        throughTurnId: "turn-audio",
        importedAt: 1_800_000_000_000,
      });
      expect(projection).toMatchObject({ importedMessages: 2, omittedMessages: 0 });
      expect(projection.responseItems).toEqual([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: expectedText }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "The recording was received." }],
          phase: "final_answer",
        },
      ]);

      await expect(
        importCodexThreadHistoryToTranscript({
          thread,
          throughTurnId: "turn-audio",
          storePath: target.storePath,
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
          agentId: target.agentId,
        }),
      ).resolves.toEqual({ importedMessages: 2, omittedMessages: 0 });
      await expect(readMirrorMessages(target)).resolves.toEqual([
        { role: "user", text: expectedText },
        { role: "assistant", text: "The recording was received." },
      ]);

      const responseArtifacts = JSON.stringify(projection.responseItems);
      const transcriptArtifacts = await readMirrorRaw(target);
      for (const privateValue of privateValues) {
        expect(responseArtifacts).not.toContain(privateValue);
        expect(transcriptArtifacts).not.toContain(privateValue);
      }
    },
  );

  it("imports only bounded user-visible conversation items with stable identities", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-history-", {
      sessionId: "session-history",
    });
    const sessionFile = `sqlite:${target.agentId}:${target.sessionId}:${target.storePath}`;
    const thread = {
      id: "thread-history",
      cwd: "/workspace/project",
      turns: [
        {
          id: "turn-1",
          status: "completed",
          startedAt: 1_700_000_000,
          completedAt: 1_700_000_001,
          items: [
            {
              id: "user-1",
              type: "userMessage",
              content: [
                { type: "text", text: "Review this image" },
                { type: "image", url: "data:image/png;base64,private" },
              ],
            },
            {
              id: "reasoning-1",
              type: "reasoning",
              summary: ["private reasoning"],
              content: ["private chain of thought"],
            },
            {
              id: "command-1",
              type: "commandExecution",
              command: "print-secret",
              aggregatedOutput: "private tool output",
            },
            {
              id: "assistant-1",
              type: "agentMessage",
              text: "The visible answer",
              phase: "final_answer",
            },
          ],
        },
      ],
    } as unknown as CodexThread;

    const rawProjection = projectBoundedCodexThreadHistory({
      thread,
      throughTurnId: "turn-1",
      importedAt: 1_800_000_000_000,
    });
    expect(rawProjection.responseItems).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Review this image\n[Image attachment]" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "The visible answer" }],
        phase: "final_answer",
      },
    ]);
    expect(JSON.stringify(rawProjection.responseItems)).not.toContain("private");
    expect(JSON.stringify(rawProjection.responseItems)).not.toContain("data:image");

    await expect(
      importCodexThreadHistoryToTranscript({
        thread,
        throughTurnId: "turn-1",
        storePath: target.storePath,
        sessionId: "session-history",
        sessionKey: target.sessionKey,
        agentId: target.agentId,
      }),
    ).resolves.toEqual({ importedMessages: 2, omittedMessages: 0 });

    const events = await readSessionTranscriptEvents(target);
    const raw = events.map((event) => JSON.stringify(event)).join("\n");
    const messages = (events as Array<{ message?: AgentMessage; type?: string }>)
      .filter((event) => event.type === "message")
      .map((event) => event.message);
    expect(messages).toMatchObject([
      {
        role: "user",
        content: "Review this image\n[Image attachment]",
        timestamp: 1_700_000_000_000,
        idempotencyKey: "codex-app-server:thread-history:history:turn-1:user-1",
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "The visible answer" }],
        api: "openai-chatgpt-responses",
        provider: "openai",
        model: "native-history",
        stopReason: "stop",
        timestamp: 1_700_000_001_003,
        idempotencyKey: "codex-app-server:thread-history:history:turn-1:assistant-1",
      },
    ]);
    expect(raw).not.toContain("private reasoning");
    expect(raw).not.toContain("private chain of thought");
    expect(raw).not.toContain("private tool output");
    expect(raw).not.toContain("data:image");
    await expect(
      readCodexMirroredSessionHistoryMessages({
        sessionFile,
        sessionId: "session-history",
        sessionKey: target.sessionKey,
        agentId: target.agentId,
      }),
    ).resolves.toMatchObject([
      { role: "user", content: "Review this image\n[Image attachment]" },
      {
        role: "assistant",
        content: [{ type: "text", text: "The visible answer" }],
        api: "openai-chatgpt-responses",
        provider: "openai",
        model: "native-history",
        stopReason: "stop",
      },
    ]);
  });

  it("keeps the newest 200 visible messages and deduplicates a retried import", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-bounded-history-", {
      sessionId: "session-bounded-history",
    });
    const thread = {
      id: "thread-bounded-history",
      turns: Array.from({ length: 205 }, (_, index) => ({
        id: `turn-${index}`,
        status: "completed",
        startedAt: 1_700_000_000 + index,
        completedAt: 1_700_000_000 + index,
        items: [
          {
            id: `user-${index}`,
            type: "userMessage",
            content: [{ type: "text", text: `message-${index}` }],
          },
        ],
      })),
    } as unknown as CodexThread;
    const importParams = {
      thread,
      throughTurnId: "turn-204",
      storePath: target.storePath,
      sessionId: "session-bounded-history",
      sessionKey: target.sessionKey,
      agentId: target.agentId,
    };

    await expect(importCodexThreadHistoryToTranscript(importParams)).resolves.toEqual({
      importedMessages: 200,
      omittedMessages: 5,
    });
    await expect(importCodexThreadHistoryToTranscript(importParams)).resolves.toEqual({
      importedMessages: 200,
      omittedMessages: 5,
    });

    const events = await readSessionTranscriptEvents(target);
    const messages = (events as Array<{ message?: AgentMessage; type?: string }>)
      .filter((event) => event.type === "message")
      .map((event) => event.message);
    expect(messages).toHaveLength(200);
    expect(messages[0]).toMatchObject({ content: "message-5" });
    expect(messages.at(-1)).toMatchObject({ content: "message-204" });
  });

  it("assigns canonical assistant attribution and numeric fallback timestamps", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-fallback-history-", {
      sessionId: "session-fallback-history",
    });
    const sessionFile = `sqlite:${target.agentId}:${target.sessionId}:${target.storePath}`;
    const thread = {
      id: "thread-fallback-history",
      modelProvider: "source-provider",
      turns: [
        {
          id: "turn-without-time",
          status: "completed",
          items: [
            {
              id: "user-without-time",
              type: "userMessage",
              content: [{ type: "text", text: "Earlier prompt" }],
            },
            {
              id: "assistant-without-time",
              type: "agentMessage",
              text: "Earlier answer",
            },
          ],
        },
      ],
    } as unknown as CodexThread;

    await importCodexThreadHistoryToTranscript({
      thread,
      throughTurnId: "turn-without-time",
      storePath: target.storePath,
      sessionId: "session-fallback-history",
      sessionKey: target.sessionKey,
      agentId: target.agentId,
    });

    const history = await readCodexMirroredSessionHistoryMessages({
      sessionFile,
      sessionId: "session-fallback-history",
      sessionKey: target.sessionKey,
      agentId: target.agentId,
    });
    expect(history).toMatchObject([
      { role: "user", content: "Earlier prompt", timestamp: expect.any(Number) },
      {
        role: "assistant",
        content: [{ type: "text", text: "Earlier answer" }],
        api: "openai-chatgpt-responses",
        provider: "source-provider",
        model: "native-history",
        usage: { totalTokens: 0 },
        stopReason: "stop",
        timestamp: expect.any(Number),
      },
    ]);
  });
});

describe("mirrorCodexAppServerTranscript", () => {
  it("clears terminal ownership when a mirrored message becomes non-terminal", () => {
    const message = makeAgentAssistantMessage({
      content: [{ type: "text", text: "intermediate narration" }],
      timestamp: Date.now(),
    });
    const terminal = attachCodexMirrorRunId(message, "run-1", true);
    const intermediate = attachCodexMirrorRunId(terminal, "run-1");

    expect(intermediate).toMatchObject({ __openclaw: { runId: "run-1" } });
    expect(intermediate).not.toHaveProperty("__openclaw.runTerminal");
  });
  it("hides current memory-maintenance messages without hiding replayed turns", async () => {
    const prepareAssistantTranscriptMessage = vi.fn((message: AssistantMessage) => message);
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => {
            const { display: _display, ...message } = (
              event as { message: Record<string, unknown> }
            ).message;
            return { message: castAgentMessage({ ...message, display: true }) };
          },
        },
      ]),
    );
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-memory-");
    const messages = [
      mirroredAssistant("ordinary prior reply", "turn-prior:assistant", Date.now()),
      mirroredUser("Pre-compaction memory flush", "turn-memory:prompt", Date.now() + 1),
      attachCodexMirrorIdentity(
        makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: "call-1", name: "write", arguments: {} }],
          timestamp: Date.now() + 2,
        }),
        "turn-memory:tool-call:call-1",
      ),
      attachCodexMirrorIdentity(
        castAgentMessage({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "write",
          content: [{ type: "toolResult", toolCallId: "call-1", content: "saved" }],
          timestamp: Date.now() + 3,
        }),
        "turn-memory:tool-result:call-1",
      ),
      mirroredAssistant("NO_REPLY", "turn-memory:assistant", Date.now() + 4),
    ];
    for (const message of messages.slice(1)) {
      Object.assign(message, { display: false });
    }

    await mirrorCodexAppServerTranscript({
      ...target,
      messages,
      idempotencyScope: "codex-app-server:memory",
      runId: "run-memory",
      terminalAssistantOwner: { mirrorIdentity: "turn-memory:assistant", runId: "run-memory" },
      prepareAssistantTranscriptMessage,
    });

    const persistedMessages = (await readSessionTranscriptEvents(target))
      .map((event) =>
        event && typeof event === "object" ? (event as { message?: unknown }).message : undefined,
      )
      .filter((message): message is Record<string, unknown> =>
        Boolean(message && typeof message === "object"),
      );
    expect(persistedMessages).toHaveLength(messages.length);
    expect(persistedMessages[0]).not.toHaveProperty("display", false);
    expect(persistedMessages.slice(1).every((message) => message.display === false)).toBe(true);
    expect(prepareAssistantTranscriptMessage).not.toHaveBeenCalled();
  });

  it("preserves gateway user-turn identity across Codex transcript mirroring", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => ({
            message: castAgentMessage({
              ...((event as { message: unknown }).message as Record<string, unknown>),
              content: [{ type: "text", text: "[redacted by hook]" }],
            }),
          }),
        },
      ]),
    );
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-user-identity-");
    const userMessage = castAgentMessage({
      ...makeAgentUserMessage({
        content: [{ type: "text", text: "client prompt" }],
        timestamp: Date.now(),
      }),
      idempotencyKey: "client-run:user",
    }) as MirroredAgentMessage;

    const first = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });
    const second = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });

    const raw = await readMirrorRaw(target);
    expect(raw).toContain('"idempotencyKey":"client-run:user"');
    expect(raw).toContain('"mirrorOrigin":"codex-app-server"');
    expect(raw).not.toContain('"idempotencyKey":"codex-app-server:thread-1:');
    expect(first.userMessageReceipts).toHaveLength(1);
    expect(second.userMessageReceipts).toHaveLength(1);
    expect(first.userMessageReceipts[0]?.message.content).toEqual([
      { type: "text", text: "[redacted by hook]" },
    ]);
    expect(second.userMessageReceipts[0]?.message.content).toEqual([
      { type: "text", text: "[redacted by hook]" },
    ]);
    expect(JSON.stringify(second.userMessageReceipts)).not.toContain("client prompt");
    expect(first.userMessageReceipts[0]?.appended).toBe(true);
    expect(second.userMessageReceipts[0]?.appended).toBe(false);
    expect(second.userMessageReceipts[0]?.anchor.entryId).toBe(
      first.userMessageReceipts[0]?.anchor.entryId,
    );
    expect(
      (await readMirrorMessages(target)).filter((message) => message.role === "user"),
    ).toHaveLength(1);
  });

  it("preserves mirror identity across redaction from prompt append through final snapshot", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-redacted-identity-");
    const config = { logging: { redactPatterns: [String.raw`^codex-app-server:.*$`] } };
    const userMessage = mirroredUser("client prompt", "turn-1:prompt", Date.now());
    const assistantMessage = mirroredAssistant("final answer", "turn-1:assistant", Date.now() + 1);
    const mirrorParams = {
      ...target,
      idempotencyScope: "codex-app-server:thread-1",
      config,
    };

    await mirrorCodexAppServerTranscript({ ...mirrorParams, messages: [userMessage] });
    const finalMirror = await mirrorCodexAppServerTranscript({
      ...mirrorParams,
      messages: [userMessage, assistantMessage],
    });

    expect(finalMirror.assistantMirrorIdentitiesOwned).toEqual(["turn-1:assistant"]);
    expect(await readMirrorMessages(target)).toEqual([
      { role: "user", text: "client prompt" },
      { role: "assistant", text: "final answer" },
    ]);
    const raw = await readMirrorRaw(target);
    expect(raw).toContain('"idempotencyKey":"codex-app-server:thread-1:turn-1:prompt"');
    expect(raw).toContain('"idempotencyKey":"codex-app-server:thread-1:turn-1:assistant"');
  });

  it("prepares only the owned terminal media row before persistence and publication", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-media-owner-");
    const sourceText = "Artifacts ready\nMEDIA:./artifact.json";
    const rewrittenText = `${sourceText}\nMEDIA:./hook-only.json`;
    const prepareAssistantTranscriptMessage = vi.fn((message: AssistantMessage) => ({
      ...message,
      openclawDelivery: { mediaUrls: ["./artifact.json"] },
    }));
    const beforeMessageWrite = vi.fn((input: unknown) => {
      const message = (input as { message: AgentMessage }).message;
      return message.role === "assistant" &&
        message.content.some((part) => part.type === "text" && part.text === sourceText)
        ? {
            message: {
              ...message,
              idempotencyKey: "hook-rewritten-key",
              content: [{ type: "text", text: rewrittenText }],
            },
          }
        : undefined;
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: beforeMessageWrite,
        },
      ]),
    );
    const messages = [
      attachCodexMirrorIdentity(makeAgentUserMessage({ content: sourceText }), "turn-1:prompt"),
      ...[
        "turn-0:assistant",
        "turn-1:commentary:item",
        "turn-1:async:item",
        "turn-1:assistant",
      ].map((identity) =>
        attachCodexMirrorIdentity(
          makeAgentAssistantMessage({
            content: [
              {
                type: "text",
                text: identity === "turn-1:assistant" ? sourceText : "MEDIA:./unowned.json",
              },
            ],
          }),
          identity,
        ),
      ),
    ];
    await mirrorTranscriptBestEffort({
      params: {
        ...target,
        sessionTarget: target,
        runId: "run-media",
        prepareAssistantTranscriptMessage,
      } as unknown as EmbeddedRunAttemptParams,
      result: { messagesSnapshot: messages } as Parameters<
        typeof mirrorTranscriptBestEffort
      >[0]["result"],
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      notifyUserMessagePersisted: () => undefined,
      cwd: path.dirname(target.storePath),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(beforeMessageWrite).toHaveBeenCalledTimes(5);
    expect(prepareAssistantTranscriptMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: [{ type: "text", text: rewrittenText }] }),
      sourceText,
    );
    const published = publishSessionTranscriptUpdateByIdentityMock.mock.calls.map(
      ([params]) => params.update.message,
    );
    expect(published).toHaveLength(5);
    expect(published.slice(0, -1)).toEqual(
      messages
        .slice(0, -1)
        .map((message) =>
          expect.objectContaining({ role: message.role, content: message.content }),
        ),
    );
    expect(published.slice(0, -1).some((message) => message.openclawDelivery)).toBe(false);
    expect(published.at(-1)).toMatchObject({
      content: [{ type: "text", text: rewrittenText }],
      openclawDelivery: { mediaUrls: ["./artifact.json"] },
      idempotencyKey: "codex-app-server:thread-1:turn-1:assistant",
    });
    const persisted = (await readSessionTranscriptEvents(target)).flatMap((event) =>
      event && typeof event === "object" && "message" in event ? [event.message] : [],
    );
    expect(persisted).toEqual(published);
  });

  it("keeps assistant ownership when live update publication fails", async () => {
    publishSessionTranscriptUpdateByIdentityMock.mockRejectedValueOnce(new Error("publish failed"));
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-publish-failure-");
    const assistantMessage = mirroredAssistant("durably persisted", "turn-1:assistant", Date.now());

    const result = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [assistantMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });

    expect(result.assistantMirrorIdentitiesOwned).toEqual(["turn-1:assistant"]);
    expect(await readMirrorRaw(target)).toContain('"role":"assistant"');
  });

  it("rejects mirror writes without a runtime session identity", async () => {
    await expect(
      mirrorCodexAppServerTranscript({
        sessionId: "session-1",
        messages: [
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "no identity" }],
            timestamp: Date.now(),
          }),
        ],
      }),
    ).rejects.toThrow("runtime session identity");
  });

  it("serializes concurrent mirrors with the same supplied identity", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-concurrent-");
    const message = mirroredUser("append once", "turn-1:prompt", Date.now());

    const results = await Promise.all([
      mirrorCodexAppServerTranscript({
        ...target,
        messages: [message],
        idempotencyScope: "codex-app-server:thread-1",
      }),
      mirrorCodexAppServerTranscript({
        ...target,
        messages: [message],
        idempotencyScope: "codex-app-server:thread-1",
      }),
    ]);

    expect((await readMirrorMessages(target)).filter((entry) => entry.role)).toEqual([
      { role: "user", text: "append once" },
    ]);
    expect(results.map((result) => messageContent(result.userMessageReceipts[0]?.message))).toEqual(
      [[{ type: "text", text: "append once" }], [{ type: "text", text: "append once" }]],
    );
  });

  it.each(["in-place", "forge"] as const)(
    "sender provenance in Codex mirrors rejects hook reassignment: %s",
    async (mode) => {
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_message_write",
            handler: (event) => {
              const message = (event as { message: { __openclaw: Record<string, unknown> } })
                .message;
              if (mode === "in-place") {
                (message["__openclaw"].senderIdentity as { id: string }).id = "forged";
              }
              if (mode === "forge") {
                message["__openclaw"].senderIdentity = { type: "profile", id: "forged" };
              }
            },
          },
        ]),
      );
      const target = await createSqliteMirrorTarget("sender-provenance-mirror-");
      await mirrorCodexAppServerTranscript({
        ...target,
        idempotencyScope: "scope",
        messages: [
          castAgentMessage({
            role: "user",
            content: "hello",
            timestamp: 1,
            __openclaw: {
              senderId: "author",
              ...(mode === "forge" ? {} : { senderIdentity: { type: "profile", id: "author" } }),
            },
          }),
        ],
      });
      const entries = (await readSessionTranscriptEvents(target)) as Array<{
        type: string;
        message?: { role: string; __openclaw?: Record<string, unknown> };
      }>;
      const messages = entries.filter(
        (entry) => entry.type === "message" && entry.message?.role === "user",
      );
      expect(messages.map((entry) => entry.message?.["__openclaw"]?.senderIdentity)).toEqual([
        undefined,
      ]);
    },
  );

  it("skips transcript mirrors for sessionless embedded runs", async () => {
    const root = makeRoot("openclaw-codex-transcript-failure-");
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const markRuntimePersistencePending = vi.fn();
    const assistantMessage = mirroredAssistant(
      "needs fallback persistence",
      "turn-1:assistant",
      Date.now(),
    );

    const params = {
      prompt: "sessionless prompt",
      runId: "probe-setup-inference-sessionless",
      sessionId: "session-1",
      userTurnTranscriptRecorder: {
        markRuntimePersistencePending,
        resolveMessage: async () => undefined,
      },
    } as unknown as Parameters<typeof mirrorTranscriptBestEffort>[0]["params"];

    await mirrorPromptAtTurnStartBestEffort({
      params,
      sessionKey: "agent:main:setup-inference:incognito-session-1",
      notifyUserMessagePersisted: () => undefined,
      cwd: root,
      threadId: "thread-1",
      turnId: "turn-1",
      upstreamUserText: "sessionless prompt",
    });
    const mirrorOutcome = await mirrorTranscriptBestEffort({
      params,
      result: {
        messagesSnapshot: [assistantMessage],
      } as Parameters<typeof mirrorTranscriptBestEffort>[0]["result"],
      sessionKey: "agent:main:setup-inference:incognito-session-1",
      notifyUserMessagePersisted: () => undefined,
      cwd: root,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(mirrorOutcome).toEqual({ assistantTranscriptOwned: false, mirroredMessages: [] });
    expect(markRuntimePersistencePending).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("renders normal-session mirror failures in structured warnings", async () => {
    const root = makeRoot("openclaw-codex-transcript-failure-");
    const blockedParent = path.join(root, "not-a-directory");
    await fs.writeFile(blockedParent, "blocked");
    const storePath = path.join(blockedParent, "openclaw-agent.sqlite");
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    warn.mockClear();
    const runId = "run-1";
    const sessionId = "session-1";
    const params = {
      prompt: "persist me",
      runId,
      sessionId,
      sessionTarget: { storePath },
    } as unknown as Parameters<typeof mirrorPromptAtTurnStartBestEffort>[0]["params"];

    await mirrorPromptAtTurnStartBestEffort({
      params,
      sessionKey: "agent:main:session-1",
      notifyUserMessagePersisted: () => undefined,
      cwd: storePath,
      threadId: "thread-1",
      turnId: "turn-1",
      upstreamUserText: "persist me",
    });

    expect(warn).toHaveBeenCalledWith("failed to mirror codex app-server prompt at turn start", {
      error: expect.any(String),
      runId,
      sessionId,
    });
    const warning = warn.mock.calls.at(-1)?.[1] as { error?: string } | undefined;
    expect(warning?.error).not.toBe("");

    warn.mockClear();
    await mirrorTranscriptBestEffort({
      params,
      result: {
        messagesSnapshot: [
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "persist me too" }],
            timestamp: Date.now(),
          }),
        ],
      } as Parameters<typeof mirrorTranscriptBestEffort>[0]["result"],
      sessionKey: "agent:main:session-1",
      notifyUserMessagePersisted: () => undefined,
      cwd: root,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(warn).toHaveBeenCalledWith("failed to mirror codex app-server transcript", {
      error: expect.any(String),
      runId,
      sessionId,
    });
  });

  it("does not attest a stale idempotency hit with the same mirror identity", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-stale-identity-");
    const staleMessage = mirroredAssistant("stale answer", "turn-1:assistant", Date.now());
    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [staleMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });
    const currentMessage = mirroredAssistant("current answer", "turn-1:assistant", Date.now() + 1);

    const mirrorOutcome = await mirrorTranscriptBestEffort({
      params: {
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
        suppressNextUserMessagePersistence: true,
      } as unknown as Parameters<typeof mirrorTranscriptBestEffort>[0]["params"],
      result: {
        messagesSnapshot: [currentMessage],
      } as Parameters<typeof mirrorTranscriptBestEffort>[0]["result"],
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      notifyUserMessagePersisted: () => undefined,
      cwd: target.storePath,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(mirrorOutcome.assistantTranscriptOwned).toBe(false);
    expect(mirrorOutcome.mirroredMessages).toEqual([]);
  });

  it("attests the exact persisted payload after a message-write hook transforms it", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: () => ({
            message: castAgentMessage({
              role: "assistant",
              content: [{ type: "text", text: "[redacted by hook]" }],
            }),
          }),
        },
      ]),
    );
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-attested-hook-");
    const sourceMessage = mirroredAssistant("sensitive answer", "turn-1:assistant", Date.now());

    const mirrorOutcome = await mirrorTranscriptBestEffort({
      params: {
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
        suppressNextUserMessagePersistence: true,
      } as unknown as Parameters<typeof mirrorTranscriptBestEffort>[0]["params"],
      result: {
        messagesSnapshot: [sourceMessage],
      } as Parameters<typeof mirrorTranscriptBestEffort>[0]["result"],
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      notifyUserMessagePersisted: () => undefined,
      cwd: target.storePath,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(mirrorOutcome.assistantTranscriptOwned).toBe(true);
    expect(mirrorOutcome.assistantTranscriptIdempotencyKey).toBe(
      "codex-app-server:thread-1:turn-1:assistant",
    );
    expect(mirrorOutcome.mirroredMessages).toMatchObject([
      { role: "assistant", content: [{ type: "text", text: "[redacted by hook]" }] },
    ]);
    expect(JSON.stringify(mirrorOutcome.mirroredMessages)).not.toContain("sensitive answer");
  });

  it("returns the final mirrored row as the terminal anchor", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-terminal-anchor-");
    const assistantMessage = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
        timestamp: Date.now(),
      }),
      "turn-1:assistant",
    );
    const toolResultMessage = attachCodexMirrorIdentity(
      castAgentMessage({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "toolResult", toolCallId: "call-1", content: "done" }],
        timestamp: Date.now() + 1,
      }),
      "turn-1:tool-result:call-1",
    );

    const mirrorOutcome = await mirrorTranscriptBestEffort({
      params: {
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
        suppressNextUserMessagePersistence: true,
      } as unknown as Parameters<typeof mirrorTranscriptBestEffort>[0]["params"],
      result: {
        messagesSnapshot: [assistantMessage, toolResultMessage],
      } as Parameters<typeof mirrorTranscriptBestEffort>[0]["result"],
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      notifyUserMessagePersisted: () => undefined,
      cwd: target.storePath,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const terminalEvent = (await readSessionTranscriptEvents(target)).find(
      (event): event is { id: string; message: { role: string } } =>
        Boolean(
          event &&
          typeof event === "object" &&
          "id" in event &&
          "message" in event &&
          (event as { message?: { role?: unknown } }).message?.role === "toolResult",
        ),
    );

    expect(mirrorOutcome.assistantTranscriptOwned).toBe(true);
    expect(mirrorOutcome.terminalAnchor?.entryId).toBe(terminalEvent?.id);
  });

  describe("projected transcript persistence", () => {
    registerCodexEventProjectorTestLifecycle();

    it("retains each committed steering cutoff when a later mirror assertion fails", async () => {
      const target = await createSqliteMirrorTarget("openclaw-codex-steering-partial-mirror-");
      const params: EmbeddedRunAttemptParams = {
        ...(await createProjectorParams()),
        ...target,
        suppressNextUserMessagePersistence: true,
      };
      const projector = new CodexAppServerEventProjector(params, "thread-1", "turn-1");
      const item = { type: "agentMessage", id: "answer", phase: "final_answer", text: "" };
      await projector.handleNotification(forCurrentTurn("item/started", { item }));
      await projector.handleNotification(
        forCurrentTurn("item/agentMessage/delta", {
          itemId: item.id,
          delta: "Before failed mirror.",
        }),
      );
      const firstPrefix = projector.buildSteeringTranscriptPrefix();
      const owned: string[] = [];
      let failed = false;
      const mirrorOptions = {
        ...target,
        idempotencyScope: "codex-app-server:thread-1",
        onAssistantMessageOwned: (identity: string) => {
          projector.markSteeringTranscriptMessagePersisted(identity);
          owned.push(identity);
        },
        assertCurrent: () => {
          if (owned.length > 0 && !failed) {
            failed = true;
            throw new Error("owner changed after first commit");
          }
        },
      };
      await expect(
        mirrorCodexAppServerTranscript({
          ...mirrorOptions,
          messages: [...firstPrefix, mirroredAssistant("Uncommitted later row", "turn-1:later", 2)],
        }),
      ).rejects.toThrow("owner changed after first commit");
      expect(await readMirrorMessages(target)).toEqual([
        { role: "assistant", text: "Before failed mirror." },
      ]);

      await projector.handleNotification(
        forCurrentTurn("item/agentMessage/delta", {
          itemId: item.id,
          delta: " After failed mirror.",
        }),
      );
      const secondPrefix = projector.buildSteeringTranscriptPrefix();
      await mirrorCodexAppServerTranscript({
        ...mirrorOptions,
        messages: [...firstPrefix, ...secondPrefix, mirroredUser("Steer", "steer:user", 3)],
      });
      expect(owned).toEqual([
        "turn-1:assistant:answer:segment:0",
        "turn-1:assistant:answer:segment:0",
        "turn-1:assistant:answer:segment:1",
      ]);
      const completed = {
        ...item,
        text: "Before failed mirror. After failed mirror. After steer.",
      };
      await projector.handleNotification(forCurrentTurn("item/completed", { item: completed }));
      await projector.handleNotification(turnCompleted([completed]));
      await mirrorCodexAppServerTranscript({
        ...mirrorOptions,
        messages: projector.buildResult(buildEmptyToolTelemetry()).messagesSnapshot,
      });
      expect(await readMirrorMessages(target)).toEqual([
        { role: "assistant", text: "Before failed mirror." },
        { role: "assistant", text: " After failed mirror." },
        { role: "user", text: "Steer" },
        { role: "assistant", text: "After steer." },
      ]);
    });

    it("keeps failed attempt diagnostics without taking deferred run ownership", async () => {
      const target = await createSqliteMirrorTarget("openclaw-codex-mirror-retry-owner-");
      const params: EmbeddedRunAttemptParams = {
        ...(await createProjectorParams()),
        ...target,
        sessionTarget: target,
        workspaceDir: path.dirname(target.storePath),
        suppressNextUserMessagePersistence: true,
        deferTerminalLifecycle: true,
      };
      const finalRunId = params.runId;
      const attempts = [
        { turnId: "turn-1", runId: params.runId, failed: true, text: "The file is ready." },
        {
          turnId: "turn-2",
          runId: finalRunId,
          failed: false,
          text: "The action completed once.",
        },
      ];
      for (const attempt of attempts) {
        const attemptParams = { ...params, runId: attempt.runId };
        const projector = new CodexAppServerEventProjector(
          attemptParams,
          "thread-1",
          attempt.turnId,
        );
        await projector.handleNotification({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: {
              id: attempt.turnId,
              status: attempt.failed ? "failed" : "completed",
              items: [{ type: "agentMessage", id: `answer-${attempt.turnId}`, text: attempt.text }],
              error: attempt.failed
                ? { message: "Rate limit reached", codexErrorInfo: "rateLimitExceeded" }
                : null,
            },
          },
        });
        await mirrorTranscriptBestEffort({
          params: attemptParams,
          result: projector.buildResult(buildEmptyToolTelemetry()),
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          notifyUserMessagePersisted: () => undefined,
          cwd: params.workspaceDir,
          threadId: "thread-1",
          turnId: attempt.turnId,
        });
      }

      const messages = await readCodexMirroredSessionHistoryMessages({
        ...params,
        sessionFile: target.bogusSessionFile,
      });
      expect(messages).toHaveLength(2);
      expect(messages).toMatchObject([
        {
          content: [{ type: "text", text: "The file is ready." }],
          stopReason: "error",
          errorMessage: expect.stringContaining("Rate limit reached"),
          __openclaw: { mirrorIdentity: "turn-1:assistant", runId: params.runId },
        },
        {
          content: [{ type: "text", text: "The action completed once." }],
          stopReason: "stop",
          __openclaw: {
            mirrorIdentity: "turn-2:assistant",
            runId: finalRunId,
            runTerminal: true,
          },
        },
      ]);
      expect(messages?.[0]).not.toHaveProperty("__openclaw.runTerminal");
      expect(
        publishSessionTranscriptUpdateByIdentityMock.mock.calls[0]?.[0].update,
      ).not.toHaveProperty("runId");
      expect(publishSessionTranscriptUpdateByIdentityMock.mock.calls[1]?.[0].update).toHaveProperty(
        "runId",
        finalRunId,
      );
    });

    it("preserves reasoning as nonterminal thinking beside the final answer in SQLite", async () => {
      const target = await createSqliteMirrorTarget("openclaw-codex-mirror-reasoning-");
      const params: EmbeddedRunAttemptParams = {
        ...(await createProjectorParams()),
        ...target,
        sessionTarget: target,
        workspaceDir: path.dirname(target.storePath),
      };
      const projector = new CodexAppServerEventProjector(params, "thread-1", "turn-1");
      await projector.handleNotification(
        forCurrentTurn("item/reasoning/summaryTextDelta", {
          itemId: "reason-1",
          summaryIndex: 0,
          delta: "checking the answer",
        }),
      );
      await projector.handleNotification(
        turnCompleted([
          { type: "agentMessage", id: "answer-1", phase: "final_answer", text: "hi there" },
        ]),
      );
      const result = projector.buildResult(buildEmptyToolTelemetry());
      expect(result.assistantTexts).toEqual(["hi there"]);

      const mirrored = await mirrorTranscriptBestEffort({
        params,
        result,
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        notifyUserMessagePersisted: () => undefined,
        cwd: params.workspaceDir,
        threadId: "thread-1",
        turnId: "turn-1",
      });

      expect(mirrored.assistantTranscriptOwned).toBe(true);
      const messages = await readCodexMirroredSessionHistoryMessages({
        ...params,
        sessionFile: target.bogusSessionFile,
      });
      expect(messages).toMatchObject([
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "checking the answer" }],
          __openclaw: { mirrorIdentity: "turn-1:reasoning", runId: "run-1" },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "hi there" }],
          __openclaw: { mirrorIdentity: "turn-1:assistant", runTerminal: true },
        },
      ]);
      expect(messages?.[1]).not.toHaveProperty("__openclaw.runTerminal");
    });
  });

  it("dedupes mirrored messages despite snapshot positional shifts", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-shift-");
    const userMessage = mirroredUser("hello", "turn-1:prompt", Date.now());
    const assistantMessage = mirroredAssistant("hi there", "turn-1:assistant", Date.now() + 1);

    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userMessage, assistantMessage],
      idempotencyScope: "codex-app-server:thread-X",
    });
    const reasoningMessage = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "thinking", thinking: "thinking" }],
        timestamp: Date.now() + 2,
      }),
      "turn-1:reasoning",
    );
    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userMessage, reasoningMessage, assistantMessage],
      idempotencyScope: "codex-app-server:thread-X",
    });

    expect((await readMirrorMessages(target)).map((m) => m.text)).toEqual([
      "hello",
      "hi there",
      undefined,
    ]);
  });

  it("keeps repeated same-content turns distinct", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-repeat-");
    const userTurn1 = mirroredUser("yes", "turn-1:prompt", Date.now());
    const assistantTurn1 = mirroredAssistant("ok 1", "turn-1:assistant", Date.now() + 1);
    const userTurn2 = mirroredUser("yes", "turn-2:prompt", Date.now() + 2);
    const assistantTurn2 = mirroredAssistant("ok 2", "turn-2:assistant", Date.now() + 3);

    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userTurn1, assistantTurn1],
      idempotencyScope: "codex-app-server:thread-X",
    });
    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userTurn2, assistantTurn2],
      idempotencyScope: "codex-app-server:thread-X",
    });

    expect(await readMirrorMessages(target)).toEqual([
      { role: "user", text: "yes" },
      { role: "assistant", text: "ok 1" },
      { role: "user", text: "yes" },
      { role: "assistant", text: "ok 2" },
    ]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

const deliverAsyncMessageBestEffort = codexTranscriptMirrorRuntime.deliverAsyncMessageBestEffort;

async function createDelivery(
  itemId: string,
  text: string,
  onBlockReply = vi.fn(),
  message?: AgentMessage,
) {
  const target = await createSqliteMirrorTarget(`openclaw-codex-mirror-${itemId}-`);
  const cwd = path.dirname(target.storePath);
  const params = {
    agentId: target.agentId,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    sessionTarget: target,
    workspaceDir: cwd,
    runId: `run-${itemId}`,
    onBlockReply,
  } as unknown as EmbeddedRunAttemptParams;
  return {
    target,
    onBlockReply,
    delivery: {
      cwd,
      params,
      itemId,
      text,
      message:
        message ??
        castAgentMessage({
          ...makeAgentAssistantMessage({
            content: [{ type: "text", text }],
            timestamp: Date.now(),
          }),
          openclawAsyncDelivery: { itemId },
        }),
      threadId: "thread-1",
      turnId: "turn-1",
    },
  };
}

describe("deliverAsyncMessageBestEffort", () => {
  it("delivers the persisted async rewrite once across reconnect replay", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => {
            const message = asOptionalRecord(asOptionalRecord(event)?.message);
            expect(message).toHaveProperty("openclawAsyncDelivery.questions");
            const firstBlock = asOptionalRecord(
              Array.isArray(message?.content) ? message.content[0] : undefined,
            );
            if (!firstBlock) {
              throw new Error("Expected the async question text block");
            }
            firstBlock.text = "[redacted async update]";
            return {
              message: castAgentMessage({
                ...message,
                phase: "final_answer",
              }),
            };
          },
        },
      ]),
    );
    const message = castAgentMessage({
      ...makeAgentAssistantMessage({
        content: [{ type: "text", text: "Sensitive background update." }],
        timestamp: Date.now(),
      }),
      phase: "final_answer",
      openclawAsyncDelivery: {
        itemId: "async-update",
        questions: [{ title: "Sensitive question?", options: ["Sensitive choice"] }],
      },
    });
    const { target, delivery, onBlockReply } = await createDelivery(
      "async-update",
      "Sensitive background update.",
      vi.fn(),
      message,
    );

    await expect(deliverAsyncMessageBestEffort(delivery)).resolves.toBe("settled");
    await expect(
      deliverAsyncMessageBestEffort({
        ...delivery,
        params: { ...delivery.params, runId: "run-async-reconnect" },
      }),
    ).resolves.toBe("settled");

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply).toHaveBeenNthCalledWith(
      1,
      { text: "[redacted async update]" },
      {
        deliveryIntentId: "block-reply:v1:codex-app-server:thread-1:turn-1:async-update",
      },
    );
    expect(onBlockReply.mock.calls[1]).toEqual(onBlockReply.mock.calls[0]);
    expect(onBlockReply.mock.calls.map(([payload]) => payload)).not.toContainEqual({
      text: "Sensitive background update.",
    });
    expect(await readMirrorMessages(target)).toEqual([
      { role: "assistant", text: "[redacted async update]" },
    ]);
    const updates = publishSessionTranscriptUpdateByIdentityMock.mock.calls.map(
      ([update]) => update as Record<string, unknown> & { update?: Record<string, unknown> },
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.update?.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "[redacted async update]" }],
      phase: "final_answer",
      idempotencyKey: "codex-app-server:thread-1:turn-1:async:async-update",
      openclawAsyncDelivery: { itemId: "async-update" },
      __openclaw: { runId: "run-async-update" },
    });
    expect(updates[0]?.update?.message).not.toHaveProperty("openclawAsyncDelivery.questions");
    expect(updates[0]?.update?.message).not.toHaveProperty("__openclaw.runTerminal");
    const persisted = await readMirrorRaw(target);
    expect(persisted).toContain('"runId":"run-async-update"');
    expect(persisted).not.toContain('"runId":"run-async-reconnect"');
  });

  it("retries a durable async callback from the persisted row", async () => {
    const onBlockReply = vi
      .fn()
      .mockRejectedValueOnce(new Error("channel unavailable"))
      .mockResolvedValue(undefined);
    const { target, delivery } = await createDelivery(
      "async-callback-fail",
      "Persisted background update.",
      onBlockReply,
    );

    await expect(deliverAsyncMessageBestEffort(delivery)).resolves.toBe("retry");
    await expect(deliverAsyncMessageBestEffort(delivery)).resolves.toBe("settled");

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply.mock.calls[1]).toEqual(onBlockReply.mock.calls[0]);
    expect(onBlockReply).toHaveBeenCalledWith(
      { text: "Persisted background update." },
      {
        deliveryIntentId: "block-reply:v1:codex-app-server:thread-1:turn-1:async-callback-fail",
      },
    );
    expect(await readMirrorMessages(target)).toEqual([
      { role: "assistant", text: "Persisted background update." },
    ]);
    expect(publishSessionTranscriptUpdateByIdentityMock).toHaveBeenCalledOnce();
  });

  it("does not deliver async messages blocked by before_message_write", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_message_write", handler: () => ({ block: true }) },
      ]),
    );
    const { target, delivery, onBlockReply } = await createDelivery(
      "async-blocked",
      "Blocked update.",
    );
    await expect(deliverAsyncMessageBestEffort(delivery)).resolves.toBe("settled");

    expect(onBlockReply).not.toHaveBeenCalled();
    expect(await readMirrorMessages(target)).toEqual([]);
    expect(publishSessionTranscriptUpdateByIdentityMock).not.toHaveBeenCalled();
  });
});
