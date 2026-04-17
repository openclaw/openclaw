import { afterEach, describe, expect, it, vi } from "vitest";
import { inworldTTS, listInworldVoices } from "./tts.js";

describe("listInworldVoices", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("maps Inworld voice metadata into speech voice options", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          voices: [
            {
              voiceId: "Dennis",
              displayName: "Dennis",
              description: "Middle-aged man with a smooth, calm and friendly voice",
              langCode: "EN_US",
              tags: ["male", "middle-aged", "smooth", "calm", "friendly"],
              source: "SYSTEM",
            },
            {
              voiceId: "Ashley",
              displayName: "Ashley",
              description: "A warm, natural female voice",
              langCode: "EN_US",
              tags: ["female", "warm", "natural"],
              source: "SYSTEM",
            },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const voices = await listInworldVoices({ apiKey: "test-key" });

    expect(voices).toEqual([
      {
        id: "Dennis",
        name: "Dennis",
        description: "Middle-aged man with a smooth, calm and friendly voice",
        locale: "EN_US",
        gender: "male",
      },
      {
        id: "Ashley",
        name: "Ashley",
        description: "A warm, natural female voice",
        locale: "EN_US",
        gender: "female",
      },
    ]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.inworld.ai/voices/v1/voices",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Basic test-key",
        }),
      }),
    );
  });

  it("throws on API errors with response body", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("service unavailable", { status: 503 }),
      ) as unknown as typeof globalThis.fetch;

    await expect(listInworldVoices({ apiKey: "test-key" })).rejects.toThrow(
      "Inworld voices API error (503): service unavailable",
    );
  });

  it("filters out voices with empty voiceId", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          voices: [
            { voiceId: "", displayName: "Empty" },
            { voiceId: "Dennis", displayName: "Dennis" },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const voices = await listInworldVoices({ apiKey: "test-key" });
    expect(voices).toHaveLength(1);
    expect(voices[0].id).toBe("Dennis");
  });

  it("returns empty array when no voices present", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({}), { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

    const voices = await listInworldVoices({ apiKey: "test-key" });
    expect(voices).toEqual([]);
  });

  it("passes language filter as query parameter", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ voices: [] }), { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

    await listInworldVoices({ apiKey: "test-key", language: "EN_US" });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.inworld.ai/voices/v1/voices?languages=EN_US",
      expect.any(Object),
    );
  });
});

describe("inworldTTS", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("concatenates base64 audio chunks from streaming response", async () => {
    const chunk1 = Buffer.from("audio-chunk-1").toString("base64");
    const chunk2 = Buffer.from("audio-chunk-2").toString("base64");
    const body = [
      JSON.stringify({ result: { audioContent: chunk1 } }),
      JSON.stringify({ result: { audioContent: chunk2 } }),
    ].join("\n");

    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(body, { status: 200 })) as unknown as typeof globalThis.fetch;

    const buffer = await inworldTTS({
      text: "Hello world",
      apiKey: "test-key",
    });

    expect(buffer).toEqual(
      Buffer.concat([Buffer.from("audio-chunk-1"), Buffer.from("audio-chunk-2")]),
    );
  });

  it("throws on HTTP errors with response body", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("bad request body", { status: 400 }),
      ) as unknown as typeof globalThis.fetch;

    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      "Inworld TTS API error (400): bad request body",
    );
  });

  it("throws on in-stream errors", async () => {
    const body = JSON.stringify({
      error: { code: 3, message: "Invalid voice ID" },
    });

    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(body, { status: 200 })) as unknown as typeof globalThis.fetch;

    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      "Inworld TTS stream error (3): Invalid voice ID",
    );
  });

  it("throws on empty audio response", async () => {
    const body = JSON.stringify({ result: { audioContent: "" } });

    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(body, { status: 200 })) as unknown as typeof globalThis.fetch;

    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      "Inworld TTS returned no audio data",
    );
  });

  it("throws descriptive error on non-JSON line in stream", async () => {
    const body = "<html>Rate limited</html>";

    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(body, { status: 200 })) as unknown as typeof globalThis.fetch;

    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      "Inworld TTS stream parse error: unexpected non-JSON line:",
    );
  });

  it("sends correct request body with defaults", async () => {
    const chunk = Buffer.from("audio").toString("base64");
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ result: { audioContent: chunk } }), { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

    await inworldTTS({ text: "Hello", apiKey: "test-key" });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.inworld.ai/tts/v1/voice:stream",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Basic test-key",
        }),
        body: JSON.stringify({
          text: "Hello",
          voiceId: "Dennis",
          modelId: "inworld-tts-1.5-max",
          audioConfig: { audioEncoding: "MP3" },
        }),
      }),
    );
  });

  it("includes temperature and sampleRateHertz when provided", async () => {
    const chunk = Buffer.from("audio").toString("base64");
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ result: { audioContent: chunk } }), { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

    await inworldTTS({
      text: "Hello",
      apiKey: "test-key",
      voiceId: "Ashley",
      modelId: "inworld-tts-1.5-mini",
      audioEncoding: "PCM",
      sampleRateHertz: 22_050,
      temperature: 0.8,
    });

    const callBody = JSON.parse(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(callBody.voiceId).toBe("Ashley");
    expect(callBody.modelId).toBe("inworld-tts-1.5-mini");
    expect(callBody.audioConfig.audioEncoding).toBe("PCM");
    expect(callBody.audioConfig.sampleRateHertz).toBe(22_050);
    expect(callBody.temperature).toBe(0.8);
  });

  it("uses custom base URL", async () => {
    const chunk = Buffer.from("audio").toString("base64");
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ result: { audioContent: chunk } }), { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

    await inworldTTS({
      text: "Hello",
      apiKey: "test-key",
      baseUrl: "https://custom.inworld.example.com/",
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://custom.inworld.example.com/tts/v1/voice:stream",
      expect.any(Object),
    );
  });

  it("skips empty lines in streaming response", async () => {
    const chunk = Buffer.from("audio").toString("base64");
    const body = `\n${JSON.stringify({ result: { audioContent: chunk } })}\n\n`;

    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(body, { status: 200 })) as unknown as typeof globalThis.fetch;

    const buffer = await inworldTTS({ text: "test", apiKey: "test-key" });
    expect(buffer).toEqual(Buffer.from("audio"));
  });
});
