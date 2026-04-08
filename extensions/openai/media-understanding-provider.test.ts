import { describe, expect, it } from "vitest";
import {
  createAuthCaptureJsonFetch,
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "../../src/media-understanding/audio.test-helpers.ts";
import { transcribeOpenAiAudio } from "./media-understanding-provider.js";

installPinnedHostnameTestHooks();

describe("transcribeOpenAiAudio", () => {
  it("respects lowercase authorization header overrides", async () => {
    const { fetchFn, getAuthHeader } = createAuthCaptureJsonFetch({ text: "ok" });

    const result = await transcribeOpenAiAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "test-key",
      timeoutMs: 1000,
      headers: { authorization: "Bearer override" },
      fetchFn,
    });

    expect(getAuthHeader()).toBe("Bearer override");
    expect(result.text).toBe("ok");
  });

  it("builds the expected request payload", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "hello" });

    const result = await transcribeOpenAiAudio({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.wav",
      apiKey: "test-key",
      timeoutMs: 1234,
      baseUrl: "https://api.example.com/v1/",
      model: " ",
      language: " en ",
      prompt: " hello ",
      mime: "audio/wav",
      headers: { "X-Custom": "1" },
      fetchFn,
    });
    const { url: seenUrl, init: seenInit } = getRequest();

    expect(result.model).toBe("gpt-4o-transcribe");
    expect(result.text).toBe("hello");
    expect(seenUrl).toBe("https://api.example.com/v1/audio/transcriptions");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(seenInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("x-custom")).toBe("1");

    // Body is a raw Buffer with an explicit multipart/form-data Content-Type (not a FormData instance).
    // This sidesteps the undici npm fetch / globalThis.FormData incompatibility where the
    // Content-Type boundary header is never set when using a custom dispatcher.
    expect(Buffer.isBuffer(seenInit?.body)).toBe(true);
    const ct = headers.get("content-type") ?? "";
    expect(ct).toMatch(/^multipart\/form-data; boundary=/);

    const bodyStr = Buffer.from(seenInit?.body as Buffer).toString("utf8");
    expect(bodyStr).toContain('name="model"');
    expect(bodyStr).toContain("gpt-4o-transcribe");
    expect(bodyStr).toContain('name="language"');
    expect(bodyStr).toContain("en");
    expect(bodyStr).toContain('name="prompt"');
    expect(bodyStr).toContain("hello");
    expect(bodyStr).toContain('name="file"');
    expect(bodyStr).toContain('filename="voice.wav"');
    expect(bodyStr).toContain("Content-Type: audio/wav");
  });

  it("throws when the provider response omits text", async () => {
    const { fetchFn } = createRequestCaptureJsonFetch({});

    await expect(
      transcribeOpenAiAudio({
        buffer: Buffer.from("audio-bytes"),
        fileName: "voice.wav",
        apiKey: "test-key",
        timeoutMs: 1234,
        fetchFn,
      }),
    ).rejects.toThrow("Audio transcription response missing text");
  });
});
