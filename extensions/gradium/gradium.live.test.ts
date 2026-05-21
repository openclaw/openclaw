import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { runRealtimeSttLiveTest } from "openclaw/plugin-sdk/provider-test-contracts";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { buildGradiumRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";
import { DEFAULT_GRADIUM_BASE_URL, DEFAULT_GRADIUM_VOICE_ID } from "./shared.js";
import { gradiumTTS } from "./tts.js";

const LIVE = isLiveTestEnabled();
const GRADIUM_API_KEY = process.env.GRADIUM_API_KEY?.trim() ?? "";

const registerGradiumPlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "gradium",
    name: "Gradium Speech",
  });

describe.skipIf(!LIVE || !GRADIUM_API_KEY)("gradium live", () => {
  it("synthesizes speech through the registered provider", async () => {
    const { speechProviders } = await registerGradiumPlugin();
    const provider = requireRegisteredProvider(speechProviders, "gradium");

    const result = await provider.synthesize({
      text: "Hello, this is a test of Gradium text to speech.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig: { apiKey: GRADIUM_API_KEY },
      target: "audio-file",
      timeoutMs: 45_000,
    });

    expect(result.outputFormat).toBe("wav");
    expect(result.audioBuffer.byteLength).toBeGreaterThan(512);

    const outPath = join(tmpdir(), "gradium-live-test.wav");
    writeFileSync(outPath, result.audioBuffer);
    console.log(`Audio written to ${outPath}`);
  }, 60_000);

  it("streams realtime STT through the registered transcription provider", async () => {
    const provider = buildGradiumRealtimeTranscriptionProvider();
    const phrase = "Testing OpenClaw Gradium realtime transcription integration OK.";
    const speech = await gradiumTTS({
      text: phrase,
      apiKey: GRADIUM_API_KEY,
      baseUrl: DEFAULT_GRADIUM_BASE_URL,
      voiceId: DEFAULT_GRADIUM_VOICE_ID,
      outputFormat: "ulaw_8000",
      timeoutMs: 30_000,
    });

    await runRealtimeSttLiveTest({
      provider,
      providerConfig: {
        apiKey: GRADIUM_API_KEY,
        inputFormat: "ulaw_8000",
        language: "en",
      },
      audio: Buffer.concat([Buffer.alloc(4000, 0xff), speech, Buffer.alloc(8000, 0xff)]),
    });
  }, 90_000);
});
