import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  requireFirstPostJsonRecordRequest,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { expect, it, vi } from "vitest";
import { vercelAiGatewayMediaUnderstandingProvider } from "./media-understanding-provider.js";

const { postJsonRequestMock } = getProviderHttpMocks();

installProviderHttpMockCleanup();

function respond(body = JSON.stringify({ text: "ok" }), status = 200) {
  const release = vi.fn(async () => {});
  postJsonRequestMock.mockResolvedValue({ response: new Response(body, { status }), release });
  return release;
}

function transcribe(
  overrides: Partial<
    Parameters<NonNullable<typeof vercelAiGatewayMediaUnderstandingProvider.transcribeAudio>>[0]
  > = {},
) {
  const transcribeAudio = vercelAiGatewayMediaUnderstandingProvider.transcribeAudio;
  if (!transcribeAudio) {
    throw new Error("expected Vercel AI Gateway audio transcription");
  }
  return transcribeAudio({
    buffer: Buffer.from("audio-bytes"),
    fileName: "voice.ogg",
    mime: "audio/ogg; codecs=opus",
    apiKey: "vck_test",
    timeoutMs: 12_000,
    fetchFn: fetch,
    ...overrides,
  });
}

it("posts base64 audio to the native AI Gateway transcription endpoint", async () => {
  const release = respond(JSON.stringify({ text: "hello world", durationInSeconds: 2 }));

  await expect(transcribe()).resolves.toEqual({
    text: "hello world",
    model: "openai/gpt-transcribe",
  });

  const request = requireFirstPostJsonRecordRequest(postJsonRequestMock, "STT request");
  expect(request.url).toBe("https://ai-gateway.vercel.sh/v4/ai/transcription-model");
  expect(request.body).toEqual({
    audio: Buffer.from("audio-bytes").toString("base64"),
    mediaType: "audio/ogg",
  });
  expect(request.timeoutMs).toBe(12_000);
  const headers = request.headers;
  if (!(headers instanceof Headers)) {
    throw new Error("expected request headers");
  }
  expect(Object.fromEntries(headers)).toMatchObject({
    authorization: "Bearer vck_test",
    "content-type": "application/json",
    "ai-gateway-protocol-version": "0.0.1",
    "ai-gateway-auth-method": "api-key",
    "ai-transcription-model-specification-version": "4",
    "ai-model-id": "openai/gpt-transcribe",
  });
  expect(release).toHaveBeenCalledOnce();
});

it("keys language, prompt and query options by the model's provider", async () => {
  respond();
  await transcribe({
    model: "elevenlabs/scribe-v2",
    language: " en ",
    prompt: "Names: Ethan",
    query: { tagAudioEvents: false },
  });

  const request = requireFirstPostJsonRecordRequest(postJsonRequestMock, "STT request");
  expect(request.headers instanceof Headers && request.headers.get("ai-model-id")).toBe(
    "elevenlabs/scribe-v2",
  );
  expect(request.body).toMatchObject({
    providerOptions: {
      elevenlabs: { language: "en", prompt: "Names: Ethan", tagAudioEvents: false },
    },
  });
});

it("infers the media type from the file name when the mime type is missing", async () => {
  respond();
  await transcribe({ mime: undefined, fileName: "voice.mp3" });
  expect(requireFirstPostJsonRecordRequest(postJsonRequestMock, "STT request").body).toMatchObject({
    mediaType: "audio/mpeg",
  });
});

it("rejects audio whose media type cannot be resolved without calling the Gateway", async () => {
  await expect(transcribe({ mime: undefined, fileName: "voice" })).rejects.toThrow(
    "Vercel AI Gateway STT could not resolve audio media type",
  );
  expect(postJsonRequestMock).not.toHaveBeenCalled();
});

it.each([
  { body: JSON.stringify({ durationInSeconds: 1 }), status: 200, error: "missing text" },
  { body: '{"error":{"message":"bad key"}}', status: 401, error: "transcription failed" },
])("rejects status $status response $body", async ({ body, status, error }) => {
  respond(body, status);
  await expect(transcribe()).rejects.toThrow(error);
});
