// Volcengine tests cover tts plugin behavior.
import { describe, expect, it } from "vitest";
import { buildVolcengineSpeechProvider } from "./speech-provider.js";

const seedSpeechApiKey =
  process.env.VOLCENGINE_TTS_API_KEY ?? process.env.BYTEPLUS_SEED_SPEECH_API_KEY;
const hasVolcengineTtsCredentials = Boolean(
  seedSpeechApiKey || (process.env.VOLCENGINE_TTS_APPID && process.env.VOLCENGINE_TTS_TOKEN),
);
const describeLive =
  process.env.OPENCLAW_LIVE_TEST === "1" && hasVolcengineTtsCredentials ? describe : describe.skip;

describeLive("Volcengine TTS live", () => {
  it("synthesizes mp3 audio with .profile credentials", async () => {
    const { audioBuffer } = await buildVolcengineSpeechProvider().synthesize({
      text: "OpenClaw live test.",
      cfg: {},
      target: "audio-file",
      providerConfig: {
        apiKey: seedSpeechApiKey,
        appId: process.env.VOLCENGINE_TTS_APPID,
        token: process.env.VOLCENGINE_TTS_TOKEN,
        voice: process.env.VOLCENGINE_TTS_VOICE,
        cluster: process.env.VOLCENGINE_TTS_CLUSTER,
        resourceId: process.env.VOLCENGINE_TTS_RESOURCE_ID,
        appKey: process.env.VOLCENGINE_TTS_APP_KEY,
        baseUrl: process.env.VOLCENGINE_TTS_BASE_URL,
      },
      timeoutMs: 30_000,
    });

    expect(audioBuffer.length).toBeGreaterThan(128);
  });
});
