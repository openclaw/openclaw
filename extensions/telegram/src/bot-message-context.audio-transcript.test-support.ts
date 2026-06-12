// Telegram plugin module implements bot message context.audio transcript support behavior.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transcribeFirstAudioMock = vi.fn();
const transcribeFirstAudioWithTelemetryMock = vi.fn();
const DEFAULT_MODEL = "anthropic/claude-opus-4-5";
const DEFAULT_WORKSPACE = "/tmp/openclaw";
const DEFAULT_MENTION_PATTERN = "\\bbot\\b";

vi.mock("./media-understanding.runtime.js", () => ({
  transcribeFirstAudio: (...args: unknown[]) => transcribeFirstAudioMock(...args),
  transcribeFirstAudioWithTelemetry: (...args: unknown[]) =>
    transcribeFirstAudioWithTelemetryMock(...args),
}));

const { buildTelegramMessageContextForTest } =
  await import("./bot-message-context.test-harness.js");

async function buildGroupVoiceContext(params: {
  messageId: number;
  chatId: number;
  title: string;
  date: number;
  fromId: number;
  firstName: string;
  fileId: string;
  mediaPath: string;
  mediaSize?: number;
  mimeType?: string;
  groupDisableAudioPreflight?: boolean;
  topicDisableAudioPreflight?: boolean;
}) {
  const groupConfig = {
    requireMention: true,
    ...(params.groupDisableAudioPreflight === undefined
      ? {}
      : { disableAudioPreflight: params.groupDisableAudioPreflight }),
  };
  const topicConfig =
    params.topicDisableAudioPreflight === undefined
      ? undefined
      : { disableAudioPreflight: params.topicDisableAudioPreflight };

  return buildTelegramMessageContextForTest({
    message: {
      message_id: params.messageId,
      chat: { id: params.chatId, type: "supergroup", title: params.title },
      date: params.date,
      text: undefined,
      from: { id: params.fromId, first_name: params.firstName },
      voice: {
        file_id: params.fileId,
        file_unique_id: `${params.fileId}-unique`,
        duration: 7,
        mime_type: params.mimeType ?? "audio/ogg",
      },
    },
    allMedia: [
      {
        path: params.mediaPath,
        contentType: params.mimeType ?? "audio/ogg",
        size: params.mediaSize ?? 4096,
        mediaKind: "voice",
        telegramFileId: params.fileId,
        telegramFileUniqueId: `${params.fileId}-unique`,
        telegramFilePath: `voice/${params.fileId}.ogg`,
        telegramMimeType: params.mimeType ?? "audio/ogg",
        durationSeconds: 7,
      },
    ],
    options: { forceWasMentioned: true },
    cfg: {
      agents: { defaults: { model: DEFAULT_MODEL, workspace: DEFAULT_WORKSPACE } },
      channels: { telegram: {} },
      messages: { groupChat: { mentionPatterns: [DEFAULT_MENTION_PATTERN] } },
    },
    resolveGroupActivation: () => true,
    resolveGroupRequireMention: () => true,
    resolveTelegramGroupConfig: () => ({
      groupConfig,
      topicConfig,
    }),
  });
}

function transcriptHash(transcript: string): string {
  return createHash("sha256").update(transcript).digest("hex");
}

function successfulPreflightResult(transcript: string) {
  return {
    transcript,
    telemetry: {
      status: "success",
      provider: "openai",
      model: "whisper-1",
      baseUrl: "https://stt.example.test/v1",
      durationMs: 24,
      transcript: {
        length: transcript.length,
        sha256: transcriptHash(transcript),
        trusted: false,
        truncated: false,
        enteredAgentContext: false,
      },
    },
  };
}

function expectTranscriptRendered(
  ctx: Awaited<ReturnType<typeof buildGroupVoiceContext>>,
  transcript: string,
) {
  const framed = `[Audio transcript (machine-generated, untrusted)]: ${JSON.stringify(transcript)}`;
  expect(ctx).not.toBeNull();
  expect(ctx?.ctxPayload?.BodyForAgent).toBe(framed);
  expect(ctx?.ctxPayload?.Body).toContain(framed);
  expect(ctx?.ctxPayload?.Body).not.toContain("<media:audio>");
  expect(ctx?.ctxPayload?.MediaTranscribedIndexes).toEqual([0]);
}

