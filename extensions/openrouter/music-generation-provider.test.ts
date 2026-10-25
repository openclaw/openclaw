import assert from "node:assert/strict";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  requireFirstPostJsonRecordRequest,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { expectExplicitMusicGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenRouterMusicGenerationProvider } from "./music-generation-provider.js";

const {
  assertOkOrThrowHttpErrorMock,
  postJsonRequestMock,
  resolveApiKeyForProviderMock,
  resolveProviderHttpRequestConfigMock,
} = getProviderHttpMocks();

installProviderHttpMockCleanup();

function sseResponse(
  lines: Array<string | Uint8Array>,
  options?: { cancel?: () => void | Promise<void>; releaseLock?: () => void },
): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const line = lines[index++];
        if (line === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(typeof line === "string" ? encoder.encode(line) : line);
      },
    }),
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

function sseResponseLines(params: { audio: string; transcript?: string }): string[] {
  return [
    audioEvent({
      data: params.audio,
      ...(params.transcript ? { transcript: params.transcript } : {}),
    }),
    "data: [DONE]\n",
  ];
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

function audioEvent(audio: { data?: string; transcript?: string }) {
  return `data: ${JSON.stringify({ choices: [{ delta: { audio } }] })}\n`;
}

function audioStream(audio: string, options?: Parameters<typeof sseResponse>[1]) {
  return sseResponse(sseResponseLines({ audio: Buffer.from(audio).toString("base64") }), options);
}

function resetOpenRouterMusicMocks() {
  assertOkOrThrowHttpErrorMock.mockResolvedValue(undefined);
  postJsonRequestMock.mockReset();
  resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "openrouter-key" });
  resolveProviderHttpRequestConfigMock.mockImplementation((params) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
    dispatcherPolicy: undefined,
  }));
}

