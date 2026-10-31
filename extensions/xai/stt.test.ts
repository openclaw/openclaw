import type { AudioTranscriptionRequest } from "openclaw/plugin-sdk/media-understanding";
import type { postTranscriptionRequest } from "openclaw/plugin-sdk/provider-http";
import { expect, it, vi } from "vitest";
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

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  postTranscriptionRequest: postTranscriptionRequestMock,
}));

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
  expect(form.get("language")).toBe("en");
  expect(form.get("file")).toBeInstanceOf(Blob);
  const serialized = await new Request(call.url!, { method: "POST", body: form }).text();
  const partNames = [...serialized.matchAll(/Content-Disposition: form-data; name="([^"]+)"/g)].map(
    (match) => match[1],
  );
  expect(partNames).toEqual(["language", "file"]);
});

it.each([
  ...["", " \t\n", "  spoken words  "].map(
    (text) => [JSON.stringify({ text }), { text: text.trim() }, 200] as const,
  ),
  ...[{}, { text: null }].map(
    (payload) => [JSON.stringify(payload), "xAI transcription response missing text", 200] as const,
  ),
  ...["null", "[]", "{ nope"].map(
    (body) => [body, "xai.stt: malformed JSON response", 200] as const,
  ),
  ["unauthorized", "xAI audio transcription failed", 401] as const,
])("xai stt handles response %j", async (body, expected, status) => {
  const release = vi.fn();
  postTranscriptionRequestMock.mockResolvedValueOnce({
    response: new Response(body, { status }),
    release,
  });

  const result = transcribeAudio();
  if (typeof expected === "string") {
    await expect(result).rejects.toThrow(expected);
  } else {
    await expect(result).resolves.toEqual(expected);
  }
  expect(release).toHaveBeenCalledOnce();
});

it("registers as an audio media-understanding provider", () => {
  const provider = buildXaiMediaUnderstandingProvider();
  expect(provider).toMatchObject({ id: "xai", capabilities: ["audio"] });
  expect(provider.defaultModels).toBeUndefined();
  expect(provider.autoPriority).toEqual({ audio: 25 });
});
