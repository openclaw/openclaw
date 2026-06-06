import { describe, expect, it } from "vitest";
import {
  DEFAULT_SENSEAUDIO_TTS_BASE_URL,
  DEFAULT_SENSEAUDIO_TTS_MODEL,
  DEFAULT_SENSEAUDIO_TTS_VOICE,
  listSenseAudioSystemVoices,
  senseAudioTTS,
} from "./tts.js";

const liveEnabled =
  process.env.OPENCLAW_LIVE_TEST === "1" && Boolean(process.env.SENSEAUDIO_API_KEY);

describe.runIf(liveEnabled)("SenseAudio TTS live tests", () => {
  it("synthesises a short Mandarin clip and returns MP3 bytes", async () => {
    const apiKey = process.env.SENSEAUDIO_API_KEY;
    if (!apiKey) {
      throw new Error("SENSEAUDIO_API_KEY missing");
    }
    const buf = await senseAudioTTS({
      text: "你好，OpenClaw。",
      apiKey,
      baseUrl: DEFAULT_SENSEAUDIO_TTS_BASE_URL,
      model: DEFAULT_SENSEAUDIO_TTS_MODEL,
      voiceId: DEFAULT_SENSEAUDIO_TTS_VOICE,
      timeoutMs: 30_000,
    });
    expect(buf.length).toBeGreaterThan(0);
    const isId3 = buf.toString("ascii", 0, 3) === "ID3";
    const isMpegFrame = buf[0] === 0xff && (buf[1] ?? 0) >= 0xe0;
    expect(isId3 || isMpegFrame).toBe(true);
  });

  it("lists at least one system voice and includes female_0033_b", async () => {
    const apiKey = process.env.SENSEAUDIO_API_KEY;
    if (!apiKey) {
      throw new Error("SENSEAUDIO_API_KEY missing");
    }
    const voices = await listSenseAudioSystemVoices({
      apiKey,
      baseUrl: DEFAULT_SENSEAUDIO_TTS_BASE_URL,
      timeoutMs: 15_000,
    });
    expect(voices.length).toBeGreaterThan(0);
    expect(voices.map((v) => v.id)).toContain(DEFAULT_SENSEAUDIO_TTS_VOICE);
    for (const voice of voices) {
      expect(voice.category).toBe("system");
    }
  });
});