describe("openrouter music generation provider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetOpenRouterMusicMocks();
  });

  afterEach(() => {
    resetOpenRouterMusicMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("declares explicit mode capabilities", () => {
    expectExplicitMusicGenerationCapabilities(buildOpenRouterMusicGenerationProvider());
  });

  it("streams OpenRouter audio chunks into a generated music asset", async () => {
    const release = vi.fn(async () => {});
    const audioBase64 = Buffer.from("wav-bytes").toString("base64");
    mockStream(
      sseResponse([
        audioEvent({ transcript: "line " }),
        audioEvent({ data: audioBase64.slice(0, 5) }),
        audioEvent({ data: audioBase64.slice(5), transcript: "two" }),
        "data: [DONE]\n",
      ]),
      release,
    );

    const result = await generateMusic({
      prompt: "bright soundtrack",
      instrumental: true,
      format: "wav",
    });

    expect(postRequest().url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(postRequest().body).toEqual({
      model: "google/lyria-3-pro-preview",
      messages: [
        {
          role: "user",
          content:
            "bright soundtrack\n\nInstrumental only. No vocals, no sung lyrics, no spoken word.",
        },
      ],
      modalities: ["text", "audio"],
      audio: { format: "wav" },
      stream: true,
    });
    expect(result.tracks[0]?.mimeType).toBe("audio/wav");
    expect(result.tracks[0]?.buffer).toEqual(Buffer.from("wav-bytes"));
    expect(result.lyrics).toEqual(["line two"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    { ending: "\n", terminated: true },
    { ending: "\r\n", terminated: false },
  ])(
    "preserves fragmented UTF-8 lines with $ending and terminated=$terminated",
    async ({ ending, terminated }) => {
      const lines = sseResponseLines({
        audio: Buffer.from("wav-bytes").toString("base64"),
        transcript: "café 🦞 soundtrack",
      });
      const bytes = new TextEncoder().encode(
        lines.map((line) => line.trimEnd()).join(ending) + (terminated ? ending : ""),
      );
      mockStream(sseResponse(Array.from(bytes, (byte) => Uint8Array.of(byte))));

      const result = await generateMusic({ prompt: "fragmented soundtrack" });

      expect(result.tracks[0]?.buffer).toEqual(Buffer.from("wav-bytes"));
      expect(result.lyrics).toEqual(["café 🦞 soundtrack"]);
    },
  );

  it("preserves completed OpenRouter audio when reader cleanup fails", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("cancel failed");
    });
    const releaseLock = vi.fn();
    mockStream(audioStream("wav-bytes", { cancel, releaseLock }));

    await expect(generateMusic()).resolves.toMatchObject({
      tracks: [{ mimeType: "audio/wav" }],
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it.each(["completed", "provider error"] as const)(
    "releases a capture tee after %s without waiting for its sibling",
    async (outcome) => {
      const cancel = vi.fn();
      const lines =
        outcome === "completed"
          ? sseResponseLines({ audio: Buffer.from("wav-bytes").toString("base64") })
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
            tracks: [{ buffer: Buffer.from("wav-bytes") }],
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

  it("rejects streamed audio with non-canonical base64 pad bits", async () => {
    mockStream(sseResponse(sseResponseLines({ audio: "ZE==" })));

    await rejectMusic("returned malformed base64 audio data");
  });

  it("decodes independently padded OpenRouter audio chunks", async () => {
    mockStream(
      sseResponse([
        audioEvent({ data: Buffer.from("a").toString("base64") }),
        audioEvent({ data: Buffer.from("b").toString("base64") }),
        "data: [DONE]\n",
      ]),
    );
    const result = await generateMusic();

    expect(result.tracks[0]?.buffer).toEqual(Buffer.from("ab"));
  });

  it("sends reference images as multimodal message content", async () => {
    mockStream(audioStream("mp3"));

    await generateMusic({
      model: "google/lyria-3-clip-preview",
      prompt: "score this image",
      format: "mp3",
      inputImages: [{ buffer: Buffer.from("png"), mimeType: "image/png" }],
    });

    expect(postRequest().body).toEqual(
      expect.objectContaining({
        model: "google/lyria-3-clip-preview",
        audio: { format: "mp3" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "score this image" },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${Buffer.from("png").toString("base64")}`,
                },
              },
            ],
          },
        ],
      }),
    );
  });

  it("caps oversized OpenRouter music stream timeouts", async () => {
    mockStream(sseResponse(["data: [DONE]\n"]));

    await rejectMusic("response missing audio data", { timeoutMs: Number.MAX_SAFE_INTEGER });

    expect(postRequest().timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it.each(["\n", ""])(
    "rejects OpenRouter streams that end before completion with ending %j",
    async (ending) => {
      mockStream(
        sseResponse([
          audioEvent({ data: Buffer.from("partial").toString("base64") }).trimEnd() + ending,
        ]),
      );

      await rejectMusic("stream ended before completion");
    },
  );

  it.each(["\n", ""])(
    "preserves OpenRouter errors with ending %j when reader cleanup fails",
    async (ending) => {
      const cancel = vi.fn(async () => {
        throw new Error("cancel failed");
      });
      mockStream(
        sseResponse(
          [
            `data: ${JSON.stringify({
              error: { code: "provider_error", message: "provider disconnected" },
              choices: [{ delta: {}, finish_reason: "error" }],
            })}${ending}`,
          ],
          { cancel },
        ),
      );

      await rejectMusic("failed: provider disconnected");
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each([16 * 1024, Infinity])(
    "accepts valid SSE events above two megabytes with %s-byte transport chunks",
    async (chunkBytes) => {
      const audio = Buffer.alloc(1_600_000, 0x61);
      const event = Buffer.from(audioEvent({ data: audio.toString("base64") }));
      const chunks: Uint8Array[] = [];
      for (let offset = 0; offset < event.length; offset += chunkBytes) {
        chunks.push(event.subarray(offset, offset + chunkBytes));
      }
      mockStream(sseResponse([...chunks, "data: [DONE]\n"]));

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
      mockStream(sseResponse(chunks, { cancel }));

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
    mockStream(
      sseResponse([`data: ${JSON.stringify({ choices: [{ delta }] })}\n`, "data: [DONE]\n"]),
    );

    await rejectMusic(`${label} exceeded 8 bytes`, { cfg: mediaLimit(8) });
  });
});
