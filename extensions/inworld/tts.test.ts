import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

import { inworldTTS, listInworldVoices } from "./tts.js";

type GuardRequest = {
  url: string;
  init?: RequestInit;
  auditContext?: string;
  policy?: unknown;
  timeoutMs?: number;
};

function queueGuardedResponse(response: Response): { release: ReturnType<typeof vi.fn> } {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, release });
  return { release };
}

function queueAudioResponse() {
  return queueGuardedResponse(
    Response.json({ result: { audioContent: Buffer.from("audio").toString("base64") } }),
  );
}

function lastGuardRequest(): GuardRequest {
  const calls = fetchWithSsrFGuardMock.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("fetchWithSsrFGuard was not called");
  }
  return call[0] as GuardRequest;
}

function readRequestBody(request: GuardRequest): string {
  const body = request.init?.body;
  if (typeof body !== "string") {
    throw new Error("expected request body to be a string");
  }
  return body;
}

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

describe("listInworldVoices", () => {
  it("maps voice metadata and filters entries without an ID", async () => {
    const { release } = queueGuardedResponse(
      Response.json({
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
            langCode: "EN_US",
            tags: ["female", "warm", "natural"],
            source: "SYSTEM",
          },
          { voiceId: "", displayName: "Empty" },
        ],
      }),
    );

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
        description: undefined,
        locale: "EN_US",
        gender: "female",
      },
    ]);
    const request = lastGuardRequest();
    expect(request.url).toBe("https://api.inworld.ai/voices/v1/voices");
    expect(request.auditContext).toBe("inworld-voices");
    expect(request.policy).toEqual({ hostnameAllowlist: ["api.inworld.ai"] });
    expect(request.timeoutMs).toBe(30_000);
    const headers = new Headers(request.init?.headers);
    expect(headers.get("authorization")).toBe("Basic test-key");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("throws on API errors with response body", async () => {
    queueGuardedResponse(new Response("service unavailable", { status: 503 }));

    await expect(listInworldVoices({ apiKey: "test-key" })).rejects.toThrow(
      "Inworld voices API error (503): service unavailable",
    );
  });

  it("returns empty array when no voices present", async () => {
    queueGuardedResponse(Response.json({}));

    const voices = await listInworldVoices({ apiKey: "test-key" });
    expect(voices).toStrictEqual([]);
  });

  it("passes language filter as query parameter", async () => {
    queueGuardedResponse(Response.json({ voices: [] }));

    await listInworldVoices({ apiKey: "test-key", language: "EN_US" });

    expect(lastGuardRequest().url).toBe("https://api.inworld.ai/voices/v1/voices?languages=EN_US");
  });
});

