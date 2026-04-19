import { describe, expect, it } from "vitest";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "../../src/media-understanding/audio.test-helpers.ts";
import { transcribeSpeechHandsAudio } from "./audio.js";

installPinnedHostnameTestHooks();

describe("transcribeSpeechHandsAudio", () => {
  it("POSTs a JSON body with base64 audio to /v1/transcribe", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      text: "now don't burst into a tempest at that",
      model: "speech-hands-qwen2.5-omni-7b",
      action_token: "<external>",
      internal_pred: "now don't first into a theft at that",
      external_pred: "now don't burst into a tempest at that",
    });

    const result = await transcribeSpeechHandsAudio({
      buffer: Buffer.from("fake-audio-bytes"),
      fileName: "utterance.wav",
      mime: "audio/wav",
      apiKey: "unused-when-self-hosted",
      timeoutMs: 5000,
      baseUrl: "https://sh.example.com",
      fetchFn,
    });
    const { url: seenUrl, init: seenInit } = getRequest();

    expect(result.text).toBe("now don't burst into a tempest at that");
    expect(result.model).toBe("speech-hands-qwen2.5-omni-7b");
    expect(seenUrl).toBe("https://sh.example.com/v1/transcribe");
    expect(seenInit?.method).toBe("POST");

    const headers = new Headers(seenInit?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer unused-when-self-hosted");
  });

  it("falls back to the request's model when the server does not echo one", async () => {
    const { fetchFn } = createRequestCaptureJsonFetch({ text: "hello" });

    const result = await transcribeSpeechHandsAudio({
      buffer: Buffer.from("audio"),
      fileName: "a.wav",
      apiKey: "",
      timeoutMs: 5000,
      baseUrl: "https://sh.example.com",
      model: "speech-hands-custom-ckpt",
      fetchFn,
    });
    expect(result.model).toBe("speech-hands-custom-ckpt");
  });

  it("throws when the server response omits `text`", async () => {
    const { fetchFn } = createRequestCaptureJsonFetch({ model: "x" });

    await expect(
      transcribeSpeechHandsAudio({
        buffer: Buffer.from("audio"),
        fileName: "a.wav",
        apiKey: "",
        timeoutMs: 5000,
        baseUrl: "https://sh.example.com",
        fetchFn,
      }),
    ).rejects.toThrow();
  });
});
