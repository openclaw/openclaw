import { rmSync } from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { SpeechProviderPlugin, SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech-core";
import { afterEach, describe, expect, it, vi } from "vitest";

type MockSpeechSynthesisResult = Awaited<ReturnType<SpeechProviderPlugin["synthesize"]>>;

const { getSpeechProviderMock, listSpeechProvidersMock, runFfmpegMock, synthesizeMock } =
  vi.hoisted(() => ({
    getSpeechProviderMock: vi.fn(),
    listSpeechProvidersMock: vi.fn(),
    runFfmpegMock: vi.fn(),
    synthesizeMock: vi.fn(
      async (request: SpeechSynthesisRequest): Promise<MockSpeechSynthesisResult> => ({
        audioBuffer: Buffer.from("voice"),
        fileExtension: ".ogg",
        outputFormat: "ogg",
        voiceCompatible: request.target === "voice-note",
      }),
    ),
  }));

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    runFfmpeg: (...args: Parameters<typeof actual.runFfmpeg>) => runFfmpegMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/channel-targets", () => ({
  normalizeChannelId: (channel: string | undefined) => channel?.trim().toLowerCase() ?? null,
}));

vi.mock("../api.js", async () => {
  const actual = await vi.importActual<typeof import("../api.js")>("../api.js");
  const mockProvider: SpeechProviderPlugin = {
    id: "mock",
    label: "Mock",
    autoSelectOrder: 1,
    isConfigured: () => true,
    synthesize: synthesizeMock,
  };
  listSpeechProvidersMock.mockImplementation(() => [mockProvider]);
  getSpeechProviderMock.mockImplementation((providerId: string) =>
    providerId === "mock" ? mockProvider : null,
  );
  return {
    ...actual,
    canonicalizeSpeechProviderId: (providerId: string | undefined) =>
      providerId?.trim().toLowerCase() || undefined,
    normalizeSpeechProviderId: (providerId: string | undefined) =>
      providerId?.trim().toLowerCase() || undefined,
    getSpeechProvider: getSpeechProviderMock,
    listSpeechProviders: listSpeechProvidersMock,
    scheduleCleanup: vi.fn(),
  };
});

const { _test, maybeApplyTtsToPayload } = await import("./tts.js");

const nativeVoiceNoteChannels = ["discord", "feishu", "matrix", "telegram", "whatsapp"] as const;

function createTtsConfig(prefsName: string): OpenClawConfig {
  return {
    messages: {
      tts: {
        enabled: true,
        provider: "mock",
        prefsPath: `/tmp/${prefsName}.json`,
      },
    },
  };
}

async function expectTtsPayloadResult(params: {
  channel: string;
  prefsName: string;
  text: string;
  target: "voice-note" | "audio-file";
  audioAsVoice: true | undefined;
}) {
  const cfg = createTtsConfig(params.prefsName);
  let mediaDir: string | undefined;
  try {
    const result = await maybeApplyTtsToPayload({
      payload: { text: params.text },
      cfg,
      channel: params.channel,
      kind: "final",
    });

    expect(synthesizeMock).toHaveBeenCalledWith(expect.objectContaining({ target: params.target }));
    expect(result.audioAsVoice).toBe(params.audioAsVoice);
    expect(result.mediaUrl).toMatch(/voice-\d+\.ogg$/);

    mediaDir = result.mediaUrl ? path.dirname(result.mediaUrl) : undefined;
  } finally {
    if (mediaDir) {
      rmSync(mediaDir, { recursive: true, force: true });
    }
  }
}

afterEach(() => {
  synthesizeMock.mockClear();
  runFfmpegMock.mockReset();
});

describe("speech-core native voice-note routing", () => {
  it("keeps native voice-note channel support centralized", () => {
    for (const channel of nativeVoiceNoteChannels) {
      expect(_test.supportsNativeVoiceNoteTts(channel)).toBe(true);
      expect(_test.supportsNativeVoiceNoteTts(channel.toUpperCase())).toBe(true);
    }
    expect(_test.supportsNativeVoiceNoteTts("slack")).toBe(false);
    expect(_test.supportsNativeVoiceNoteTts(undefined)).toBe(false);
  });

  it("marks Discord auto TTS replies as native voice messages", async () => {
    await expectTtsPayloadResult({
      channel: "discord",
      prefsName: "openclaw-speech-core-tts-test",
      text: "This Discord reply should be delivered as a native voice note.",
      target: "voice-note",
      audioAsVoice: true,
    });
  });

  it("keeps non-native voice-note channels as regular audio files", async () => {
    await expectTtsPayloadResult({
      channel: "slack",
      prefsName: "openclaw-speech-core-tts-slack-test",
      text: "Slack replies should be delivered as regular audio attachments.",
      target: "audio-file",
      audioAsVoice: undefined,
    });
  });
});

describe("maybeNormalizeVoiceBubbleAudio", () => {
  it("transcodes webm voice-note audio to ogg for WhatsApp delivery", async () => {
    runFfmpegMock.mockResolvedValueOnce("");

    const result = await _test.maybeNormalizeVoiceBubbleAudio({
      audioPath: "/tmp/reply.webm",
      channelId: "whatsapp",
    });

    expect(result).toBe("/tmp/reply.ogg");
    expect(runFfmpegMock).toHaveBeenCalledWith(
      expect.arrayContaining(["-i", "/tmp/reply.webm", path.join("/tmp", "reply.ogg")]),
    );
  });

  it("keeps non-webm audio unchanged", async () => {
    const result = await _test.maybeNormalizeVoiceBubbleAudio({
      audioPath: "/tmp/reply.mp3",
      channelId: "whatsapp",
    });

    expect(result).toBe("/tmp/reply.mp3");
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });
});
