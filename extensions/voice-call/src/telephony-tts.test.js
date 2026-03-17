import { afterEach, describe, expect, it } from "vitest";
import { createTelephonyTtsProvider } from "./telephony-tts.js";
function createCoreConfig() {
  const tts = {
    provider: "openai",
    openai: {
      model: "gpt-4o-mini-tts",
      voice: "alloy"
    }
  };
  return { messages: { tts } };
}
async function mergeOverride(override) {
  let mergedConfig;
  const provider = createTelephonyTtsProvider({
    coreConfig: createCoreConfig(),
    ttsOverride: override,
    runtime: {
      textToSpeechTelephony: async ({ cfg }) => {
        mergedConfig = cfg;
        return {
          success: true,
          audioBuffer: Buffer.alloc(2),
          sampleRate: 8e3
        };
      }
    }
  });
  await provider.synthesizeForTelephony("hello");
  expect(mergedConfig?.messages?.tts).toBeDefined();
  return mergedConfig?.messages?.tts;
}
afterEach(() => {
  delete Object.prototype.polluted;
});
describe("createTelephonyTtsProvider deepMerge hardening", () => {
  it("merges safe nested overrides", async () => {
    const tts = await mergeOverride({
      openai: { voice: "coral" }
    });
    const openai = tts.openai;
    expect(openai.voice).toBe("coral");
    expect(openai.model).toBe("gpt-4o-mini-tts");
  });
  it("blocks top-level __proto__ keys", async () => {
    const tts = await mergeOverride(
      JSON.parse('{"__proto__":{"polluted":"top"},"openai":{"voice":"coral"}}')
    );
    const openai = tts.openai;
    expect(Object.prototype.polluted).toBeUndefined();
    expect(tts.polluted).toBeUndefined();
    expect(openai.voice).toBe("coral");
  });
  it("blocks nested __proto__ keys", async () => {
    const tts = await mergeOverride(
      JSON.parse('{"openai":{"model":"safe","__proto__":{"polluted":"nested"}}}')
    );
    const openai = tts.openai;
    expect(Object.prototype.polluted).toBeUndefined();
    expect(openai.polluted).toBeUndefined();
    expect(openai.model).toBe("safe");
  });
});
