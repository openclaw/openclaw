import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../src/config/config.js";
import { loadConfig } from "../../src/config/config.js";
import { encodePngRgba, fillPixel } from "../../src/media/png-encode.js";
import type { ResolvedTtsConfig } from "../../src/tts/tts.js";
import { createTestPluginApi } from "../../test/helpers/extensions/plugin-api.js";
import plugin from "./index.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const LIVE_MODEL_ID = process.env.OPENCLAW_LIVE_OPENAI_PLUGIN_MODEL?.trim() || "gpt-5.4-nano";
const LIVE_IMAGE_MODEL = process.env.OPENCLAW_LIVE_OPENAI_IMAGE_MODEL?.trim() || "gpt-image-1";
const LIVE_VISION_MODEL = process.env.OPENCLAW_LIVE_OPENAI_VISION_MODEL?.trim() || "gpt-4.1-mini";
const liveEnabled = OPENAI_API_KEY.trim().length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;
const EMPTY_AUTH_STORE = { version: 1, profiles: {} } as const;

function createTemplateModel(modelId: string) {
  switch (modelId) {
    case "gpt-5.4":
      return {
        id: "gpt-5.2",
        name: "GPT-5.2",
        provider: "openai",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 400_000,
        maxTokens: 128_000,
      };
    case "gpt-5.4-mini":
      return {
        id: "gpt-5-mini",
        name: "GPT-5 mini",
        provider: "openai",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 400_000,
        maxTokens: 128_000,
      };
    case "gpt-5.4-nano":
      return {
        id: "gpt-5-nano",
        name: "GPT-5 nano",
        provider: "openai",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 64_000,
      };
    default:
      throw new Error(`Unsupported live OpenAI plugin model: ${modelId}`);
  }
}

function registerOpenAIPlugin() {
  const providers: unknown[] = [];
  const speechProviders: unknown[] = [];
  const mediaProviders: unknown[] = [];
  const imageProviders: unknown[] = [];

  plugin.register(
    createTestPluginApi({
      id: "openai",
      name: "OpenAI Provider",
      source: "test",
      config: {},
      runtime: {} as never,
      registerProvider: (provider) => {
        providers.push(provider);
      },
      registerSpeechProvider: (provider) => {
        speechProviders.push(provider);
      },
      registerMediaUnderstandingProvider: (provider) => {
        mediaProviders.push(provider);
      },
      registerImageGenerationProvider: (provider) => {
        imageProviders.push(provider);
      },
    }),
  );

  return { providers, speechProviders, mediaProviders, imageProviders };
}

function requireOpenAIProvider<T = unknown>(entries: unknown[], id: string): T {
  const entry = entries.find(
    (candidate) =>
      // oxlint-disable-next-line typescript/no-explicit-any
      (candidate as any).id === id,
  );
  if (!entry) {
    throw new Error(`provider ${id} was not registered`);
  }
  return entry as T;
}

function createReferencePng(): Buffer {
  const width = 96;
  const height = 96;
  const buf = Buffer.alloc(width * height * 4, 255);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      fillPixel(buf, x, y, width, 225, 242, 255, 255);
    }
  }

  for (let y = 24; y < 72; y += 1) {
    for (let x = 24; x < 72; x += 1) {
      fillPixel(buf, x, y, width, 255, 153, 51, 255);
    }
  }

  return encodePngRgba(buf, width, height);
}

function createLiveConfig(): OpenClawConfig {
  const cfg = loadConfig();
  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: {
        ...cfg.models?.providers,
        openai: {
          ...cfg.models?.providers?.openai,
          apiKey: OPENAI_API_KEY,
          baseUrl: "https://api.openai.com/v1",
        },
      },
    },
  } as OpenClawConfig;
}

function createLiveTtsConfig(): ResolvedTtsConfig {
  return {
    auto: "off",
    mode: "final",
    provider: "openai",
    providerSource: "config",
    modelOverrides: {
      enabled: true,
      allowText: true,
      allowProvider: true,
      allowVoice: true,
      allowModelId: true,
      allowVoiceSettings: true,
      allowNormalization: true,
      allowSeed: true,
    },
    elevenlabs: {
      baseUrl: "https://api.elevenlabs.io",
      voiceId: "",
      modelId: "eleven_multilingual_v2",
      voiceSettings: {
        stability: 0.5,
        similarityBoost: 0.75,
        style: 0,
        useSpeakerBoost: true,
        speed: 1,
      },
    },
    openai: {
      apiKey: OPENAI_API_KEY,
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-tts",
      voice: "alloy",
    },
    edge: {
      enabled: false,
      voice: "en-US-AriaNeural",
      lang: "en-US",
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
      outputFormatConfigured: false,
      saveSubtitles: false,
    },
    maxTextLength: 4_000,
    timeoutMs: 30_000,
  };
}

async function createTempAgentDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openai-plugin-live-"));
}

describe("openai plugin", () => {
  it("registers the expected provider surfaces", () => {
    const { providers, speechProviders, mediaProviders, imageProviders } = registerOpenAIPlugin();

    expect(providers).toHaveLength(2);
    expect(
      providers.map(
        (provider) =>
          // oxlint-disable-next-line typescript/no-explicit-any
          (provider as any).id,
      ),
    ).toEqual(["openai", "openai-codex"]);
    expect(speechProviders).toHaveLength(1);
    expect(mediaProviders).toHaveLength(1);
    expect(imageProviders).toHaveLength(1);
  });
});

