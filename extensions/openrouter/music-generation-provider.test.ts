import assert from "node:assert/strict";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  requireFirstPostJsonRecordRequest,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { expectExplicitMusicGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildOpenRouterMusicGenerationProvider } from "./music-generation-provider.js";

const { assertOkOrThrowHttpErrorMock, postJsonRequestMock, resolveApiKeyForProviderMock } =
  getProviderHttpMocks();

installProviderHttpMockCleanup();

function sseResponse(
  lines: Array<string | Uint8Array>,
  options?: { cancel?: () => void | Promise<void>; releaseLock?: () => void },
): Response {
  const encoder = new TextEncoder();
  const response = new Response(
    ReadableStream.from(
      lines.map((line) => (typeof line === "string" ? encoder.encode(line) : line)),
    ),
    { headers: { "content-type": "text/event-stream" } },
  );
  if (options) {
    const body = response.body!;
    const reader = body.getReader();
    vi.spyOn(reader, "cancel").mockImplementation(async () => options.cancel?.());
    if (options.releaseLock) {
      vi.spyOn(reader, "releaseLock").mockImplementation(options.releaseLock);
    }
    vi.spyOn(body, "getReader").mockReturnValue(reader);
  }
  return response;
}
const audioBytes = Buffer.from("wav-bytes");
const audioBase64 = audioBytes.toString("base64");
const done = "data: [DONE]\n";
function sseResponseLines(data: string, transcript?: string): string[] {
  return [audioEvent({ data, transcript }), done];
}
const postRequest = () => requireFirstPostJsonRecordRequest(postJsonRequestMock, "music request");

type MusicRequest = Parameters<
  ReturnType<typeof buildOpenRouterMusicGenerationProvider>["generateMusic"]
>[0];
function generateMusic(overrides: Partial<MusicRequest> = {}) {
  return buildOpenRouterMusicGenerationProvider().generateMusic({
    provider: "openrouter",
    model: "",
    prompt: "synthetic soundtrack",
    cfg: {},
    ...overrides,
  });
}
async function rejectMusic(error: string, overrides: Partial<MusicRequest> = {}) {
  await expect(generateMusic(overrides)).rejects.toThrow(`OpenRouter music generation ${error}`);
}
const mediaLimit = (bytes: number) => ({
  agents: { defaults: { mediaMaxMb: bytes / (1024 * 1024) } },
});

function mockStream(response: Response, release = vi.fn(async () => {})) {
  postJsonRequestMock.mockResolvedValue({ response, release });
}
function mockLines(
  lines: Parameters<typeof sseResponse>[0],
  options?: Parameters<typeof sseResponse>[1],
) {
  mockStream(sseResponse(lines, options));
}
function audioEvent(audio: { data?: string; transcript?: string }) {
  return `data: ${JSON.stringify({ choices: [{ delta: { audio } }] })}\n`;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  assertOkOrThrowHttpErrorMock.mockResolvedValue(undefined);
  postJsonRequestMock.mockReset();
  resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "openrouter-key" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("declares explicit mode capabilities", () => {
  expectExplicitMusicGenerationCapabilities(buildOpenRouterMusicGenerationProvider());
});

it("streams audio chunks into a music asset despite failed reader cleanup", async () => {
  const release = vi.fn(async () => {});
  const cancel = vi.fn(async () => {
    throw new Error("cancel failed");
  });
  const releaseLock = vi.fn();
  mockStream(
    sseResponse(
      [
        audioEvent({ transcript: "line " }),
        audioEvent({ data: audioBase64.slice(0, 5) }),
        audioEvent({ data: audioBase64.slice(5), transcript: "two" }),
        done,
      ],
      { cancel, releaseLock },
    ),
    release,
  );
  const result = await generateMusic({
    prompt: "bright soundtrack",
    instrumental: true,
    format: "wav",
  });
  expect(postRequest().url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(postRequest().body).toMatchObject({
    model: "google/lyria-3-pro-preview",
    modalities: ["text", "audio"],
    audio: { format: "wav" },
    stream: true,
  });
  expect(postRequest().body.messages).toEqual([
    {
      role: "user",
      content: "bright soundtrack\n\nInstrumental only. No vocals, no sung lyrics, no spoken word.",
    },
  ]);
  expect(result.tracks[0]?.mimeType).toBe("audio/wav");
  expect(result.tracks[0]?.buffer).toEqual(audioBytes);
  expect(result.lyrics).toEqual(["line two"]);
  expect(release).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
  expect(releaseLock).toHaveBeenCalledOnce();
});

it.each([
  { ending: "\n", terminated: true },
  { ending: "\r\n", terminated: false },
])("decodes fragmented UTF-8: $ending, terminated=$terminated", async ({ ending, terminated }) => {
  const lines = sseResponseLines(audioBase64, "café 🦞 soundtrack");
  const bytes = new TextEncoder().encode(
    lines.map((line) => line.trimEnd()).join(ending) + (terminated ? ending : ""),
  );
  mockLines(Array.from(bytes, (byte) => Uint8Array.of(byte)));
  const result = await generateMusic({ prompt: "fragmented soundtrack" });
  expect(result.tracks[0]?.buffer).toEqual(audioBytes);
  expect(result.lyrics).toEqual(["café 🦞 soundtrack"]);
});

it.each(["completed", "provider error"] as const)(
  "releases capture tees after %s without waiting for siblings",
  async (outcome) => {
    const cancel = vi.fn();
    const lines =
      outcome === "completed"
        ? sseResponseLines(audioBase64)
        : ['data: {"error":{"message":"provider disconnected"}}\n'];
    const [consumer, capture] = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(new TextEncoder().encode(line));
        }
      },
      cancel,
    }).tee();
    const release = vi.fn(async () => {
      await capture.cancel();
    });
    mockStream(new Response(consumer), release);
    const operation = generateMusic({ prompt: "capture cleanup", timeoutMs: 1000 });
    const settledOperation = operation.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
      if (outcome === "completed") {
        await expect(operation).resolves.toMatchObject({
          tracks: [{ buffer: audioBytes }],
        });
      } else {
        await expect(operation).rejects.toThrow(
          "OpenRouter music generation failed: provider disconnected",
        );
      }
      expect(release).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
      expect(consumer.locked).toBe(false);
    } finally {
      await Promise.all([capture.cancel(), ...(!consumer.locked ? [consumer.cancel()] : [])]);
      await settledOperation;
    }
  },
);

