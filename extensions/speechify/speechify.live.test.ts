// Speechify tests cover speechify plugin behavior.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

const LIVE = isLiveTestEnabled();
const SPEECHIFY_API_KEY = process.env.SPEECHIFY_API_KEY?.trim() ?? "";

const registerSpeechifyPlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "speechify",
    name: "Speechify Speech",
  });

describe.skipIf(!LIVE || !SPEECHIFY_API_KEY)("speechify live", () => {
  it("synthesizes an MP3 and an Ogg Opus voice note through the registered provider", async () => {
    const { speechProviders } = await registerSpeechifyPlugin();
    const provider = requireRegisteredProvider(speechProviders, "speechify");
    const cfg = { plugins: { enabled: true } } as never;

    const mp3 = await provider.synthesize({
      text: "Hello, this is a test of Speechify text to speech.",
      cfg,
      providerConfig: { apiKey: SPEECHIFY_API_KEY },
      target: "audio-file",
      timeoutMs: 45_000,
    });
    expect(mp3.outputFormat).toBe("mp3");
    expect(mp3.audioBuffer.byteLength).toBeGreaterThan(512);

    const voiceNote = await provider.synthesize({
      text: "And this one is a voice note.",
      cfg,
      providerConfig: { apiKey: SPEECHIFY_API_KEY },
      target: "voice-note",
      timeoutMs: 45_000,
    });
    expect(voiceNote.outputFormat).toBe("ogg");
    expect(voiceNote.voiceCompatible).toBe(true);
    // Ogg capture pattern.
    expect(voiceNote.audioBuffer.subarray(0, 4).toString("ascii")).toBe("OggS");

    const outPath = join(tmpdir(), "speechify-live-test.mp3");
    writeFileSync(outPath, mp3.audioBuffer);
    console.log(`Audio written to ${outPath}`);
  }, 90_000);

  it("lists voices", async () => {
    const { speechProviders } = await registerSpeechifyPlugin();
    const provider = requireRegisteredProvider(speechProviders, "speechify");
    const voices = await provider.listVoices?.({ apiKey: SPEECHIFY_API_KEY, timeoutMs: 30_000 });
    expect(voices?.some((voice) => voice.id === "geffen_32")).toBe(true);
  }, 60_000);
});
