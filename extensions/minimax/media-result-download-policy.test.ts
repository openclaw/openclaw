import type { OpenClawConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, expect, it, vi } from "vitest";
import { buildMinimaxMusicGenerationProvider } from "./music-generation-provider.js";
import { buildMinimaxVideoGenerationProvider } from "./video-generation-provider.js";

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: async () => ({ apiKey: "synthetic-minimax-key" }),
}));

afterEach(() => vi.restoreAllMocks());

// A private relay is trusted for the task API; result URLs come from its responses.
const relay = "https://127.0.0.1:9";
const href = (input: string | URL | Request) => (input instanceof Request ? input.url : `${input}`);

function generate(kind: "video" | "music", resultUrl: string, request = {}) {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (href(input) === "http://93.184.216.34/redirect.mp4") {
      return new Response(null, { status: 302, headers: { location: `${relay}/x.mp4` } });
    }
    if (href(input) === resultUrl) {
      return new Response("media", {
        headers: { "content-type": kind === "video" ? "video/mp4" : "audio/mpeg" },
      });
    }
    const result = kind === "video" ? { video_url: resultUrl } : { audio_url: resultUrl };
    return Response.json({
      task_id: "t",
      status: "Success",
      base_resp: { status_code: 0 },
      ...result,
    });
  });
  const minimax = {
    baseUrl: relay,
    models: [],
    request: { allowPrivateNetwork: true, ...request },
  };
  const cfg = { models: { providers: { minimax } } } as OpenClawConfig;
  const run =
    kind === "video"
      ? buildMinimaxVideoGenerationProvider().generateVideo({
          provider: "minimax",
          model: "MiniMax-Hailuo-2.3",
          prompt: "p",
          cfg,
        })
      : buildMinimaxMusicGenerationProvider().generateMusic({
          provider: "minimax",
          model: "music-2.6",
          prompt: "p",
          cfg,
        });
  return { run, urls: () => fetchMock.mock.calls.map(([input]) => href(input)) };
}

it.each([
  ["video", "https://127.0.0.1:9/video.mp4", "https://127.0.0.1:9/video.mp4"],
  ["video", "http://10.0.0.1/video.mp4", "http://10.0.0.1/video.mp4"],
  ["music", "http://10.0.0.1/track.mp3", "http://10.0.0.1/track.mp3"],
  ["video", "http://93.184.216.34/redirect.mp4", `${relay}/x.mp4`],
] as const)(
  "blocks %s result %s although the MiniMax relay is trusted",
  async (kind, url, target) => {
    const { run, urls } = generate(kind, url);
    await expect(run).rejects.toMatchObject({ name: "SsrFBlockedError" });
    expect(urls()).not.toContain(target);
  },
);

it.each([
  ["directly", {}],
  [
    "through a private configured proxy",
    { proxy: { mode: "explicit-proxy", url: "http://127.0.0.1:3128" } },
  ],
])("downloads a public video result %s", async (_, request) => {
  const { run } = generate("video", "https://93.184.216.34/video.mp4", request);
  await expect(run).resolves.toMatchObject({ videos: [{ buffer: Buffer.from("media") }] });
});
