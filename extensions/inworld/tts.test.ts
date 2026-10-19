import "openclaw/plugin-sdk/compiled-subprocess-testing";
import assert from "node:assert/strict";
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

type GuardRequest = Parameters<
  typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard
>[0];

function queueResponse(body: string | object | Response, status = 200) {
  const response =
    body instanceof Response
      ? body
      : new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, release });
  return { release };
}

const chunk = (audioContent: string) => ({ result: { audioContent } });
const audio = (text: string) => chunk(Buffer.from(text).toString("base64"));

const synthesize = (params: Partial<Parameters<typeof inworldTTS>[0]> = {}) =>
  inworldTTS({ text: "test", apiKey: "test-key", ...params });

function lastGuardRequest(): GuardRequest {
  const call = fetchWithSsrFGuardMock.mock.lastCall;
  assert(call, "fetchWithSsrFGuard was not called");
  return call[0] as GuardRequest;
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
    const { release } = queueResponse({
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
    queueResponse("service unavailable", 503);

    await expect(listInworldVoices({ apiKey: "test-key" })).rejects.toThrow(
      "Inworld voices API error (503): service unavailable",
    );
  });

  it("returns empty array when no voices present", async () => {
    queueResponse({});

    expect(await listInworldVoices({ apiKey: "test-key" })).toStrictEqual([]);
  });

  it("passes language filter as query parameter", async () => {
    queueResponse({ voices: [] });

    await listInworldVoices({ apiKey: "test-key", language: "EN_US" });

    expect(lastGuardRequest().url).toBe("https://api.inworld.ai/voices/v1/voices?languages=EN_US");
  });
});

describe("inworldTTS", () => {
  it("concatenates an under-cap 1 MiB payload and skips blank stream lines", async () => {
    const payload = "x".repeat(1024 * 1024);
    const line = (text: string) => JSON.stringify(audio(text));
    const { release } = queueResponse(
      ["", line(payload), "", line("audio-chunk-2"), ""].join("\n"),
    );
    const buffer = await synthesize({ text: "Hello world" });

    expect(buffer.equals(Buffer.from(`${payload}audio-chunk-2`))).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    const request = lastGuardRequest();
    expect(request.url).toBe("https://api.inworld.ai/tts/v1/voice:stream");
    expect(request.policy).toEqual({ hostnameAllowlist: ["api.inworld.ai"] });
    expect(new Headers(request.init?.headers).get("authorization")).toBe("Basic test-key");
  });

  it.each([
    [chunk("not-base64!"), "Inworld TTS returned malformed base64 audio data"],
    [
      { error: { code: 3, message: "Invalid voice ID" } },
      "Inworld TTS stream error (3): Invalid voice ID",
    ],
    [chunk(""), "Inworld TTS returned no audio data"],
  ] as const)("rejects %j", async (body, message) => {
    queueResponse(body);
    await expect(synthesize()).rejects.toThrow(message);
  });

  it.each([
    [400, `${"e".repeat(399)}😀tail`, `Inworld TTS API error (400): ${"e".repeat(399)}…`],
    [
      200,
      `${"p".repeat(79)}😀tail`,
      `Inworld TTS stream parse error: unexpected non-JSON line: ${"p".repeat(79)}`,
    ],
    [
      500,
      "E".repeat(64 * 1024),
      "Inworld TTS API error (500): (error body exceeded diagnostic limit; truncated)",
    ],
  ] as const)("bounds diagnostics for status %i", async (status, body, message) => {
    const { release } = queueResponse(body, status);
    const result = synthesize();
    await expect(result).rejects.toBeInstanceOf(Error);
    await expect(result).rejects.toMatchObject({ message });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("includes temperature and sampleRateHertz when provided", async () => {
    queueResponse(audio("audio"));
    const options = {
      voiceId: "Ashley",
      modelId: "inworld-tts-1.5-mini",
      temperature: 0.8,
    };
    await synthesize({ ...options, sampleRateHertz: 22_050, audioEncoding: "PCM" });
    const body = lastGuardRequest().init?.body;
    assert(typeof body === "string", "expected request body to be a string");
    expect(JSON.parse(body)).toEqual({
      ...options,
      text: "test",
      audioConfig: { audioEncoding: "PCM", sampleRateHertz: 22_050 },
    });
  });

  it("uses custom base URL", async () => {
    queueResponse(audio("audio"));

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
  function infiniteByteStream(chunkBytes: number) {
    const state = { enqueued: 0, cancelled: false };
    const bytes = new Uint8Array(chunkBytes).fill(0x61);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.enqueued += 1;
        controller.enqueue(bytes);
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { stream, state };
  }

  it.each([
    [32, synthesize, 8, "TTS audio stream"],
    [16, () => listInworldVoices({ apiKey: "test-key" }), 4, "voices response"],
  ] as const)("enforces %i MiB stream limit and cancels", async (limit, read, maxChunks, kind) => {
    const { stream, state } = infiniteByteStream(8 * MiB);
    queueResponse(new Response(stream, { status: 200 }));
    await expect(read()).rejects.toThrow(
      new RegExp(`Inworld ${kind} too large: \\d+ bytes \\(limit: ${limit * MiB} bytes\\)`),
    );
    expect(state.enqueued).toBeLessThanOrEqual(maxChunks);
    expect(state.cancelled).toBe(true);
  });

  it("fail-closed: rejects decoded audio that exceeds the shared audio cap", async () => {
    queueResponse(chunk(Buffer.alloc(16 * MiB + 1, 0x61).toString("base64")));
    await expect(synthesize()).rejects.toThrow(
      /Inworld TTS decoded audio too large: 16777217 bytes \(limit: 16777216 bytes\)/,
    );
  });

  it("regression: malformed voices JSON under the cap throws descriptive error", async () => {
    queueResponse("{not-json");
    await expect(listInworldVoices({ apiKey: "test-key" })).rejects.toThrow(
      "Inworld voices API returned malformed JSON",
    );
  });
});
