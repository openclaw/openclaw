import { afterEach, describe, expect, it, vi } from "vitest";
import { elevenLabsTTS } from "./tts.js";

describe("elevenlabs tts diagnostics", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("includes parsed provider detail and request id for JSON API errors", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            detail: {
              message: "Quota exceeded",
              status: "quota_exceeded",
            },
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "x-request-id": "el_req_456",
            },
          },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      elevenLabsTTS({
        text: "hello",
        apiKey: "test-key",
        baseUrl: "https://api.elevenlabs.io",
        voiceId: "pMsXgVXv3BLzUgSXRplE",
        modelId: "eleven_multilingual_v2",
        outputFormat: "mp3_44100_128",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0,
          useSpeakerBoost: true,
          speed: 1.0,
        },
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(
      "ElevenLabs API error (429): Quota exceeded [code=quota_exceeded] [request_id=el_req_456]",
    );
  });

  it("falls back to raw body text when the error body is non-JSON", async () => {
    const fetchMock = vi.fn(async () => new Response("service unavailable", { status: 503 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      elevenLabsTTS({
        text: "hello",
        apiKey: "test-key",
        baseUrl: "https://api.elevenlabs.io",
        voiceId: "pMsXgVXv3BLzUgSXRplE",
        modelId: "eleven_multilingual_v2",
        outputFormat: "mp3_44100_128",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0,
          useSpeakerBoost: true,
          speed: 1.0,
        },
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("ElevenLabs API error (503): service unavailable");
  });
});
