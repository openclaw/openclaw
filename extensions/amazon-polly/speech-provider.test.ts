import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPollySpeechProvider } from "./speech-provider.js";
import * as ttsModule from "./tts.js";

const runFfmpegMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  runFfmpeg: runFfmpegMock,
}));

vi.mock("node:fs/promises", () => ({
  default: {
    writeFile: vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
    readFile: vi
      .fn<(...args: unknown[]) => Promise<Buffer>>()
      .mockResolvedValue(Buffer.from([0x4f, 0x70, 0x75, 0x73])),
    unlink: vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
  },
}));

const TEST_CFG = {} as OpenClawConfig;

describe("buildPollySpeechProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runFfmpegMock.mockReset();
  });

  it("has correct id and label", () => {
    const provider = buildPollySpeechProvider();
    expect(provider.id).toBe("amazon-polly");
    expect(provider.label).toBe("Amazon Polly");
    expect(provider.aliases).toEqual(["polly"]);
    expect(provider.autoSelectOrder).toBe(25);
  });

  it("synthesizes MP3 for audio-file target", async () => {
    const provider = buildPollySpeechProvider();
    const fakeBuffer = Buffer.from([0xff, 0xfb, 0x90, 0x00]);

    const synthesizeSpy = vi.spyOn(ttsModule, "pollySynthesize").mockResolvedValue(fakeBuffer);

    const result = await provider.synthesize({
      text: "Hello world",
      cfg: TEST_CFG,
      providerConfig: {
        enabled: true,
        region: "us-east-1",
        voice: "Joanna",
        engine: "neural",
      },
      providerOverrides: {},
      timeoutMs: 10_000,
      target: "audio-file",
    });

    expect(result.outputFormat).toBe("mp3");
    expect(result.fileExtension).toBe(".mp3");
    expect(result.voiceCompatible).toBe(false);
    expect(result.audioBuffer).toBe(fakeBuffer);
    expect(synthesizeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceId: "Joanna",
        engine: "neural",
        outputFormat: "mp3",
        region: "us-east-1",
      }),
    );
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it("synthesizes voice-note with ffmpeg opus conversion", async () => {
    const provider = buildPollySpeechProvider();
    const fakeVorbisBuffer = Buffer.from([0x4f, 0x67, 0x67, 0x53]);

    vi.spyOn(ttsModule, "pollySynthesize").mockResolvedValue(fakeVorbisBuffer);
    runFfmpegMock.mockResolvedValue("");

    const result = await provider.synthesize({
      text: "Hello world",
      cfg: TEST_CFG,
      providerConfig: {
        enabled: true,
        region: "us-east-1",
        voice: "Joanna",
        engine: "neural",
      },
      providerOverrides: {},
      timeoutMs: 10_000,
      target: "voice-note",
    });

    expect(result.outputFormat).toBe("ogg_opus");
    expect(result.fileExtension).toBe(".ogg");
    expect(result.voiceCompatible).toBe(true);
    // Verify ffmpeg was called with opus conversion args
    expect(runFfmpegMock).toHaveBeenCalledTimes(1);
    const ffmpegArgs = runFfmpegMock.mock.calls[0][0] as string[];
    expect(ffmpegArgs).toContain("-c:a");
    expect(ffmpegArgs).toContain("libopus");
    expect(ffmpegArgs).toContain("-b:a");
    expect(ffmpegArgs).toContain("64k");
    expect(ffmpegArgs).toContain("-ar");
    expect(ffmpegArgs).toContain("48000");
  });

  it("applies voice override from providerOverrides", async () => {
    const provider = buildPollySpeechProvider();
    const fakeBuffer = Buffer.from([0x01]);

    const synthesizeSpy = vi.spyOn(ttsModule, "pollySynthesize").mockResolvedValue(fakeBuffer);

    await provider.synthesize({
      text: "Hola mundo",
      cfg: TEST_CFG,
      providerConfig: {
        enabled: true,
        region: "us-east-1",
        voice: "Joanna",
        engine: "neural",
      },
      providerOverrides: { voice: "Mia", engine: "standard" },
      timeoutMs: 10_000,
      target: "audio-file",
    });

    expect(synthesizeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceId: "Mia",
        engine: "standard",
      }),
    );
  });

  it("isConfigured returns true when AWS credentials are available", () => {
    const provider = buildPollySpeechProvider();
    const originalEnv = process.env.AWS_ACCESS_KEY_ID;
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";

    try {
      expect(
        provider.isConfigured({
          providerConfig: { enabled: true },
          timeoutMs: 10_000,
        }),
      ).toBe(true);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AWS_ACCESS_KEY_ID;
      } else {
        process.env.AWS_ACCESS_KEY_ID = originalEnv;
      }
    }
  });

  it("isConfigured returns false when disabled", () => {
    const provider = buildPollySpeechProvider();
    const originalEnv = process.env.AWS_ACCESS_KEY_ID;
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";

    try {
      expect(
        provider.isConfigured({
          providerConfig: { enabled: false },
          timeoutMs: 10_000,
        }),
      ).toBe(false);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AWS_ACCESS_KEY_ID;
      } else {
        process.env.AWS_ACCESS_KEY_ID = originalEnv;
      }
    }
  });
});

describe("buildPollySpeechProvider resolveConfig", () => {
  it("returns default config for empty rawConfig", () => {
    const provider = buildPollySpeechProvider();
    const config = provider.resolveConfig!({
      rawConfig: {},
      cfg: TEST_CFG,
      timeoutMs: 10_000,
    });

    expect(config).toEqual(
      expect.objectContaining({
        enabled: true,
        voice: "Joanna",
        engine: "neural",
      }),
    );
  });

  it("reads nested provider config", () => {
    const provider = buildPollySpeechProvider();
    const config = provider.resolveConfig!({
      rawConfig: {
        providers: {
          "amazon-polly": {
            voice: "Mia",
            engine: "standard",
            region: "eu-west-1",
          },
        },
      },
      cfg: TEST_CFG,
      timeoutMs: 10_000,
    });

    expect(config).toEqual(
      expect.objectContaining({
        voice: "Mia",
        engine: "standard",
        region: "eu-west-1",
      }),
    );
  });
});

describe("buildPollySpeechProvider listVoices", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps Polly voice entries to SpeechVoiceOption format", async () => {
    const provider = buildPollySpeechProvider();

    vi.spyOn(ttsModule, "pollyListVoices").mockResolvedValue([
      {
        id: "Joanna",
        name: "Joanna",
        gender: "Female",
        languageCode: "en-US",
        languageName: "US English",
        supportedEngines: ["neural", "standard"],
      },
    ]);

    const voices = await provider.listVoices!({
      providerConfig: { region: "us-east-1", engine: "neural" },
    });

    expect(voices).toEqual([
      {
        id: "Joanna",
        name: "Joanna",
        gender: "Female",
        locale: "en-US",
        description: "US English",
      },
    ]);
  });
});
