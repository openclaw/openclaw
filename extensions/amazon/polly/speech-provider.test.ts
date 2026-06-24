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
      providerConfig: { enabled: true, region: "us-east-1", voice: "Ruth", engine: "generative" },
      providerOverrides: {},
      timeoutMs: 10_000,
      target: "audio-file",
    });

    expect(result.outputFormat).toBe("mp3");
    expect(result.fileExtension).toBe(".mp3");
    expect(result.voiceCompatible).toBe(false);
    expect(result.audioBuffer).toBe(fakeBuffer);
    expect(synthesizeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: "Ruth", engine: "generative", outputFormat: "mp3" }),
    );
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it("synthesizes voice-note with ffmpeg opus conversion", async () => {
    const provider = buildPollySpeechProvider();
    vi.spyOn(ttsModule, "pollySynthesize").mockResolvedValue(Buffer.from([0xff, 0xfb]));
    runFfmpegMock.mockResolvedValue("");

    const result = await provider.synthesize({
      text: "Hello world",
      cfg: TEST_CFG,
      providerConfig: { enabled: true, region: "us-east-1", voice: "Ruth", engine: "generative" },
      providerOverrides: {},
      timeoutMs: 10_000,
      target: "voice-note",
    });

    expect(result.outputFormat).toBe("ogg_opus");
    expect(result.fileExtension).toBe(".ogg");
    expect(result.voiceCompatible).toBe(true);
    expect(runFfmpegMock).toHaveBeenCalledTimes(1);
    const ffmpegArgs = runFfmpegMock.mock.calls[0][0] as string[];
    expect(ffmpegArgs).toContain("libopus");
  });

  it("applies voice override from providerOverrides", async () => {
    const provider = buildPollySpeechProvider();
    const synthesizeSpy = vi.spyOn(ttsModule, "pollySynthesize").mockResolvedValue(Buffer.from([0x01]));

    await provider.synthesize({
      text: "Hello",
      cfg: TEST_CFG,
      providerConfig: { enabled: true, region: "us-east-1", voice: "Ruth", engine: "generative" },
      providerOverrides: { voice: "Stephen", engine: "neural" },
      timeoutMs: 10_000,
      target: "audio-file",
    });

    expect(synthesizeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: "Stephen", engine: "neural" }),
    );
  });

  it("uses engine-aware sample rate defaults", async () => {
    const provider = buildPollySpeechProvider();
    const synthesizeSpy = vi.spyOn(ttsModule, "pollySynthesize").mockResolvedValue(Buffer.from([0x01]));

    await provider.synthesize({
      text: "Hello",
      cfg: TEST_CFG,
      providerConfig: { enabled: true, region: "us-east-1", voice: "Joanna", engine: "neural" },
      providerOverrides: {},
      timeoutMs: 10_000,
      target: "audio-file",
    });

    expect(synthesizeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sampleRate: "22050" }),
    );
  });

  it("isConfigured returns true when enabled", () => {
    const provider = buildPollySpeechProvider();
    expect(provider.isConfigured({ providerConfig: { enabled: true }, timeoutMs: 10_000 })).toBe(true);
  });

  it("isConfigured returns false when disabled", () => {
    const provider = buildPollySpeechProvider();
    expect(provider.isConfigured({ providerConfig: { enabled: false }, timeoutMs: 10_000 })).toBe(false);
  });
});

describe("buildPollySpeechProvider resolveConfig", () => {
  it("returns defaults for empty config", () => {
    const provider = buildPollySpeechProvider();
    const config = provider.resolveConfig!({ rawConfig: {}, cfg: {} as OpenClawConfig, timeoutMs: 10_000 });
    expect(config).toEqual(expect.objectContaining({ enabled: true, voice: "Ruth", engine: "generative", region: "us-east-1" }));
  });

  it("reads custom config", () => {
    const provider = buildPollySpeechProvider();
    const config = provider.resolveConfig!({
      rawConfig: { voice: "Matthew", engine: "neural", region: "eu-west-1", languageCode: "en-GB" },
      cfg: {} as OpenClawConfig,
      timeoutMs: 10_000,
    });
    expect(config).toEqual(expect.objectContaining({ voice: "Matthew", engine: "neural", region: "eu-west-1", languageCode: "en-GB" }));
  });
});
