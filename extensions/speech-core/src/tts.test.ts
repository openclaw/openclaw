import { rmSync } from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type {
  SpeechProviderPlugin,
  SpeechSynthesisRequest,
} from "openclaw/plugin-sdk/speech-core";
import { afterEach, describe, expect, it, vi } from "vitest";

type MockSpeechSynthesisResult = Awaited<ReturnType<SpeechProviderPlugin["synthesize"]>>;

const synthesizeMock = vi.hoisted(() =>
  vi.fn(
    async (request: SpeechSynthesisRequest): Promise<MockSpeechSynthesisResult> => ({
      audioBuffer: Buffer.from("voice"),
      fileExtension: ".ogg",
      outputFormat: "ogg",
      voiceCompatible: request.target === "voice-note",
    }),
  ),
);

const listSpeechProvidersMock = vi.hoisted(() => vi.fn());
const getSpeechProviderMock = vi.hoisted(() => vi.fn());

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

const { maybeApplyTtsToPayload } = await import("./tts.js");

describe("speech-core Discord voice-note routing", () => {
  afterEach(() => {
    synthesizeMock.mockClear();
  });

  it("marks Discord auto TTS replies as native voice messages", async () => {
    const cfg: OpenClawConfig = {
      messages: {
        tts: {
          enabled: true,
          provider: "mock",
          prefsPath: "/tmp/openclaw-speech-core-tts-test.json",
        },
      },
    };
    const payload: ReplyPayload = {
      text: "This Discord reply should be delivered as a native voice note.",
    };

    let mediaDir: string | undefined;
    try {
      const result = await maybeApplyTtsToPayload({
        payload,
        cfg,
        channel: "discord",
        kind: "final",
      });

      expect(synthesizeMock).toHaveBeenCalledWith(
        expect.objectContaining({ target: "voice-note" }),
      );
      expect(result.audioAsVoice).toBe(true);
      expect(result.mediaUrl).toMatch(/voice-\d+\.ogg$/);

      mediaDir = result.mediaUrl ? path.dirname(result.mediaUrl) : undefined;
    } finally {
      if (mediaDir) {
        rmSync(mediaDir, { recursive: true, force: true });
      }
    }
  });
});
