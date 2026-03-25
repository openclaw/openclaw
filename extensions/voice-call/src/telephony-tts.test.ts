import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceCallTtsConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import { createTelephonyTtsProvider } from "./telephony-tts.js";

function createCoreConfig(): CoreConfig {
  const tts: VoiceCallTtsConfig = {
    provider: "openai",
    openai: {
      model: "gpt-4o-mini-tts",
      voice: "alloy",
    },
  };
  return { messages: { tts } };
}

function requireMergedTtsConfig(mergedConfig: CoreConfig | undefined) {
  const tts = mergedConfig?.messages?.tts;
  if (!tts) {
    throw new Error("telephony TTS runtime did not receive merged TTS config");
  }
  return tts as Record<string, unknown>;
}

async function mergeOverride(override: unknown): Promise<Record<string, unknown>> {
  let mergedConfig: CoreConfig | undefined;
  const provider = createTelephonyTtsProvider({
    coreConfig: createCoreConfig(),
    ttsOverride: override as VoiceCallTtsConfig,
    runtime: {
      textToSpeechTelephony: async ({ cfg }) => {
        mergedConfig = cfg;
        return {
          success: true,
          audioBuffer: Buffer.alloc(2),
          sampleRate: 8000,
        };
      },
    },
  });

  await provider.synthesizeForTelephony("hello");
  return requireMergedTtsConfig(mergedConfig);
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  delete (Object.prototype as Record<string, unknown>).polluted;
  globalThis.fetch = originalFetch;
  delete process.env.OPENAI_API_KEY;
});

describe("createTelephonyTtsProvider streaming OpenAI instructions", () => {
  it("omits unsupported OpenAI instructions in streaming mode", async () => {
    process.env.OPENAI_API_KEY = "env-openai-key";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      expect(body.model).toBe("tts-1");
      expect(body.instructions).toBeUndefined();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = createTelephonyTtsProvider({
      coreConfig: {},
      ttsOverride: {
        provider: "openai",
        openai: {
          apiKey: "inline-openai-key",
          model: "tts-1",
          voice: "alloy",
          instructions: "Speak warmly",
        },
      },
      runtime: {
        textToSpeechTelephony: async () => ({
          success: true,
          audioBuffer: Buffer.alloc(2),
          sampleRate: 8000,
        }),
      },
    });

    const chunks: Buffer[] = [];
    const stream = provider.streamForTelephony?.("hello");
    if (!stream) {
      throw new Error("expected OpenAI telephony streaming to be available");
    }
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("createTelephonyTtsProvider deepMerge hardening", () => {
  it("merges safe nested overrides", async () => {
    const tts = await mergeOverride({
      openai: { voice: "coral" },
    });
    const openai = tts.openai as Record<string, unknown>;

    expect(openai.voice).toBe("coral");
    expect(openai.model).toBeUndefined();
  });

  it("blocks top-level __proto__ keys", async () => {
    const tts = await mergeOverride(
      JSON.parse('{"__proto__":{"polluted":"top"},"openai":{"voice":"coral"}}'),
    );
    const openai = tts.openai as Record<string, unknown>;

    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(tts.polluted).toBeUndefined();
    expect(openai.voice).toBe("coral");
  });

  it("blocks nested __proto__ keys", async () => {
    const tts = await mergeOverride(
      JSON.parse('{"openai":{"model":"safe","__proto__":{"polluted":"nested"}}}'),
    );
    const openai = tts.openai as Record<string, unknown>;

    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(openai.polluted).toBeUndefined();
    expect(openai.model).toBe("safe");
  });
});
