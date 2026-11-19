import { jsonResponse as json } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildComfyConfig, registerComfyProviders } from "./test-helpers.js";

const { fetchMock, release } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  release: vi.fn(async () => {}),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchMock,
}));

const providers = registerComfyProviders();
const request = {
  cfg: buildComfyConfig({
    mode: "cloud",
    apiKey: "comfy-test-key",
    timeoutMs: 9_000,
    workflow: { "6": { inputs: { text: "" } }, "7": { inputs: { image: "" } } },
    promptNodeId: "6",
    inputImageNodeId: "7",
  }),
  provider: "comfy",
  model: "workflow",
  prompt: "a lobster",
  timeoutMs: 100,
  inputImages: [{ buffer: Buffer.from("image"), mimeType: "image/png" }],
};
const generate = {
  image: () => providers.image.generateImage(request),
  music: () => providers.music.generateMusic(request),
  video: () => providers.video.generateVideo(request),
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  fetchMock.mockReset();
  release.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

it.each([
  ["image", "images", "image.png", "image/png"],
  ["music", "audio", "song.mp3", "audio/mpeg"],
  ["video", "videos", "clip.mp4", "video/mp4"],
] as const)(
  "shares the caller's budget across the complete %s workflow",
  async (capability, kind, filename, contentType) => {
    const responses = [
      json({ name: "input.png" }),
      json({ prompt_id: "job" }),
      json({ status: "completed" }),
      json({ job: { outputs: { "9": { [kind]: [{ filename }, { filename }] } } } }),
      new Response("first", { headers: { "content-type": contentType } }),
      new Response("second", { headers: { "content-type": contentType } }),
    ];
    fetchMock.mockImplementation(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      return { response: responses.shift(), release };
    });
    const result = generate[capability]().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(150);
    expect(await result).toMatchObject({ message: "Comfy workflow did not finish within 1s" });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(release).toHaveBeenCalledTimes(5);
  },
);

it.each([200, 503])(
  "bounds a stalled HTTP %s response body by the remaining budget",
  async (status) => {
    const cancelled = vi.fn();
    fetchMock.mockResolvedValue({
      response: new Response(new ReadableStream({ cancel: cancelled }), { status }),
      release,
    });
    const result = generate.image().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toMatchObject({ message: "Comfy workflow did not finish within 1s" });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  },
);
