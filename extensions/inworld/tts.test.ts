import "openclaw/plugin-sdk/compiled-subprocess-testing";
import assert from "node:assert/strict";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({ fetchWithSsrFGuardMock: vi.fn() }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));
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
function requestBody() {
  const body = lastGuardRequest().init?.body;
  assert(typeof body === "string", "expected request body to be a string");
  return JSON.parse(body);
}
afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  vi.restoreAllMocks();
});
afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

it.each([
  ["TTS", 200, chunk("not-base64!"), "returned malformed base64 audio data"],
  [
    "TTS",
    200,
    { error: { code: 3, message: "Invalid voice ID" } },
    "stream error (3): Invalid voice ID",
  ],
  ["TTS", 200, chunk(""), "returned no audio data"],
  ["TTS", 400, `${"e".repeat(399)}😀tail`, `API error (400): ${"e".repeat(399)}…`],
  [
    "TTS",
    200,
    `${"p".repeat(79)}😀tail`,
    `stream parse error: unexpected non-JSON line: ${"p".repeat(79)}`,
  ],
  [
    "TTS",
    500,
    "E".repeat(64 * 1024),
    "API error (500): (error body exceeded diagnostic limit; truncated)",
  ],
  ["voices", 503, "service unavailable", "API error (503): service unavailable"],
  ["voices", 200, "{not-json", "API returned malformed JSON"],
] as const)("%s rejects status %i with %j", async (kind, status, body, message) => {
  const { release } = queueResponse(body, status);
  const result = kind === "TTS" ? synthesize() : listInworldVoices({ apiKey: "test-key" });
  await expect(result).rejects.toBeInstanceOf(Error);
  await expect(result).rejects.toMatchObject({ message: `Inworld ${kind} ${message}` });
  expect(release).toHaveBeenCalledTimes(1);
});

describe("listInworldVoices", () => {
  it("maps voice metadata and filters entries without an ID", async () => {
    const common = { langCode: "EN_US", description: "Calm voice" };
    const { release } = queueResponse({
      voices: [
        { ...common, voiceId: "Dennis", displayName: "Dennis", tags: ["smooth", "male"] },
        { voiceId: "Ashley", displayName: "Ashley", langCode: "EN_US", tags: ["female"] },
        { voiceId: "", displayName: "Empty" },
      ],
    });
    expect(await listInworldVoices({ apiKey: "test-key" })).toEqual([
      { id: "Dennis", name: "Dennis", locale: "EN_US", description: "Calm voice", gender: "male" },
      { id: "Ashley", name: "Ashley", locale: "EN_US", description: undefined, gender: "female" },
    ]);
    const request = lastGuardRequest();
    expect(request).toMatchObject({
      url: "https://api.inworld.ai/voices/v1/voices",
      auditContext: "inworld-voices",
      timeoutMs: 30_000,
    });
    expect(request.policy).toEqual({ hostnameAllowlist: ["api.inworld.ai"] });
    expect(new Headers(request.init?.headers).get("authorization")).toBe("Basic test-key");
    expect(release).toHaveBeenCalledTimes(1);
  });
  it("returns empty array when no voices present", async () => {
    queueResponse({});
    expect(await listInworldVoices({ apiKey: "test-key" })).toStrictEqual([]);
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
  it("serializes optional audio and voice settings", async () => {
    queueResponse(audio("audio"));
    const voice = { voiceId: "Ashley", modelId: "inworld-tts-1.5-mini", temperature: 0.8 };
    const audioConfig = {
      audioEncoding: "PCM" as const,
      sampleRateHertz: 22_050,
      speakingRate: 1.3,
    };
    await synthesize({ ...voice, ...audioConfig });
    expect(requestBody()).toEqual({ text: "test", ...voice, audioConfig });
  });
  it.each([
    ["inworld-tts-2", "CREATIVE"],
    ["inworld-tts-2-flash", undefined],
    ["inworld-tts-1.5-max", undefined],
  ] as const)("limits deliveryMode to TTS-2 (%s)", async (modelId, deliveryMode) => {
    queueResponse(audio("audio"));
    await synthesize({ modelId, deliveryMode: "CREATIVE" });
    expect(requestBody()).toEqual({
      text: "test",
      voiceId: "Sarah",
      modelId,
      audioConfig: { audioEncoding: "MP3" },
      ...(deliveryMode ? { deliveryMode } : {}),
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
});
