// Microsoft tests cover microsoft plugin behavior.
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import { buildMicrosoftSpeechProvider } from "./speech-provider.js";

const describeLive = isLiveTestEnabled() ? describe : describe.skip;

describeLive("microsoft plugin live", () => {
  it("synthesizes nonempty MP3 audio", async () => {
    const result = await buildMicrosoftSpeechProvider().synthesize({
      text: "Hello, this is an OpenClaw speech synthesis test.",
      cfg: {},
      providerConfig: {},
      timeoutMs: 10000,
      target: "audio-file",
    });

    expect(result.audioBuffer.length).toBeGreaterThan(0);
    expect(result.outputFormat).toBe("audio-24khz-48kbitrate-mono-mp3");
    expect(result.fileExtension).toBe(".mp3");
    console.info("Microsoft synthesis:", {
      bytes: result.audioBuffer.length,
      format: result.outputFormat,
      extension: result.fileExtension,
    });
  }, 30000);

  it("lists Edge speech voices", async () => {
    const listVoices = buildMicrosoftSpeechProvider().listVoices;
    if (!listVoices) {
      throw new Error("expected Microsoft voice listing support");
    }
    const voices = await listVoices({ providerConfig: {} });

    expect(voices.length).toBeGreaterThan(100);
    expect(voices.map((voice) => voice.id)).toContain("en-US-MichelleNeural");
  }, 60_000);
});