describe("inworldTTS", () => {
  it("concatenates an under-cap 1 MiB payload and skips blank stream lines", async () => {
    const payload = "x".repeat(1024 * 1024);
    const chunk1 = Buffer.from(payload).toString("base64");
    const chunk2 = Buffer.from("audio-chunk-2").toString("base64");
    const body = [
      "",
      JSON.stringify({ result: { audioContent: chunk1 } }),
      "",
      JSON.stringify({ result: { audioContent: chunk2 } }),
      "",
    ].join("\n");

    const { release } = queueGuardedResponse(new Response(body, { status: 200 }));

    const buffer = await inworldTTS({
      text: "Hello world",
      apiKey: "test-key",
    });

    expect(buffer.equals(Buffer.from(`${payload}audio-chunk-2`))).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    const request = lastGuardRequest();
    expect(request.url).toBe("https://api.inworld.ai/tts/v1/voice:stream");
    expect(request.policy).toEqual({ hostnameAllowlist: ["api.inworld.ai"] });
    expect(new Headers(request.init?.headers).get("authorization")).toBe("Basic test-key");
  });

  it("rejects malformed base64 audio chunks", async () => {
    const body = JSON.stringify({ result: { audioContent: "not-base64!" } });
    queueGuardedResponse(new Response(body, { status: 200 }));

    await expect(inworldTTS({ text: "test", apiKey: "fixture-api-key" })).rejects.toThrow(
      "Inworld TTS returned malformed base64 audio data",
    );
  });

  it("keeps truncated HTTP error bodies UTF-16 safe", async () => {
    const { release } = queueGuardedResponse(
      new Response(`${"e".repeat(399)}😀tail`, { status: 400 }),
    );

    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toMatchObject({
      message: `Inworld TTS API error (400): ${"e".repeat(399)}…`,
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("throws on in-stream errors", async () => {
    const body = JSON.stringify({
      error: { code: 3, message: "Invalid voice ID" },
    });
    queueGuardedResponse(new Response(body, { status: 200 }));

    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      "Inworld TTS stream error (3): Invalid voice ID",
    );
  });

  it("throws on empty audio response", async () => {
    const body = JSON.stringify({ result: { audioContent: "" } });
    queueGuardedResponse(new Response(body, { status: 200 }));

    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      "Inworld TTS returned no audio data",
    );
  });

  it("throws descriptive error on non-JSON line in stream", async () => {
    queueGuardedResponse(new Response(`${"p".repeat(79)}😀tail`, { status: 200 }));

    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toMatchObject({
      message: `Inworld TTS stream parse error: unexpected non-JSON line: ${"p".repeat(79)}`,
    });
  });

  it("includes temperature and sampleRateHertz when provided", async () => {
    queueAudioResponse();

    await inworldTTS({
      text: "Hello",
      apiKey: "test-key",
      voiceId: "Ashley",
      modelId: "inworld-tts-1.5-mini",
      audioEncoding: "PCM",
      sampleRateHertz: 22_050,
      temperature: 0.8,
    });

    const callBody = JSON.parse(readRequestBody(lastGuardRequest()));
    expect(callBody.voiceId).toBe("Ashley");
    expect(callBody.modelId).toBe("inworld-tts-1.5-mini");
    expect(callBody.audioConfig.audioEncoding).toBe("PCM");
    expect(callBody.audioConfig.sampleRateHertz).toBe(22_050);
    expect(callBody.temperature).toBe(0.8);
  });

  it("uses custom base URL", async () => {
    queueAudioResponse();

    await inworldTTS({
      text: "Hello",
      apiKey: "test-key",
      baseUrl: "https://custom.inworld.example.com/",
    });

    expect(lastGuardRequest().url).toBe("https://custom.inworld.example.com/tts/v1/voice:stream");
    expect(lastGuardRequest().policy).toEqual({
      hostnameAllowlist: ["custom.inworld.example.com"],
    });
  });
});

describe("Inworld response read bounding", () => {
  const MiB = 1024 * 1024;

  // An unbounded reader would never finish; the cap must cancel the stream.
  function infiniteByteStream(chunkBytes: number): {
    stream: ReadableStream<Uint8Array>;
    state: { enqueued: number; cancelled: boolean };
  } {
    const state = { enqueued: 0, cancelled: false };
    const chunk = new Uint8Array(chunkBytes).fill(0x61); // "a"
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.enqueued += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { stream, state };
  }

  it("fail-closed: rejects and cancels an oversized TTS audio stream instead of buffering it (32 MiB cap)", async () => {
    const { stream, state } = infiniteByteStream(8 * MiB);
    queueGuardedResponse(new Response(stream, { status: 200 }));

    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      /Inworld TTS audio stream too large: \d+ bytes \(limit: 33554432 bytes\)/,
    );
    expect(state.enqueued).toBeLessThanOrEqual(8);
    expect(state.cancelled).toBe(true);
  });

  it("fail-closed: rejects decoded audio that exceeds the shared audio cap", async () => {
    const decodedPayload = Buffer.alloc(16 * MiB + 1, 0x61);
    const body = JSON.stringify({
      result: { audioContent: decodedPayload.toString("base64") },
    });
    queueGuardedResponse(new Response(body, { status: 200 }));

    await expect(inworldTTS({ text: "test", apiKey: "test-key" })).rejects.toThrow(
      /Inworld TTS decoded audio too large: 16777217 bytes \(limit: 16777216 bytes\)/,
    );
  });

  it("fail-closed: truncates an oversized HTTP error body to a bounded marker", async () => {
    queueGuardedResponse(new Response("E".repeat(64 * 1024), { status: 500 }));

    const result = inworldTTS({ text: "test", apiKey: "test-key" });
    await expect(result).rejects.toBeInstanceOf(Error);
    await expect(result).rejects.toMatchObject({
      message: "Inworld TTS API error (500): (error body exceeded diagnostic limit; truncated)",
    });
  });

  it("fail-closed: rejects and cancels an oversized voices JSON stream (16 MiB cap)", async () => {
    const { stream, state } = infiniteByteStream(8 * MiB);
    queueGuardedResponse(new Response(stream, { status: 200 }));

    await expect(listInworldVoices({ apiKey: "test-key" })).rejects.toThrow(
      /Inworld voices response too large: \d+ bytes \(limit: 16777216 bytes\)/,
    );
    expect(state.enqueued).toBeLessThanOrEqual(4);
    expect(state.cancelled).toBe(true);
  });

  it("regression: malformed voices JSON under the cap throws descriptive error", async () => {
    queueGuardedResponse(new Response("{not-json", { status: 200 }));
    await expect(listInworldVoices({ apiKey: "test-key" })).rejects.toThrow(
      "Inworld voices API returned malformed JSON",
    );
  });
});
