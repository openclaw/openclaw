import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import {
  isProviderAuthProfileConfigured,
  isProviderAuthProfileConfiguredAsync,
} from "openclaw/plugin-sdk/provider-auth";
import { afterEach, expect, it, vi } from "vitest";

const guardedFetch = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: guardedFetch,
}));

import { buildMinimaxMusicGenerationProvider } from "./music-generation-provider.js";
import { buildMinimaxSpeechProvider } from "./speech-provider-factory.js";
import { minimaxTTS } from "./tts.js";

function tts(overrides: Partial<Parameters<typeof minimaxTTS>[0]> = {}) {
  return minimaxTTS({
    text: "hello",
    apiKey: "sk-test",
    baseUrl: "https://api.minimax.io",
    model: "speech-2.8-hd",
    voiceId: "English_expressive_narrator",
    timeoutMs: 10_000,
    ...overrides,
  });
}

function mockTtsResponse(body: unknown) {
  guardedFetch.mockResolvedValue({
    response: Response.json(body),
    release: vi.fn(async () => undefined),
  });
}

afterEach(() => {
  guardedFetch.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("caps oversized request timeout before arming abort timers", async () => {
  const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
  mockTtsResponse({ data: { audio: Buffer.from("audio").toString("hex") } });
  await expect(tts({ timeoutMs: Number.MAX_SAFE_INTEGER })).resolves.toEqual(Buffer.from("audio"));
  expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  expect(guardedFetch.mock.calls[0]?.[0]).toMatchObject({
    timeoutMs: MAX_TIMER_TIMEOUT_MS,
    init: { signal: expect.any(AbortSignal) },
  });
});

it("throws on base_resp envelope error even when data.audio is present (regression #76904)", async () => {
  mockTtsResponse({
    data: { audio: Buffer.from("placeholder").toString("hex") },
    base_resp: { status_code: 1002, status_msg: "Quota exceeded" },
  });
  await expect(tts()).rejects.toThrow("MiniMax TTS API error (1002): Quota exceeded");
});

type WireFixture = {
  entryPoint: "tts" | "speech" | "music";
  provider?: "minimax" | "minimax-portal";
  responseBody?: unknown;
  frames?: Array<{ status?: number | string; audio?: string } | "[DONE]">;
  mediaMaxMb?: number;
};

async function runFixture(fixture: WireFixture) {
  const originalFetch = globalThis.fetch;
  const release = vi.fn(async () => {});
  const music = fixture.entryPoint === "music";
  const body = music
    ? fixture.frames
        ?.map((frame) =>
          frame === "[DONE]" ? "data: [DONE]" : `data: ${JSON.stringify(successBody(frame))}`,
        )
        .join("\n\n") + "\n\n"
    : JSON.stringify(fixture.responseBody);
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": music ? "text/event-stream" : "application/json" });
    response.end(body);
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const { port } = server.address() as AddressInfo;
  vi.stubEnv("MINIMAX_API_KEY", "sk-test");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const { dispatcher: _dispatcher, ...forwardedInit } = (init ?? {}) as RequestInit & {
      dispatcher?: unknown;
    };
    return originalFetch(`http://127.0.0.1:${port}`, forwardedInit);
  });
  guardedFetch.mockImplementation(async ({ url, init }) => ({
    response: await fetch(url, init),
    release,
  }));

  try {
    if (fixture.entryPoint === "tts") {
      return await tts({ timeoutMs: 1_000 });
    }
    if (fixture.entryPoint === "speech") {
      const result = await buildMinimaxSpeechProvider({
        isProviderAuthProfileConfigured,
        isProviderAuthProfileConfiguredAsync,
      }).synthesize({
        text: "loopback fixture",
        cfg: {},
        providerConfig: { apiKey: "sk-test" },
        target: "audio-file",
        timeoutMs: 1_000,
      });
      return result.audioBuffer;
    }

    const providerId = fixture.provider ?? "minimax";
    const result = await buildMinimaxMusicGenerationProvider(providerId).generateMusic({
      provider: providerId,
      model: "music-2.6",
      prompt: "loopback fixture",
      cfg: { agents: { defaults: { mediaMaxMb: fixture.mediaMaxMb } } },
    });
    return result.tracks[0]?.buffer;
  } finally {
    await promisify(server.close.bind(server))();
    if (!music) {
      expect(release).toHaveBeenCalledOnce();
    }
  }
}

function successBody(data: unknown) {
  return { data, base_resp: { status_code: 0, status_msg: "success" } };
}

it.each([
  ["null envelope", null, "minimax.tts: malformed JSON response"],
  ["numeric audio", { data: { audio: 42 } }, "MiniMax TTS API returned no audio data"],
  [
    "nonstring error message",
    {
      data: { audio: "706c616365686f6c646572" },
      base_resp: { status_code: 1002, status_msg: {} },
    },
    "MiniMax TTS API error (1002): unknown error",
  ],
] as const)("reports %s through the speech provider", async (_name, responseBody, error) => {
  await expect(runFixture({ entryPoint: "speech", responseBody })).rejects.toThrow(error);
});

it("rejects odd-length hex TTS audio without truncating it", async () => {
  await expect(
    runFixture({ entryPoint: "tts", responseBody: successBody({ audio: "666f6" }) }),
  ).rejects.toThrow("MiniMax TTS API returned malformed hex audio");
});

it.each([
  ["minimax", false],
  ["minimax-portal", true],
] as const)(
  "rejects incomplete %s music after its HTTP stream closes (DONE: %s)",
  async (provider, done) => {
    const frames: WireFixture["frames"] = [
      { status: 1, audio: Buffer.from("partial-audio").toString("hex") },
      ...(done ? (["[DONE]"] as const) : []),
    ];
    await expect(runFixture({ entryPoint: "music", provider, frames })).rejects.toThrow(
      "MiniMax music generation stream ended without completion",
    );
  },
);

it.each([
  ["2", "complete-audio", undefined],
  [2, "oversized", 0.000_001],
] as const)(
  "validates terminal status %s for %s (music limit: %s)",
  async (status, text, mediaMaxMb) => {
    const audio = Buffer.from(text);
    const result = runFixture({
      entryPoint: "music",
      frames: [{ status, audio: audio.toString("hex") }],
      mediaMaxMb,
    });
    if (mediaMaxMb === undefined) {
      await expect(result).resolves.toEqual(audio);
    } else {
      await expect(result).rejects.toThrow("MiniMax generated music download exceeds 1 bytes");
    }
  },
);