describeLive("openai plugin live", () => {
  it("registers an OpenAI provider that can complete a live request", async () => {
    const { providers } = registerOpenAIPlugin();
    const provider = requireOpenAIProvider(providers, "openai");

    // oxlint-disable-next-line typescript/no-explicit-any
    const resolved = (provider as any).resolveDynamicModel?.({
      provider: "openai",
      modelId: LIVE_MODEL_ID,
      modelRegistry: {
        find(providerId: string, id: string) {
          if (providerId !== "openai") {
            return null;
          }
          const template = createTemplateModel(LIVE_MODEL_ID);
          return id === template.id ? template : null;
        },
      },
    });

    if (!resolved) {
      throw new Error("openai provider did not resolve the live model");
    }

    // oxlint-disable-next-line typescript/no-explicit-any
    const normalized = (provider as any).normalizeResolvedModel?.({
      provider: "openai",
      modelId: resolved.id,
      model: resolved,
    });

    expect(normalized).toMatchObject({
      provider: "openai",
      id: LIVE_MODEL_ID,
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });

    const client = new OpenAI({
      apiKey: OPENAI_API_KEY,
      baseURL: normalized?.baseUrl,
    });
    const response = await client.responses.create({
      model: normalized?.id ?? LIVE_MODEL_ID,
      input: "Reply with exactly OK.",
      max_output_tokens: 16,
    });

    expect(response.output_text.trim()).toMatch(/^OK[.!]?$/);
  }, 30_000);

  it("lists voices and synthesizes audio through the registered speech provider", async () => {
    const { speechProviders } = registerOpenAIPlugin();
    const speechProvider = requireOpenAIProvider(speechProviders, "openai");

    // oxlint-disable-next-line typescript/no-explicit-any
    const voices = await (speechProvider as any).listVoices?.({});
    if (!voices) {
      throw new Error("openai speech provider did not return voices");
    }
    expect(voices).toEqual(expect.arrayContaining([expect.objectContaining({ id: "alloy" })]));

    const cfg = createLiveConfig();
    const ttsConfig = createLiveTtsConfig();

    // oxlint-disable-next-line typescript/no-explicit-any
    const audioFile = await (speechProvider as any).synthesize({
      text: "OpenClaw integration test OK.",
      cfg,
      config: ttsConfig,
      target: "audio-file",
    });
    expect(audioFile.outputFormat).toBe("mp3");
    expect(audioFile.fileExtension).toBe(".mp3");
    expect(audioFile.audioBuffer.byteLength).toBeGreaterThan(512);

    // oxlint-disable-next-line typescript/no-explicit-any
    const telephony = await (speechProvider as any).synthesizeTelephony?.({
      text: "Telephony check OK.",
      cfg,
      config: ttsConfig,
    });
    expect(telephony?.outputFormat).toBe("pcm");
    expect(telephony?.sampleRate).toBe(24_000);
    expect(telephony?.audioBuffer.byteLength).toBeGreaterThan(512);
  }, 45_000);

  it("transcribes synthesized speech through the registered media provider", async () => {
    const { speechProviders, mediaProviders } = registerOpenAIPlugin();
    const speechProvider = requireOpenAIProvider(speechProviders, "openai");
    const mediaProvider = requireOpenAIProvider(mediaProviders, "openai");

    const cfg = createLiveConfig();
    const ttsConfig = createLiveTtsConfig();

    // oxlint-disable-next-line typescript/no-explicit-any
    const synthesized = await (speechProvider as any).synthesize({
      text: "OpenClaw integration test OK.",
      cfg,
      config: ttsConfig,
      target: "audio-file",
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    const transcription = await (mediaProvider as any).transcribeAudio?.({
      buffer: synthesized.audioBuffer,
      fileName: "openai-plugin-live.mp3",
      mime: "audio/mpeg",
      apiKey: OPENAI_API_KEY,
      timeoutMs: 30_000,
    });

    const text = String(transcription?.text ?? "").toLowerCase();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("openclaw");
    expect(text).toMatch(/\bok\b/);
  }, 45_000);

  it("generates an image through the registered image provider", async () => {
    const { imageProviders } = registerOpenAIPlugin();
    const imageProvider = requireOpenAIProvider(imageProviders, "openai");

    const cfg = createLiveConfig();
    const agentDir = await createTempAgentDir();

    try {
      // oxlint-disable-next-line typescript/no-explicit-any
      const generated = await (imageProvider as any).generateImage({
        provider: "openai",
        model: LIVE_IMAGE_MODEL,
        prompt: "Create a minimal flat orange square centered on a white background.",
        cfg,
        agentDir,
        authStore: EMPTY_AUTH_STORE,
        timeoutMs: 45_000,
        size: "1024x1024",
      });

      expect(generated.model).toBe(LIVE_IMAGE_MODEL);
      expect(generated.images.length).toBeGreaterThan(0);
      expect(generated.images[0]?.mimeType).toBe("image/png");
      expect(generated.images[0]?.buffer.byteLength).toBeGreaterThan(1_000);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("describes a deterministic image through the registered media provider", async () => {
    const { mediaProviders } = registerOpenAIPlugin();
    const mediaProvider = requireOpenAIProvider(mediaProviders, "openai");

    const cfg = createLiveConfig();
    const agentDir = await createTempAgentDir();

    try {
      // oxlint-disable-next-line typescript/no-explicit-any
      const description = await (mediaProvider as any).describeImage?.({
        buffer: createReferencePng(),
        fileName: "reference.png",
        mime: "image/png",
        prompt: "Reply with one lowercase word for the dominant center color.",
        timeoutMs: 30_000,
        agentDir,
        cfg,
        model: LIVE_VISION_MODEL,
        provider: "openai",
      });

      expect(String(description?.text ?? "").toLowerCase()).toContain("orange");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  }, 60_000);
});
