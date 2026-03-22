import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMicrosoftSpeechProvider, isCjkDominant, listMicrosoftVoices } from "./speech-provider.js";
import * as ttsModule from "./tts.js";

describe("listMicrosoftVoices", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("maps Microsoft voice metadata into speech voice options", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            ShortName: "en-US-AvaNeural",
            FriendlyName: "Microsoft Ava Online (Natural) - English (United States)",
            Locale: "en-US",
            Gender: "Female",
            VoiceTag: {
              ContentCategories: ["General"],
              VoicePersonalities: ["Friendly", "Positive"],
            },
          },
        ]),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const voices = await listMicrosoftVoices();

    expect(voices).toEqual([
      {
        id: "en-US-AvaNeural",
        name: "Microsoft Ava Online (Natural) - English (United States)",
        category: "General",
        description: "Friendly, Positive",
        locale: "en-US",
        gender: "Female",
        personalities: ["Friendly", "Positive"],
      },
    ]);
  });

  it("throws on Microsoft voice list failures", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("nope", { status: 503 }),
      ) as unknown as typeof globalThis.fetch;

    await expect(listMicrosoftVoices()).rejects.toThrow("Microsoft voices API error (503)");
  });
});

describe("isCjkDominant", () => {
  it("returns true for Chinese text", () => {
    expect(isCjkDominant("你好世界")).toBe(true);
  });

  it("returns true for mixed text with majority CJK", () => {
    expect(isCjkDominant("你好，这是一个测试 hello")).toBe(true);
  });

  it("returns false for English text", () => {
    expect(isCjkDominant("Hello, this is a test")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isCjkDominant("")).toBe(false);
  });

  it("returns false for mostly English with a few CJK chars", () => {
    expect(isCjkDominant("This is a long English sentence with one 字")).toBe(false);
  });
});

describe("buildMicrosoftSpeechProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("switches to a Chinese voice for CJK text when no explicit voice override is set", async () => {
    const provider = buildMicrosoftSpeechProvider();
    const edgeSpy = vi.spyOn(ttsModule, "edgeTTS").mockImplementation(async ({ outputPath }) => {
      writeFileSync(outputPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    });

    await provider.synthesize({
      text: "你好，这是一个测试 hello",
      providerConfig: {
        enabled: true,
        voice: "en-US-MichelleNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        outputFormatConfigured: true,
        saveSubtitles: false,
      },
      providerOverrides: {},
      timeoutMs: 1000,
      target: "audio",
    });

    expect(edgeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          voice: "zh-CN-XiaoxiaoNeural",
          lang: "zh-CN",
        }),
      }),
    );
  });
});
