import { resolveConfiguredRealtimeVoiceProvider } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";
import { buildOpenAISpeechProvider } from "./speech-provider.js";

const live = process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_GPT_LIVE === "1";

describe.skipIf(!live)("OpenAI Talk account defaults live", () => {
  it("delegates microphone speech and speaks the backend answer without a configured model", async ({
    skip,
  }) => {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      skip("OpenAI Platform API key is unavailable");
      return;
    }
    const cfg = {};
    const { provider, providerConfig } = resolveConfiguredRealtimeVoiceProvider({
      cfg,
      surface: "gateway-relay",
      providers: [buildOpenAIRealtimeVoiceProvider()],
      providerConfigs: { openai: { apiKey } },
    });
    expect(providerConfig.model).toBe("gpt-live-1");

    const speech = await buildOpenAISpeechProvider().synthesizeTelephony?.({
      cfg,
      providerConfig: { apiKey, model: "gpt-4o-mini-tts", voice: "alloy" },
      text: "Please ask the backend for the launch code.",
      timeoutMs: 30_000,
    });
    expect(speech?.sampleRate).toBe(24_000);
    if (!speech) {
      throw new Error("Speech fixture was not synthesized");
    }

    const errors: Error[] = [];
    const questions: string[] = [];
    let assistantText = "";
    let audioBytes = 0;
    let closed: string | undefined;
    const bridge = provider.createBridge({
      cfg,
      providerConfig,
      audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
      instructions: "Delegate every user request to the backend. Speak the backend answer exactly.",
      runAgentConsult: async ({ prompt }) => {
        questions.push(prompt);
        return { text: "The launch code is saffron lantern." };
      },
      onAudio: (audio) => {
        audioBytes += audio.length;
      },
      onClearAudio: () => undefined,
      onTranscript: (role, text) => {
        if (role === "assistant") {
          assistantText += text;
        }
      },
      onError: (error) => errors.push(error),
      onClose: (reason) => {
        closed = reason;
      },
    });
    try {
      await bridge.connect();
      const deadline = Date.now() + 40_000;
      let offset = 0;
      while (Date.now() < deadline && !assistantText.toLowerCase().includes("saffron lantern")) {
        const frame = Buffer.alloc(960);
        speech.audioBuffer.copy(
          frame,
          0,
          offset,
          Math.min(offset + frame.length, speech.audioBuffer.length),
        );
        offset = Math.min(offset + frame.length, speech.audioBuffer.length);
        bridge.sendAudio(frame);
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
        if (errors.length) {
          break;
        }
      }
      expect(errors).toEqual([]);
      expect(questions.some((question) => /launch code/i.test(question))).toBe(true);
      expect(assistantText.toLowerCase()).toContain("saffron lantern");
      expect(audioBytes).toBeGreaterThan(0);
    } finally {
      await bridge.close();
    }
    expect(errors).toEqual([]);
    expect(closed).toBe("completed");
    expect(bridge.isConnected()).toBe(false);
    console.info(
      JSON.stringify({
        model: providerConfig.model,
        delegations: questions.length,
        audioBytes,
        closed,
      }),
    );
  }, 90_000);
});
