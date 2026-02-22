import { afterEach, describe, expect, it } from "vitest";
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
  expect(mergedConfig?.messages?.tts).toBeDefined();
  return mergedConfig?.messages?.tts as Record<string, unknown>;
}

afterEach(() => {
  delete (Object.prototype as Record<string, unknown>).polluted;
});

describe("createTelephonyTtsProvider deepMerge hardening", () => {
  it("merges safe nested overrides", async () => {
    const tts = await mergeOverride({
      openai: { voice: "coral" },
    });
    const openai = tts.openai as Record<string, unknown>;

    expect(openai.voice).toBe("coral");
    expect(openai.model).toBe("gpt-4o-mini-tts");
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
