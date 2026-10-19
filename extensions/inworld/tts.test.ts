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
  return queueBody({ result: { audioContent: Buffer.from("audio").toString("base64") } });
}

function queueBody(body: string | object, status = 200) {
  return queueGuardedResponse(
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  );
}

const synthesize = (params: Partial<Parameters<typeof inworldTTS>[0]> = {}) =>
  inworldTTS({ text: "test", apiKey: "test-key", ...params });

async function expectTtsError(body: string | object, error: string | RegExp, status = 200) {
  queueBody(body, status);
  await expect(synthesize()).rejects.toThrow(error);
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
    const voice = (name: string, tags: string[], description?: string) => ({
      voiceId: name,
      displayName: name,
      langCode: "EN_US",
      tags,
      description,
    });
    const { release } = queueBody({
      voices: [
        voice("Dennis", ["smooth", "male"], "Calm voice"),
        voice("Ashley", ["female"]),
        { voiceId: "", displayName: "Empty" },
      ],
    });

    const voices = await listInworldVoices({ apiKey: "test-key" });

    const metadata = (name: string, gender: string, description?: string) => ({
      id: name,
      name,
      description,
      locale: "EN_US",
      gender,
    });
    expect(voices).toEqual([
      metadata("Dennis", "male", "Calm voice"),
      metadata("Ashley", "female"),
    ]);
    const request = lastGuardRequest();
    expect(request).toMatchObject({
      url: "https://api.inworld.ai/voices/v1/voices",
      auditContext: "inworld-voices",
      timeoutMs: 30_000,
    });
    expect(request.policy).toEqual({ hostnameAllowlist: ["api.inworld.ai"] });
    const headers = new Headers(request.init?.headers);
    expect(headers.get("authorization")).toBe("Basic test-key");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("throws on API errors with response body", async () => {
    queueBody("service unavailable", 503);

    await expect(listInworldVoices({ apiKey: "test-key" })).rejects.toThrow(
      "Inworld voices API error (503): service unavailable",
    );
  });

  it("returns empty array when no voices present", async () => {
    queueGuardedResponse(Response.json({}));

    expect(await listInworldVoices({ apiKey: "test-key" })).toStrictEqual([]);
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
    const line = (text: string) =>
      JSON.stringify({ result: { audioContent: Buffer.from(text).toString("base64") } });
    const { release } = queueBody(["", line(payload), "", line("audio-chunk-2"), ""].join("\n"));
    const buffer = await synthesize({ text: "Hello world" });

    expect(buffer.equals(Buffer.from(`${payload}audio-chunk-2`))).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    const request = lastGuardRequest();
    expect(request.url).toBe("https://api.inworld.ai/tts/v1/voice:stream");
    expect(request.policy).toEqual({ hostnameAllowlist: ["api.inworld.ai"] });
    expect(new Headers(request.init?.headers).get("authorization")).toBe("Basic test-key");
  });

  it("rejects malformed base64 audio chunks", async () => {
    await expectTtsError(
      { result: { audioContent: "not-base64!" } },
      "Inworld TTS returned malformed base64 audio data",
    );
  });

  it("keeps truncated HTTP error bodies UTF-16 safe", async () => {
    const { release } = queueBody(`${"e".repeat(399)}😀tail`, 400);

    await expect(synthesize()).rejects.toMatchObject({
      message: `Inworld TTS API error (400): ${"e".repeat(399)}…`,
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("throws on in-stream errors", async () => {
    await expectTtsError(
      { error: { code: 3, message: "Invalid voice ID" } },
      "Inworld TTS stream error (3): Invalid voice ID",
    );
  });

  it("throws on empty audio response", async () => {
    await expectTtsError({ result: { audioContent: "" } }, "Inworld TTS returned no audio data");
  });

  it("throws descriptive error on non-JSON line in stream", async () => {
    queueBody(`${"p".repeat(79)}😀tail`);

    await expect(synthesize()).rejects.toMatchObject({
      message: `Inworld TTS stream parse error: unexpected non-JSON line: ${"p".repeat(79)}`,
    });
  });

  it("includes temperature and sampleRateHertz when provided", async () => {
    queueAudioResponse();

    const options = {
      text: "Hello",
      apiKey: "test-key",
      voiceId: "Ashley",
      modelId: "inworld-tts-1.5-mini",
      sampleRateHertz: 22_050,
      temperature: 0.8,
    };
    await synthesize({ ...options, audioEncoding: "PCM" });
    expect(JSON.parse(readRequestBody(lastGuardRequest()))).toEqual({
      text: "Hello",
      voiceId: "Ashley",
      modelId: "inworld-tts-1.5-mini",
      temperature: 0.8,
      audioConfig: { audioEncoding: "PCM", sampleRateHertz: 22_050 },
    });
  });

  it("uses custom base URL", async () => {
    queueAudioResponse();

    await synthesize({ baseUrl: "https://custom.inworld.example.com/" });

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
    const chunk = new Uint8Array(chunkBytes).fill(0x61);
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

    await expect(synthesize()).rejects.toThrow(
      /Inworld TTS audio stream too large: \d+ bytes \(limit: 33554432 bytes\)/,
    );
    expect(state.enqueued).toBeLessThanOrEqual(8);
    expect(state.cancelled).toBe(true);
  });

  it("fail-closed: rejects decoded audio that exceeds the shared audio cap", async () => {
    await expectTtsError(
      { result: { audioContent: Buffer.alloc(16 * MiB + 1, 0x61).toString("base64") } },
      /Inworld TTS decoded audio too large: 16777217 bytes \(limit: 16777216 bytes\)/,
    );
  });

  it("fail-closed: truncates an oversized HTTP error body to a bounded marker", async () => {
    queueBody("E".repeat(64 * 1024), 500);

    const result = synthesize();
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
    queueBody("{not-json");
    await expect(listInworldVoices({ apiKey: "test-key" })).rejects.toThrow(
      "Inworld voices API returned malformed JSON",
    );
  });
});