it("rejects non-canonical base64 pad bits", async () => {
  mockLines(sseResponseLines("ZE=="));
  await rejectMusic("returned malformed base64 audio data");
});

it("decodes independently padded OpenRouter audio chunks", async () => {
  mockLines([
    audioEvent({ data: Buffer.from("a").toString("base64") }),
    audioEvent({ data: Buffer.from("b").toString("base64") }),
    done,
  ]);
  const result = await generateMusic();
  expect(result.tracks[0]?.buffer).toEqual(Buffer.from("ab"));
});

it("sends reference images as multimodal message content", async () => {
  mockLines(sseResponseLines(audioBase64));
  await generateMusic({
    model: "google/lyria-3-clip-preview",
    prompt: "score this image",
    format: "mp3",
    inputImages: [{ buffer: Buffer.from("png"), mimeType: "image/png" }],
  });
  expect(postRequest().body).toMatchObject({
    model: "google/lyria-3-clip-preview",
    audio: { format: "mp3" },
  });
  expect(postRequest().body.messages).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "score this image" },
        { type: "image_url", image_url: { url: "data:image/png;base64,cG5n" } },
      ],
    },
  ]);
});

it("caps oversized OpenRouter music stream timeouts", async () => {
  mockLines([done]);
  await rejectMusic("response missing audio data", { timeoutMs: Number.MAX_SAFE_INTEGER });
  expect(postRequest().timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
});

it.each(["\n", ""])("rejects incomplete streams ending in %j", async (ending) => {
  mockLines([audioEvent({ data: Buffer.from("partial").toString("base64") }).trimEnd() + ending]);
  await rejectMusic("stream ended before completion");
});

it.each(["\n", ""])(
  "preserves errors ending in %j despite failed reader cleanup",
  async (ending) => {
    const cancel = vi.fn(async () => {
      throw new Error("cancel failed");
    });
    mockLines(
      [
        `data: {"error":{"code":"provider_error","message":"provider disconnected"},"choices":[{"delta":{},"finish_reason":"error"}]}${ending}`,
      ],
      { cancel },
    );
    await rejectMusic("failed: provider disconnected");
    expect(cancel).toHaveBeenCalledOnce();
  },
);

it.each([16 * 1024, Infinity])(
  "accepts large SSE events with %s-byte chunks",
  async (chunkBytes) => {
    const audio = Buffer.alloc(1_600_000, 0x61);
    const event = Buffer.from(audioEvent({ data: audio.toString("base64") }));
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < event.length; offset += chunkBytes) {
      chunks.push(event.subarray(offset, offset + chunkBytes));
    }
    mockLines([...chunks, done]);
    const result = await generateMusic({ cfg: mediaLimit(2 * 1024 * 1024) });
    assert.deepStrictEqual(result.tracks[0]?.buffer, audio);
  },
);

it.each(["one chunk", "fragmented", "after completion", "decoder flush"])(
  "rejects SSE events outside the media envelope: %s",
  async (boundary) => {
    const maxBytes = 8;
    const maxEventBytes = Math.ceil(maxBytes / 3) * 4 + maxBytes + 64 * 1024;
    const cancel = vi.fn();
    const oversized = new Uint8Array(maxEventBytes + 1);
    const chunks =
      boundary === "fragmented"
        ? [oversized.subarray(0, 32 * 1024), oversized.subarray(32 * 1024)]
        : boundary === "after completion"
          ? [Buffer.concat([Buffer.from("data: [DONE]\n"), oversized])]
          : boundary === "decoder flush"
            ? [Buffer.alloc(maxEventBytes - 1, 0x20), Uint8Array.of(0xe2)]
            : [oversized];
    mockLines(chunks, { cancel });
    await rejectMusic(
      `SSE event exceeded ${maxEventBytes} bytes for a ${maxBytes}-byte media limit`,
      { cfg: mediaLimit(maxBytes) },
    );
    expect(cancel).toHaveBeenCalledOnce();
  },
);

it.each([
  {
    label: "audio",
    delta: { audio: { data: Buffer.from("123456789").toString("base64") } },
  },
  { label: "transcript", delta: { audio: { transcript: "123456789" } } },
])("rejects $label beyond agents.defaults.mediaMaxMb", async ({ label, delta }) => {
  mockLines([`data: ${JSON.stringify({ choices: [{ delta }] })}\n`, done]);
  await rejectMusic(`${label} exceeded 8 bytes`, { cfg: mediaLimit(8) });
});
