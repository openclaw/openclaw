import type { AudioTranscriptionRequest } from "openclaw/plugin-sdk/media-understanding";
import type { postTranscriptionRequest } from "openclaw/plugin-sdk/provider-http";
import { describe, expect, it, vi } from "vitest";
import { buildXaiMediaUnderstandingProvider } from "./stt.js";

const { postTranscriptionRequestMock } = vi.hoisted(() => ({
  postTranscriptionRequestMock: vi.fn(
    async (_params: Parameters<typeof postTranscriptionRequest>[0]) => ({
      response: new Response(JSON.stringify({ text: "hello from audio" }), { status: 200 }),
      release: vi.fn(),
    }),
  ),
}));

function transcribeAudio(overrides: Partial<AudioTranscriptionRequest> = {}) {
  return buildXaiMediaUnderstandingProvider().transcribeAudio({
    buffer: Buffer.from("audio-bytes"),
    fileName: "sample.wav",
    mime: "audio/wav",
    apiKey: "xai-key",
    timeoutMs: 1000,
    ...overrides,
  });
}

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>();
  return {
    ...actual,
    postTranscriptionRequest: postTranscriptionRequestMock,
  };
});

describe("xai stt", () => {
  it("posts audio files to the xAI STT endpoint", async () => {
    const result = await transcribeAudio({
      baseUrl: "https://api.x.ai/v1/",
      model: "grok-4.3",
      language: "en",
      prompt: "ignored provider hint",
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ text: "hello from audio" });
    const call = postTranscriptionRequestMock.mock.lastCall?.[0];
    if (!call) {
      throw new Error("Expected transcription request params");
    }
    expect(call).toMatchObject({
      url: "https://api.x.ai/v1/stt",
      timeoutMs: 10_000,
      auditContext: "xai stt",
    });
    expect(call.headers.get("authorization")).toBe("Bearer xai-key");
    expect(call.body).toBeInstanceOf(FormData);
    const form = call.body as FormData;
    expect(form.get("model")).toBeNull();
    expect(form.get("language")).toBe("en");
    expect(form.get("prompt")).toBeNull();
    expect(form.get("file")).toBeInstanceOf(Blob);
    const serialized = await new Request(call.url!, { method: "POST", body: form }).text();
    const partNames = [
      ...serialized.matchAll(/Content-Disposition: form-data; name="([^"]+)"/g),
    ].map((match) => match[1]);
    expect(partNames).toEqual(["language", "file"]);
  });

  it.each(["", " \t\n", "  spoken words  "])(
    "accepts a valid transcript string %j",
    async (text) => {
      const release = vi.fn();
      postTranscriptionRequestMock.mockResolvedValueOnce({
        response: new Response(JSON.stringify({ text })),
        release,
      });

      await expect(transcribeAudio()).resolves.toEqual({ text: text.trim() });
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ...[{}, { text: null }].map((payload) => ({
      body: JSON.stringify(payload),
      status: 200,
      error: "xAI transcription response missing text",
    })),
    ...["null", "[]", "{ nope"].map((body) => ({
      body,
      status: 200,
      error: "xai.stt: malformed JSON response",
    })),
    { body: "unauthorized", status: 401, error: "xAI audio transcription failed" },
  ])("rejects status $status response $body", async ({ body, status, error }) => {
    const release = vi.fn();
    postTranscriptionRequestMock.mockResolvedValueOnce({
      response: new Response(body, { status }),
      release,
    });

    await expect(transcribeAudio()).rejects.toThrow(error);
    expect(release).toHaveBeenCalledOnce();
  });

  it("registers as an audio media-understanding provider", () => {
    const provider = buildXaiMediaUnderstandingProvider();
    expect(provider.id).toBe("xai");
    expect(provider.capabilities).toEqual(["audio"]);
    expect(provider.defaultModels).toBeUndefined();
    expect(provider.autoPriority).toEqual({ audio: 25 });
  });
});
