import { jsonResponse as json } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const cfg = buildComfyConfig({
  mode: "cloud",
  apiKey: "comfy-test-key",
  timeoutMs: 9_000,
  workflow: { "6": { inputs: { text: "" } }, "7": { inputs: { image: "" } } },
  promptNodeId: "6",
  inputImageNodeId: "7",
});

function generate(capability: "image" | "music" | "video") {
  const req = {
    cfg,
    provider: "comfy",
    model: "workflow",
    prompt: "a lobster",
    timeoutMs: 100,
    inputImages: [{ buffer: Buffer.from("image"), mimeType: "image/png" }],
  };
  if (capability === "image") {
    return providers.image.generateImage(req);
  }
  if (capability === "music") {
    return providers.music.generateMusic(req);
  }
  return providers.video.generateVideo(req);
}

describe("Comfy workflow deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    fetchMock.mockReset();
    release.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["image", "music", "video"] as const)(
    "shares the caller's budget across the complete %s workflow",
    async (capability) => {
      const kind = capability === "music" ? "audio" : capability === "video" ? "videos" : "images";
      const filename =
        capability === "music" ? "song.mp3" : capability === "video" ? "clip.mp4" : "image.png";
      const contentType =
        capability === "music" ? "audio/mpeg" : capability === "video" ? "video/mp4" : "image/png";
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
      const result = generate(capability).catch((error: unknown) => error);
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
      let result: unknown;
      void generate("image").then(
        (value) => {
          result = value;
        },
        (error: unknown) => {
          result = error;
        },
      );
      await vi.advanceTimersByTimeAsync(101);
      expect(result).toMatchObject({ message: "Comfy workflow did not finish within 1s" });
      expect(cancelled).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    },
  );
});
