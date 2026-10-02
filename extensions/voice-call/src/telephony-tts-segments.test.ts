// Voice Call tests cover segmented telephony speech preparation.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import type { VoiceCallTtsConfig } from "./config.js";
import { MAX_TELEPHONY_TTS_SYNTH_CHARS } from "./telephony-tts-chunking.js";
import { createTelephonyTtsProvider, type TelephonyTtsRuntime } from "./telephony-tts.js";

function createCoreConfig(): OpenClawConfig {
  const tts: VoiceCallTtsConfig = {
    provider: "openai",
    providers: { openai: { model: "gpt-4o-mini-tts", voice: "alloy" } },
  };
  return { tts };
}

const okSynthesis = async () => ({
  success: true as const,
  audioBuffer: Buffer.from([0x00, 0x7f, 0xff]),
  outputFormat: "ulaw_8000",
  sampleRate: 8_000,
  provider: "openai",
});

/** A reply comfortably past the synthesis budget, several sentences long. */
function longReply(): string {
  return Array.from(
    { length: 14 },
    (_, index) => `This is sentence number ${index} with a handful of filler words.`,
  ).join(" ");
}

describe("prepareSpeech", () => {
  it("resolves inline TTS directives once for the whole reply, not per segment", async () => {
    const prepareTtsRequest = vi.fn<TelephonyTtsRuntime["prepareTtsRequest"]>(
      async ({ cfg, text }) => ({
        cfg,
        directives: {
          cleanedText: text,
          hasDirective: false,
          overrides: {},
          warnings: [],
        },
      }),
    );
    const provider = await createTelephonyTtsProvider({
      coreConfig: createCoreConfig(),
      runtime: { prepareTtsRequest, textToSpeechTelephony: okSynthesis },
    });
    prepareTtsRequest.mockClear();

    const plan = await provider.prepareSpeech(longReply());
    expect(plan.segments.length).toBeGreaterThan(1);
    await Promise.all(plan.segments.map((segment) => plan.synthesizeSegment(segment)));

    // Directive resolution happens exactly once for the complete reply. Were it
    // run per segment, an audio-only override could be applied independently to
    // each piece and change what the caller hears.
    expect(prepareTtsRequest).toHaveBeenCalledTimes(1);
  });

  it("splits the resolved spoken text, so a directive block is never divided", async () => {
    const spoken = longReply();
    // A reply whose directive header would land inside the first segment if the
    // raw string were split before the directive contract was applied.
    const raw = `[[tts: provider=openai]]\n${spoken}`;
    const synthesized: string[] = [];

    const provider = await createTelephonyTtsProvider({
      coreConfig: createCoreConfig(),
      runtime: {
        prepareTtsRequest: async ({ cfg, text }) => ({
          cfg,
          directives: {
            cleanedText: text.replace(/^\[\[tts:[^\]]*\]\]\s*/, ""),
            ttsText: text.replace(/^\[\[tts:[^\]]*\]\]\s*/, ""),
            hasDirective: true,
            overrides: { provider: "openai" },
            warnings: [],
          },
        }),
        textToSpeechTelephony: async ({ text, overrides }) => {
          synthesized.push(text);
          // The one resolved override set reaches every segment.
          expect(overrides).toEqual({ provider: "openai" });
          return okSynthesis();
        },
      },
    });

    const plan = await provider.prepareSpeech(raw);
    for (const segment of plan.segments) {
      await plan.synthesizeSegment(segment);
    }

    expect(plan.segments.length).toBeGreaterThan(1);
    // No segment carries directive syntax: splitting happened after resolution.
    for (const segment of plan.segments) {
      expect(segment).not.toContain("[[tts:");
      expect(segment.length).toBeLessThanOrEqual(MAX_TELEPHONY_TTS_SYNTH_CHARS);
    }
    expect(synthesized.join(" ")).toBe(spoken);
  });

  it("keeps a short reply as a single segment", async () => {
    const provider = await createTelephonyTtsProvider({
      coreConfig: createCoreConfig(),
      runtime: {
        prepareTtsRequest: async ({ cfg, text }) => ({
          cfg,
          directives: { cleanedText: text, hasDirective: false, overrides: {}, warnings: [] },
        }),
        textToSpeechTelephony: okSynthesis,
      },
    });

    const plan = await provider.prepareSpeech("Short answer.");

    expect(plan.segments).toEqual(["Short answer."]);
  });
});
