import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenrouterMusicGenerationProvider } from "./music-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  fetchWithTimeoutMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "openrouter-key" })),
  fetchWithTimeoutMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  resolveProviderHttpRequestConfigMock: vi.fn((params) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: Boolean(params.allowPrivateNetwork),
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined,
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  fetchWithTimeout: fetchWithTimeoutMock,
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
}));

function makeSseStream(chunks: Array<{ data?: string; transcript?: string }>): ReadableStream {
  const lines: string[] = [];
  for (const chunk of chunks) {
    const delta: Record<string, unknown> = {};
    if (chunk.data != null || chunk.transcript != null) {
      const audio: Record<string, string> = {};
      if (chunk.data != null) {
        audio.data = chunk.data;
      }
      if (chunk.transcript != null) {
        audio.transcript = chunk.transcript;
      }
      delta.audio = audio;
    }
    lines.push(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
  }
  lines.push("data: [DONE]\n\n");

  const encoder = new TextEncoder();
  const text = lines.join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

describe("openrouter music generation provider", () => {
  afterEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    fetchWithTimeoutMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
  });

  it("exposes correct provider metadata", () => {
    const provider = buildOpenrouterMusicGenerationProvider();
    expect(provider.id).toBe("openrouter");
    expect(provider.label).toBe("OpenRouter");
    expect(provider.defaultModel).toBe("openai/gpt-4o-audio-preview");
    expect(provider.models).toContain("openai/gpt-4o-audio-preview");
    expect(provider.capabilities.generate?.maxTracks).toBe(1);
    expect(provider.capabilities.edit?.enabled).toBe(false);
  });

  it("generates music from a streaming audio response", async () => {
    const audioBase64Part1 = Buffer.from("audio-part-1").toString("base64");
    const audioBase64Part2 = Buffer.from("audio-part-2").toString("base64");

    fetchWithTimeoutMock.mockResolvedValue(
      new Response(
        makeSseStream([
          { data: audioBase64Part1, transcript: "Hello " },
          { data: audioBase64Part2, transcript: "world" },
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const provider = buildOpenrouterMusicGenerationProvider();
    const result = await provider.generateMusic({
      provider: "openrouter",
      model: "openai/gpt-4o-audio-preview",
      prompt: "Create a jazz melody",
      cfg: {},
    });

    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]?.mimeType).toBe("audio/mpeg");
    expect(result.tracks[0]?.fileName).toBe("track-1.mp3");
    const expectedBuffer = Buffer.from(audioBase64Part1 + audioBase64Part2, "base64");
    expect(result.tracks[0]?.buffer).toEqual(expectedBuffer);
    expect(result.lyrics).toEqual(["Hello world"]);
    expect(result.model).toBe("openai/gpt-4o-audio-preview");

    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"stream":true'),
      }),
      expect.any(Number),
      expect.any(Function),
    );
  });

  it("includes lyrics in the prompt when provided", async () => {
    const audioBase64 = Buffer.from("track").toString("base64");
    fetchWithTimeoutMock.mockResolvedValue(
      new Response(makeSseStream([{ data: audioBase64 }]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    const provider = buildOpenrouterMusicGenerationProvider();
    await provider.generateMusic({
      provider: "openrouter",
      model: "openai/gpt-4o-audio-preview",
      prompt: "A ballad",
      cfg: {},
      lyrics: "La la la",
    });

    const callBody = JSON.parse(
      fetchWithTimeoutMock.mock.calls[0]?.[1]?.body as string,
    ) as Record<string, unknown>;
    const messages = callBody.messages as Array<{ content: string }>;
    expect(messages[0]?.content).toContain("A ballad");
    expect(messages[0]?.content).toContain("La la la");
  });

  it("requests wav format when specified", async () => {
    const audioBase64 = Buffer.from("wav-data").toString("base64");
    fetchWithTimeoutMock.mockResolvedValue(
      new Response(makeSseStream([{ data: audioBase64 }]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    const provider = buildOpenrouterMusicGenerationProvider();
    const result = await provider.generateMusic({
      provider: "openrouter",
      model: "openai/gpt-4o-audio-preview",
      prompt: "A drumbeat",
      cfg: {},
      format: "wav",
    });

    expect(result.tracks[0]?.mimeType).toBe("audio/wav");
    expect(result.tracks[0]?.fileName).toBe("track-1.wav");

    const callBody = JSON.parse(
      fetchWithTimeoutMock.mock.calls[0]?.[1]?.body as string,
    ) as Record<string, unknown>;
    const audio = callBody.audio as { format: string };
    expect(audio.format).toBe("wav");
  });

  it("throws when stream contains no audio data", async () => {
    fetchWithTimeoutMock.mockResolvedValue(
      new Response(makeSseStream([]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    const provider = buildOpenrouterMusicGenerationProvider();
    await expect(
      provider.generateMusic({
        provider: "openrouter",
        model: "openai/gpt-4o-audio-preview",
        prompt: "no audio",
        cfg: {},
      }),
    ).rejects.toThrow("OpenRouter music generation response missing audio data");
  });

  it("throws when API key is missing", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({ apiKey: "" });

    const provider = buildOpenrouterMusicGenerationProvider();
    await expect(
      provider.generateMusic({
        provider: "openrouter",
        model: "openai/gpt-4o-audio-preview",
        prompt: "test",
        cfg: {},
      }),
    ).rejects.toThrow("OpenRouter API key missing");
  });
});