function expectAudioPlaceholderRendered(ctx: Awaited<ReturnType<typeof buildGroupVoiceContext>>) {
  expect(ctx).not.toBeNull();
  expect(ctx?.ctxPayload?.Body).toContain("<media:audio>");
}

describe("buildTelegramMessageContext audio transcript body", () => {
  beforeEach(() => {
    transcribeFirstAudioMock.mockReset();
    transcribeFirstAudioWithTelemetryMock.mockReset();
  });

  it("uses preflight transcript as BodyForAgent for mention-gated group voice messages", async () => {
    transcribeFirstAudioWithTelemetryMock.mockResolvedValueOnce(
      successfulPreflightResult("hey bot please help"),
    );

    const ctx = await buildGroupVoiceContext({
      messageId: 1,
      chatId: -1001234567890,
      title: "Test Group",
      date: 1700000000,
      fromId: 42,
      firstName: "Alice",
      fileId: "voice-1",
      mediaPath: "/tmp/voice.ogg",
    });

    expect(transcribeFirstAudioWithTelemetryMock).toHaveBeenCalledTimes(1);
    expectTranscriptRendered(ctx, "hey bot please help");
  });

  it("skips preflight transcription when disableAudioPreflight is true", async () => {
    transcribeFirstAudioMock.mockClear();

    const ctx = await buildGroupVoiceContext({
      messageId: 2,
      chatId: -1001234567891,
      title: "Test Group 2",
      date: 1700000100,
      fromId: 43,
      firstName: "Bob",
      fileId: "voice-2",
      mediaPath: "/tmp/voice2.ogg",
      groupDisableAudioPreflight: true,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(transcribeFirstAudioWithTelemetryMock).not.toHaveBeenCalled();
    expectAudioPlaceholderRendered(ctx);
  });

  it("uses topic disableAudioPreflight=false to override group disableAudioPreflight=true", async () => {
    transcribeFirstAudioWithTelemetryMock.mockResolvedValueOnce(
      successfulPreflightResult("topic override transcript"),
    );

    const ctx = await buildGroupVoiceContext({
      messageId: 3,
      chatId: -1001234567892,
      title: "Test Group 3",
      date: 1700000200,
      fromId: 44,
      firstName: "Cara",
      fileId: "voice-3",
      mediaPath: "/tmp/voice3.ogg",
      groupDisableAudioPreflight: true,
      topicDisableAudioPreflight: false,
    });

    expect(transcribeFirstAudioWithTelemetryMock).toHaveBeenCalledTimes(1);
    expectTranscriptRendered(ctx, "topic override transcript");
  });

  it("uses topic disableAudioPreflight=true to override group disableAudioPreflight=false", async () => {
    transcribeFirstAudioMock.mockClear();

    const ctx = await buildGroupVoiceContext({
      messageId: 4,
      chatId: -1001234567893,
      title: "Test Group 4",
      date: 1700000300,
      fromId: 45,
      firstName: "Dan",
      fileId: "voice-4",
      mediaPath: "/tmp/voice4.ogg",
      groupDisableAudioPreflight: false,
      topicDisableAudioPreflight: true,
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(transcribeFirstAudioWithTelemetryMock).not.toHaveBeenCalled();
    expectAudioPlaceholderRendered(ctx);
  });

  it("surfaces per-message voice STT handoff telemetry in agent context", async () => {
    const transcript = "hey bot please help";
    transcribeFirstAudioWithTelemetryMock.mockResolvedValueOnce(
      successfulPreflightResult(transcript),
    );

    const ctx = await buildGroupVoiceContext({
      messageId: 5,
      chatId: -1001234567894,
      title: "Test Group 5",
      date: 1700000400,
      fromId: 46,
      firstName: "Eve",
      fileId: "voice-5",
      mediaPath: "/tmp/voice5.ogg",
      mediaSize: 8192,
    });

    const ctxPayload = ctx?.ctxPayload as
      | {
          TelegramVoiceSttTelemetry?: unknown;
          UntrustedStructuredContext?: Array<{ type?: string; payload?: unknown }>;
        }
      | undefined;
    const handoff = ctxPayload?.UntrustedStructuredContext?.find(
      (entry) => entry.type === "telegram_voice_stt_handoff",
    )?.payload as Record<string, unknown> | undefined;

    expectTranscriptRendered(ctx, transcript);
    expect(handoff).toMatchObject({
      media: {
        kind: "voice",
        fileId: "voice-5",
        fileUniqueId: "voice-5-unique",
        mediaReference: "voice/voice-5.ogg",
        durationSeconds: 7,
      },
      download: {
        bytes: 8192,
        mime: "audio/ogg",
        path: "/tmp/voice5.ogg",
      },
      stt: {
        provider: "openai",
        model: "whisper-1",
        baseUrl: "https://stt.example.test/v1",
        status: "success",
      },
      transcript: {
        length: transcript.length,
        sha256: transcriptHash(transcript),
        trusted: false,
        truncated: false,
        enteredAgentContext: true,
      },
    });
    expect(ctxPayload?.TelegramVoiceSttTelemetry).toEqual(handoff);
  });

  it("surfaces failed voice STT state instead of presenting bad text as speech", async () => {
    transcribeFirstAudioWithTelemetryMock.mockResolvedValueOnce({
      transcript: undefined,
      telemetry: {
        status: "timeout",
        durationMs: 30_001,
        errorClass: "TimeoutError",
        transcript: {
          length: 0,
          trusted: false,
          truncated: false,
          enteredAgentContext: false,
        },
      },
    });

    const ctx = await buildGroupVoiceContext({
      messageId: 6,
      chatId: -1001234567895,
      title: "Test Group 6",
      date: 1700000500,
      fromId: 47,
      firstName: "Frank",
      fileId: "voice-6",
      mediaPath: "/tmp/voice6.ogg",
    });

    const ctxPayload = ctx?.ctxPayload as
      | {
          BodyForAgent?: string;
          TelegramVoiceSttTelemetry?: unknown;
          UntrustedStructuredContext?: Array<{ type?: string; payload?: unknown }>;
        }
      | undefined;
    const handoff = ctxPayload?.UntrustedStructuredContext?.find(
      (entry) => entry.type === "telegram_voice_stt_handoff",
    )?.payload as Record<string, unknown> | undefined;

    expect(ctxPayload?.BodyForAgent).toContain("Audio transcript unavailable");
    expect(ctxPayload?.BodyForAgent).toContain("timeout");
    expect(ctxPayload?.BodyForAgent).not.toContain("[Audio transcript (machine-generated");
    expect(handoff).toMatchObject({
      stt: {
        status: "timeout",
        errorClass: "TimeoutError",
      },
      transcript: {
        length: 0,
        trusted: false,
        truncated: false,
        enteredAgentContext: false,
      },
    });
    expect(ctxPayload?.TelegramVoiceSttTelemetry).toEqual(handoff);
  });

  it("labels truncated voice STT transcripts in body and telemetry", async () => {
    const transcript = "partial voice text";
    transcribeFirstAudioWithTelemetryMock.mockResolvedValueOnce({
      transcript,
      telemetry: {
        status: "truncated",
        provider: "openai",
        model: "whisper-1",
        durationMs: 88,
        transcript: {
          length: transcript.length,
          sha256: transcriptHash(transcript),
          trusted: false,
          truncated: true,
          enteredAgentContext: false,
        },
      },
    });

    const ctx = await buildGroupVoiceContext({
      messageId: 7,
      chatId: -1001234567896,
      title: "Test Group 7",
      date: 1700000600,
      fromId: 48,
      firstName: "Grace",
      fileId: "voice-7",
      mediaPath: "/tmp/voice7.ogg",
    });

    const ctxPayload = ctx?.ctxPayload as
      | {
          BodyForAgent?: string;
          UntrustedStructuredContext?: Array<{ type?: string; payload?: unknown }>;
        }
      | undefined;
    const handoff = ctxPayload?.UntrustedStructuredContext?.find(
      (entry) => entry.type === "telegram_voice_stt_handoff",
    )?.payload as Record<string, unknown> | undefined;

    expect(ctxPayload?.BodyForAgent).toContain("machine-generated, untrusted, truncated");
    expect(handoff).toMatchObject({
      stt: {
        status: "truncated",
      },
      transcript: {
        length: transcript.length,
        sha256: transcriptHash(transcript),
        trusted: false,
        truncated: true,
        enteredAgentContext: true,
      },
    });
  });
});
