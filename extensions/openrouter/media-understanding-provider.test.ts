import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { describe, expect, it, vi } from "vitest";
import { openrouterMediaUnderstandingProvider } from "./media-understanding-provider.js";

const transcribeOpenRouterAudio = openrouterMediaUnderstandingProvider.transcribeAudio;
if (!transcribeOpenRouterAudio) {
  throw new Error("expected OpenRouter audio transcription provider");
}

const { postJsonRequestMock, resolveProviderHttpRequestConfigMock } = getProviderHttpMocks();

installProviderHttpMockCleanup();

function firstPostJsonRequest(): { body?: unknown; headers?: Headers } {
  const [request] = postJsonRequestMock.mock.calls[0] ?? [];
  if (!request || typeof request !== "object") {
    throw new Error("expected first OpenRouter JSON request");
  }
  return request as { body?: unknown; headers?: Headers };
}

function respond(body = JSON.stringify({ text: "ok" }), status = 200) {
  const release = vi.fn(async () => {});
  postJsonRequestMock.mockResolvedValue({ response: new Response(body, { status }), release });
  return release;
}
function transcribe(overrides: Partial<Parameters<typeof transcribeOpenRouterAudio>[0]> = {}) {
  return transcribeOpenRouterAudio({
    buffer: Buffer.from("audio"),
    fileName: "voice.wav",
    mime: "audio/wav",
    apiKey: "sk-openrouter",
    timeoutMs: 5_000,
    fetchFn: fetch,
    ...overrides,
  });
}
function inputAudio(data: string, format: string) {
  return { data: Buffer.from(data).toString("base64"), format };
}

describe("openrouter media understanding provider", () => {
  it("sends JSON STT payload to OpenRouter transcriptions endpoint", async () => {
    const release = respond(JSON.stringify({ text: "hello world" }));
    const result = await transcribe({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.oga",
      mime: "audio/ogg",
      timeoutMs: 12_000,
      language: " en ",
    });

    expect(result).toEqual({
      text: "hello world",
      model: "openai/whisper-large-v3-turbo",
    });
    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith({
      baseUrl: undefined,
      defaultBaseUrl: "https://openrouter.ai/api/v1",
      headers: undefined,
      request: undefined,
      defaultHeaders: {
        Authorization: "Bearer sk-openrouter",
        "Content-Type": "application/json",
      },
      provider: "openrouter",
      api: "openrouter-stt",
      capability: "audio",
      transport: "media-understanding",
    });
    expect(postJsonRequestMock).toHaveBeenCalledWith({
      url: "https://openrouter.ai/api/v1/audio/transcriptions",
      headers: expect.any(Headers),
      body: {
        model: "openai/whisper-large-v3-turbo",
        input_audio: inputAudio("audio-bytes", "ogg"),
        language: "en",
      },
      timeoutMs: 12_000,
      fetchFn: fetch,
      allowPrivateNetwork: false,
      dispatcherPolicy: undefined,
      auditContext: "openrouter stt",
    });
    const headers = firstPostJsonRequest().headers;
    if (!headers) {
      throw new Error("expected OpenRouter request headers");
    }
    expect(headers.get("authorization")).toBe("Bearer sk-openrouter");
    expect(release).toHaveBeenCalledOnce();
  });

  it("accepts temperature via provider query options", async () => {
    respond();
    await transcribe({
      fileName: "voice.webm",
      mime: undefined,
      query: { temperature: 0.2 },
    });

    expect(firstPostJsonRequest().body).toEqual({
      model: "openai/whisper-large-v3-turbo",
      input_audio: inputAudio("audio", "webm"),
      temperature: 0.2,
    });
  });

  it.each([
    ["opus", "ogg"],
    ["mp4", "m4a"],
  ])("resolves %s filename extension to %s when mime is missing", async (extension, format) => {
    respond();
    await transcribe({ fileName: `voice.${extension}`, mime: undefined });

    expect(firstPostJsonRequest().body).toEqual({
      model: "openai/whisper-large-v3-turbo",
      input_audio: inputAudio("audio", format),
    });
  });

  it("throws when format cannot be resolved", async () => {
    await expect(
      transcribe({ fileName: "voice.bin", mime: "application/octet-stream" }),
    ).rejects.toThrow("OpenRouter STT could not resolve audio format");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  const transcribeWavResponse = (body: string, status = 200) => {
    respond(body, status);
    return transcribe();
  };

  it.each(["", " \t\n"])(
    "returns an empty transcript for silent audio (%j) without retrying",
    async (text) => {
      await expect(transcribeWavResponse(JSON.stringify({ text }))).resolves.toMatchObject({
        text: "",
      });
      expect(postJsonRequestMock).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ...[{}, { text: null }, { text: 42 }, { error: "upstream failed" }].map((payload) => ({
      body: JSON.stringify(payload),
      status: 200,
      error: "OpenRouter transcription response missing text",
    })),
    ...["null", "[]", "{ nope"].map((body) => ({
      body,
      status: 200,
      error: "openrouter.stt: malformed JSON response",
    })),
    { body: "unauthorized", status: 401, error: "OpenRouter audio transcription failed" },
  ])("rejects status $status response $body", async ({ body, status, error }) => {
    await expect(transcribeWavResponse(body, status)).rejects.toThrow(error);
  });
});
