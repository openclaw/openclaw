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

  it("has correct id, label, and aliases", () => {
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
        voice: "Ruth",
        engine: "generative",
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
        voiceId: "Ruth",
        engine: "generative",
        outputFormat: "mp3",
        region: "us-east-1",
      }),
    );
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it("synthesizes voice-note with ffmpeg opus conversion", async () => {
    const provider = buildPollySpeechProvider();
    const fakeMp3Buffer = Buffer.from([0xff, 0xfb, 0x90, 0x00]);

    vi.spyOn(ttsModule, "pollySynthesize").mockResolvedValue(fakeMp3Buffer);
    runFfmpegMock.mockResolvedValue("");

    const result = await provider.synthesize({
      text: "Hello world",
      cfg: TEST_CFG,
      providerConfig: {
        enabled: true,
        region: "us-east-1",
        voice: "Ruth",
        engine: "generative",
      },
      providerOverrides: {},
      timeoutMs: 10_000,
      target: "voice-note",
    });

    expect(result.outputFormat).toBe("ogg_vorbis");
    expect(result.fileExtension).toBe(".ogg");
    expect(result.voiceCompatible).toBe(true);
    expect(runFfmpegMock).toHaveBeenCalledTimes(1);
    const ffmpegArgs = runFfmpegMock.mock.calls[0][0] as string[];
    expect(ffmpegArgs).toContain("-c:a");
    expect(ffmpegArgs).toContain("libopus");
    expect(ffmpegArgs).toContain("-b:a");
    expect(ffmpegArgs).toContain("64k");
  });

  it("applies voice override from providerOverrides", async () => {
    const provider = buildPollySpeechProvider();
    const fakeBuffer = Buffer.from([0x01]);

    const synthesizeSpy = vi.spyOn(ttsModule, "pollySynthesize").mockResolvedValue(fakeBuffer);

    await provider.synthesize({
      text: "Hello",
      cfg: TEST_CFG,
      providerConfig: {
        enabled: true,
        region: "us-east-1",
        voice: "Ruth",
        engine: "generative",
      },
      providerOverrides: { voice: "Stephen", engine: "neural" },
      timeoutMs: 10_000,
      target: "audio-file",
    });

    expect(synthesizeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceId: "Stephen",
        engine: "neural",
      }),
    );
  });

  it("isConfigured returns true when explicitly enabled", () => {
    const provider = buildPollySpeechProvider();
    expect(
      provider.isConfigured({
        providerConfig: { enabled: true },
        timeoutMs: 10_000,
      }),
    ).toBe(true);
  });

  it("isConfigured returns false when disabled", () => {
    const provider = buildPollySpeechProvider();
    expect(
      provider.isConfigured({
        providerConfig: { enabled: false },
        timeoutMs: 10_000,
      }),
    ).toBe(false);
  });

  it("isConfigured detects AWS env vars", () => {
    const provider = buildPollySpeechProvider();
    const original = process.env.AWS_ACCESS_KEY_ID;
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    try {
      expect(
        provider.isConfigured({
          providerConfig: { enabled: true },
          timeoutMs: 10_000,
        }),
      ).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.AWS_ACCESS_KEY_ID;
      } else {
        process.env.AWS_ACCESS_KEY_ID = original;
      }
    }
  });

  it("isConfigured detects ECS task role credentials", () => {
    const provider = buildPollySpeechProvider();
    const original = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = "/v2/credentials/xxx";
    try {
      expect(
        provider.isConfigured({
          providerConfig: { enabled: true },
          timeoutMs: 10_000,
        }),
      ).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
      } else {
        process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = original;
      }
    }
  });
});

describe("buildPollySpeechProvider resolveConfig", () => {
  it("returns default config for empty rawConfig", () => {
    const provider = buildPollySpeechProvider();
    const config = provider.resolveConfig!({
      rawConfig: {},
      cfg: {} as OpenClawConfig,
      timeoutMs: 10_000,
    });

    expect(config).toEqual(
      expect.objectContaining({
        enabled: true,
        voice: "Ruth",
        engine: "generative",
        region: "us-east-1",
      }),
    );
  });

  it("reads nested provider config", () => {
    const provider = buildPollySpeechProvider();
    const config = provider.resolveConfig!({
      rawConfig: {
        providers: {
          "amazon-polly": {
            voice: "Matthew",
            engine: "neural",
            region: "eu-west-1",
            languageCode: "en-GB",
          },
        },
      },
      cfg: {} as OpenClawConfig,
      timeoutMs: 10_000,
    });

    expect(config).toEqual(
      expect.objectContaining({
        voice: "Matthew",
        engine: "neural",
        region: "eu-west-1",
        languageCode: "en-GB",
      }),
    );
  });

  it("reads flat config", () => {
    const provider = buildPollySpeechProvider();
    const config = provider.resolveConfig!({
      rawConfig: {
        voice: "Joanna",
        engine: "standard",
        region: "us-west-2",
      },
      cfg: {} as OpenClawConfig,
      timeoutMs: 10_000,
    });

    expect(config).toEqual(
      expect.objectContaining({
        voice: "Joanna",
        engine: "standard",
        region: "us-west-2",
      }),
    );
  });
});
