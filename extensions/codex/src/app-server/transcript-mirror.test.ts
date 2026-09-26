// Codex tests cover transcript mirror plugin behavior.
import { createHash } from "node:crypto";
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
import { attachCodexMirrorRunId } from "./transcript-mirror-attestation.js";
import {
  buildCodexUserPromptMessage,
  codexTranscriptMirrorRuntime,
  importCodexThreadHistoryToTranscript,
  mirrorPromptAtTurnStartBestEffort,
  projectBoundedCodexThreadHistory,
} from "./transcript-mirror.js";
import {
  createTranscriptMirrorTestHarness,
  readMirrorMessages,
  readMirrorRaw,
} from "./transcript-mirror.test-harness.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";

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

// Mirrors transcript-mirror.ts's content fingerprint exactly so test
// expectations stay in sync without exposing the helper publicly.
function expectedFingerprint(message: MirroredAgentMessage): string {
  const payload = JSON.stringify({ role: message.role, content: message.content });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

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
      label: "remote audio-only input",
      caseId: "remote",
      content: [
        {
          type: "audio",
          url: "https://private.example/secret-recording.wav?token=secret-audio-token",
        },
      ],
      expectedText: "[Audio attachment]",
      privateValues: ["private.example", "secret-recording.wav", "secret-audio-token"],
    },
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

  it("mirrors user, assistant, and tool result messages by SQLite identity", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-basic-");
    const userMessage = makeAgentUserMessage({
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });
    const assistantMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "hi there" }],
      timestamp: Date.now() + 1,
    });
    const toolResultMessage = castAgentMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "toolResult", toolCallId: "call-1", content: "read output" }],
      timestamp: Date.now() + 2,
    }) as MirroredAgentMessage;

    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userMessage, assistantMessage, toolResultMessage],
      idempotencyScope: "scope-1",
    });

    const raw = await readMirrorRaw(target);
    expect(raw).toContain('"role":"user"');
    expect(raw).toContain('"content":[{"type":"text","text":"hello"}]');
    expect(raw).toContain('"role":"assistant"');
    expect(raw).toContain('"content":[{"type":"text","text":"hi there"}]');
    expect(raw).toContain('"role":"toolResult"');
    expect(raw).toContain('"toolCallId":"call-1"');
    expect(raw).toContain('"content":"read output"');
    expect(raw).toContain(`"idempotencyKey":"scope-1:user:${expectedFingerprint(userMessage)}"`);
    expect(raw).toContain(
      `"idempotencyKey":"scope-1:assistant:${expectedFingerprint(assistantMessage)}"`,
    );
    expect(raw).toContain(
      `"idempotencyKey":"scope-1:toolResult:${expectedFingerprint(toolResultMessage)}"`,
    );
    await expect(fs.readFile(target.bogusSessionFile, "utf8")).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });

  it("preserves gateway user-turn identity across Codex transcript mirroring", async () => {
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

  it("emits message-bearing updates for newly appended mirrored messages only", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-live-updates-");
    const userMessage = mirroredUser("show me live", "turn-1:prompt", Date.now());

    const firstMirror = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });
    const secondMirror = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });

    const updates = publishSessionTranscriptUpdateByIdentityMock.mock.calls.map(
      ([update]) => update as Record<string, unknown> & { update?: Record<string, unknown> },
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.sessionKey).toBe(target.sessionKey);
    expect(updates[0]?.storePath).toBe(target.storePath);
    expect(updates[0]?.update?.messageId).toEqual(expect.any(String));
    expect(updates[0]?.update?.message).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "show me live" }],
      idempotencyKey: "codex-app-server:thread-1:turn-1:prompt",
    });
    expect(updates[0]?.update?.messageSeq).toBe(1);
    expect(firstMirror.userMessageReceipts).toHaveLength(1);
    expect(firstMirror.userMessageReceipts[0]?.message).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "show me live" }],
      idempotencyKey: "codex-app-server:thread-1:turn-1:prompt",
    });
    expect(secondMirror.userMessageReceipts).toHaveLength(1);
    expect(secondMirror.userMessageReceipts[0]?.message).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "show me live" }],
      idempotencyKey: "codex-app-server:thread-1:turn-1:prompt",
    });
  });

  it("emits stable sequence numbers for multi-message mirror batches", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-seq-");

    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [
        mirroredUser("first", "turn-1:prompt", Date.now()),
        mirroredAssistant("second", "turn-1:assistant", Date.now() + 1),
      ],
      idempotencyScope: "codex-app-server:thread-1",
      runId: "openclaw-run-1",
      runMirrorIdentityPrefix: "turn-1:",
      terminalAssistantOwner: {
        mirrorIdentity: "turn-1:assistant",
        runId: "openclaw-run-1",
      },
    });

    const updates = publishSessionTranscriptUpdateByIdentityMock.mock.calls.map(
      ([update]) => update as Record<string, unknown> & { update?: Record<string, unknown> },
    );
    expect(updates.map((update) => update.update?.messageSeq)).toEqual([1, 2]);
    expect(updates.map((update) => update.update?.runId)).toEqual([undefined, "openclaw-run-1"]);
    expect(
      updates.map(
        (update) =>
          (update.update?.message as { __openclaw?: { runId?: string } } | undefined)?.[
            "__openclaw"
          ]?.runId,
      ),
    ).toEqual(["openclaw-run-1", "openclaw-run-1"]);
    expect(
      updates.map(
        (update) =>
          (update.update?.message as { __openclaw?: { runTerminal?: boolean } } | undefined)?.[
            "__openclaw"
          ]?.runTerminal,
      ),
    ).toEqual([undefined, true]);
    expect(
      updates.map((update) => {
        const message = update.update?.message as { role?: string } | undefined;
        return message?.role;
      }),
    ).toEqual(["user", "assistant"]);
  });

  it.each([false, true])(
    "prepares only the owned terminal media row before persistence and publication (skip hooks: %s)",
    async (skipBeforeMessageWriteHooks) => {
      const target = await createSqliteMirrorTarget("openclaw-codex-mirror-media-owner-");
      const sourceText = "Artifacts ready\nMEDIA:./artifact.json";
      const rewrittenText = skipBeforeMessageWriteHooks
        ? sourceText
        : `${sourceText}\nMEDIA:./hook-only.json`;
      const prepareAssistantTranscriptMessage = vi.fn((message: AssistantMessage) => ({
        ...message,
        openclawDelivery: { mediaUrls: ["./artifact.json"] },
      }));
      const beforeMessageWrite = vi.fn((input: unknown) => {
        const message = (input as { message: AgentMessage }).message;
        return message.role === "assistant" &&
          message.content.some((part) => part.type === "text" && part.text === sourceText)
          ? { message: { ...message, content: [{ type: "text", text: rewrittenText }] } }
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
      if (skipBeforeMessageWriteHooks) {
        await mirrorCodexAppServerTranscript({
          ...target,
          messages,
          runId: "run-media",
          idempotencyScope: "codex-app-server:thread-1",
          runMirrorIdentityPrefix: "turn-1:",
          terminalAssistantOwner: { mirrorIdentity: "turn-1:assistant", runId: "run-media" },
          prepareAssistantTranscriptMessage,
          skipBeforeMessageWriteHooks,
        });
      } else {
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
      }

      expect(beforeMessageWrite).toHaveBeenCalledTimes(skipBeforeMessageWriteHooks ? 0 : 5);
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
      });
      const persisted = (await readSessionTranscriptEvents(target)).flatMap((event) =>
        event && typeof event === "object" && "message" in event ? [event.message] : [],
      );
      expect(persisted).toEqual(published);
    },
  );

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

  it("reports final assistant ownership for new and idempotent mirrors", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-assistant-owned-");
    const assistantMessage = mirroredAssistant("owned once", "turn-1:assistant", Date.now());

    const firstMirror = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [assistantMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });
    const secondMirror = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [assistantMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });

    expect(firstMirror.assistantMirrorIdentitiesOwned).toEqual(["turn-1:assistant"]);
    expect(secondMirror.assistantMirrorIdentitiesOwned).toEqual(["turn-1:assistant"]);
    expect(
      (await readMirrorMessages(target)).filter((message) => message.role === "assistant"),
    ).toHaveLength(1);
  });

  it.each(["retain", "omit", "in-place", "forge"] as const)(
    "sender provenance in Codex mirrors rejects hook reassignment: %s",
    async (mode) => {
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_message_write",
            handler: (event) => {
              const message = (event as { message: { __openclaw: Record<string, unknown> } })
                .message;
              if (mode === "omit") {
                delete message["__openclaw"].senderIdentity;
              }
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
        mode === "retain" ? { type: "profile", id: "author" } : undefined,
      ]);
    },
  );

  it("returns the persisted user message for duplicate mirror hits", async () => {
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
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-duplicates-");
    const sourceMessage = makeAgentUserMessage({
      content: [{ type: "text", text: "secret prompt" }],
      timestamp: Date.now(),
    });

    const first = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [sourceMessage],
      idempotencyScope: "scope-1",
    });
    const second = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [sourceMessage],
      idempotencyScope: "scope-1",
    });

    expect(first.userMessageReceipts[0]?.message.content).toEqual([
      { type: "text", text: "[redacted by hook]" },
    ]);
    expect(second.userMessageReceipts[0]?.message.content).toEqual([
      { type: "text", text: "[redacted by hook]" },
    ]);
    expect(JSON.stringify(second.userMessageReceipts)).not.toContain("secret prompt");
    expect(
      (await readMirrorMessages(target)).filter((message) => message.role === "user"),
    ).toHaveLength(1);
  });

  it("preserves the computed idempotency key when hooks rewrite message keys", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => ({
            message: castAgentMessage({
              ...((event as { message: unknown }).message as Record<string, unknown>),
              idempotencyKey: "hook-rewritten-key",
            }),
          }),
        },
      ]),
    );
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-key-hook-");
    const sourceMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });

    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [sourceMessage],
      idempotencyScope: "scope-1",
    });

    const raw = await readMirrorRaw(target);
    expect(raw).toContain(
      `"idempotencyKey":"scope-1:assistant:${expectedFingerprint(sourceMessage)}"`,
    );
    expect(raw).not.toContain("hook-rewritten-key");
  });

  it("respects before_message_write blocking decisions", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_message_write", handler: () => ({ block: true }) },
      ]),
    );
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-blocked-");

    const result = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [mirroredAssistant("should not persist", "turn-1:assistant", Date.now())],
      idempotencyScope: "scope-1",
    });

    expect(result.assistantMirrorIdentitiesOwned).toEqual(["turn-1:assistant"]);
    expect(await readMirrorMessages(target)).toEqual([]);
  });

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

  it("returns the user anchor for a turn without an assistant row", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-user-terminal-");
    const userMessage = mirroredUser("run silently", "turn-1:prompt", Date.now());

    const mirrorOutcome = await mirrorTranscriptBestEffort({
      params: {
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
        suppressNextUserMessagePersistence: true,
      } as unknown as Parameters<typeof mirrorTranscriptBestEffort>[0]["params"],
      result: {
        messagesSnapshot: [userMessage],
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
          (event as { message?: { role?: unknown } }).message?.role === "user",
        ),
    );

    expect(mirrorOutcome.assistantTranscriptOwned).toBe(false);
    expect(mirrorOutcome.terminalAnchor?.entryId).toBe(terminalEvent?.id);
  });

  describe("projected transcript persistence", () => {
    registerCodexEventProjectorTestLifecycle();

    it.each([true, false])(
      "keeps failed attempt diagnostics without taking deferred run ownership (deferred: %s)",
      async (deferTerminalLifecycle) => {
        const target = await createSqliteMirrorTarget("openclaw-codex-mirror-retry-owner-");
        const params: EmbeddedRunAttemptParams = {
          ...(await createProjectorParams()),
          ...target,
          sessionTarget: target,
          workspaceDir: path.dirname(target.storePath),
          suppressNextUserMessagePersistence: true,
          deferTerminalLifecycle,
        };
        const finalRunId = deferTerminalLifecycle ? params.runId : "run-2";
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
                items: [
                  { type: "agentMessage", id: `answer-${attempt.turnId}`, text: attempt.text },
                ],
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
        if (deferTerminalLifecycle) {
          expect(messages?.[0]).not.toHaveProperty("__openclaw.runTerminal");
          expect(
            publishSessionTranscriptUpdateByIdentityMock.mock.calls[0]?.[0].update,
          ).not.toHaveProperty("runId");
        } else {
          expect(messages?.[0]).toHaveProperty("__openclaw.runTerminal", true);
          expect(
            publishSessionTranscriptUpdateByIdentityMock.mock.calls[0]?.[0].update,
          ).toHaveProperty("runId", params.runId);
        }
        expect(
          publishSessionTranscriptUpdateByIdentityMock.mock.calls[1]?.[0].update,
        ).toHaveProperty("runId", finalRunId);
      },
    );

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

  it("dedupes prior-turn entries re-emitted into a later turn's snapshot", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-reemit-");
    const userTurn1 = mirroredUser("msg1", "turn-1:prompt", Date.now());
    const assistantTurn1 = mirroredAssistant("reply1", "turn-1:assistant", Date.now() + 1);
    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userTurn1, assistantTurn1],
      idempotencyScope: "codex-app-server:thread-X",
    });

    const userTurn2 = mirroredUser("msg2", "turn-2:prompt", Date.now() + 2);
    const assistantTurn2 = mirroredAssistant("reply2", "turn-2:assistant", Date.now() + 3);
    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userTurn1, assistantTurn1, userTurn2, assistantTurn2],
      idempotencyScope: "codex-app-server:thread-X",
    });

    expect(await readMirrorMessages(target)).toEqual([
      { role: "user", text: "msg1" },
      { role: "assistant", text: "reply1" },
      { role: "user", text: "msg2" },
      { role: "assistant", text: "reply2" },
    ]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
