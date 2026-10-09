import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "openclaw/plugin-sdk/test-media-understanding";
import { describe, expect, it } from "vitest";
import { senseaudioMediaUnderstandingProvider } from "./media-understanding-provider.js";

installPinnedHostnameTestHooks();

const transcribeSenseAudioAudio = senseaudioMediaUnderstandingProvider.transcribeAudio;
if (!transcribeSenseAudioAudio) {
  throw new Error("expected SenseAudio transcription capability");
}

describe("transcribeSenseAudioAudio", () => {
  it("transcribes with the SenseAudio endpoint and default model", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    const result = await transcribeSenseAudioAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "test-key",
      timeoutMs: 1000,
      model: " ",
      fetchFn,
    });

    expect(getRequest().url).toBe("https://api.senseaudio.cn/v1/audio/transcriptions");
    expect(result).toEqual({
      text: "ok",
      model: "senseaudio-asr-pro-1.5-260319",
    });
    const form = getRequest().init?.body;
    if (!(form instanceof FormData)) {
      throw new Error("expected transcription form");
    }
    expect(form.get("model")).toBe("senseaudio-asr-pro-1.5-260319");
  });
});
