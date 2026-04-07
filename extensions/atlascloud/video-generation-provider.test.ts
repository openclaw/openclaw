// Offline unit tests for the Atlas Cloud schema-driven body builder.
// No HTTP traffic, no API key, no fixtures. These guard the per-model field
// mapping that turns generic OpenClaw video generation requests into the
// per-family request bodies that Atlas Cloud actually expects.
import { describe, expect, it } from "vitest";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { buildAtlasCloudVideoBody } from "./video-generation-provider.js";

function makeReq(overrides: Partial<VideoGenerationRequest> = {}): VideoGenerationRequest {
  return {
    provider: "atlascloud",
    model: "google/veo3.1/text-to-video",
    prompt: "a calm sunrise over mountains",
    cfg: {} as VideoGenerationRequest["cfg"],
    ...overrides,
  };
}

describe("buildAtlasCloudVideoBody", () => {
  it("uses Veo field names for google/veo3.1/text-to-video", () => {
    const body = buildAtlasCloudVideoBody(
      makeReq({ aspectRatio: "16:9", durationSeconds: 6, audio: true }),
    );
    expect(body).toMatchObject({
      model: "google/veo3.1/text-to-video",
      prompt: "a calm sunrise over mountains",
      aspect_ratio: "16:9",
      duration: 6,
      generate_audio: true,
    });
  });

  it("uses Kling 'sound' instead of 'generate_audio'", () => {
    const body = buildAtlasCloudVideoBody(
      makeReq({
        model: "kwaivgi/kling-v3.0-pro/text-to-video",
        audio: false,
        durationSeconds: 5,
      }),
    );
    expect(body.sound).toBe(false);
    expect(body).not.toHaveProperty("generate_audio");
  });

  it("uses Wan 2.7 'ratio' field and uppercase resolution", () => {
    const body = buildAtlasCloudVideoBody(
      makeReq({
        model: "alibaba/wan-2.7/text-to-video",
        aspectRatio: "9:16",
        resolution: "1080P",
      }),
    );
    expect(body.ratio).toBe("9:16");
    expect(body.resolution).toBe("1080P");
    expect(body).not.toHaveProperty("aspect_ratio");
  });

  it("converts size separator from 'x' to '*' for Wan 2.6", () => {
    const body = buildAtlasCloudVideoBody(
      makeReq({ model: "alibaba/wan-2.6/text-to-video", size: "1280x720" }),
    );
    expect(body.size).toBe("1280*720");
  });

  it("packs Vidu reference-to-video images into an 'images' array", () => {
    const body = buildAtlasCloudVideoBody(
      makeReq({
        model: "vidu/q3/reference-to-video",
        inputImages: [
          { url: "https://example.com/a.png" },
          { url: "https://example.com/b.png" },
        ],
      }),
    );
    expect(body.images).toEqual(["https://example.com/a.png", "https://example.com/b.png"]);
  });

  it("uses Veo 'last_image' for the second image (end frame)", () => {
    const body = buildAtlasCloudVideoBody(
      makeReq({
        model: "google/veo3.1/image-to-video",
        inputImages: [
          { url: "https://example.com/start.png" },
          { url: "https://example.com/end.png" },
        ],
      }),
    );
    expect(body.image).toBe("https://example.com/start.png");
    expect(body.last_image).toBe("https://example.com/end.png");
  });

  it("uses Kling 'end_image' for the second image (end frame)", () => {
    const body = buildAtlasCloudVideoBody(
      makeReq({
        model: "kwaivgi/kling-v3.0-pro/image-to-video",
        inputImages: [
          { url: "https://example.com/start.png" },
          { url: "https://example.com/end.png" },
        ],
      }),
    );
    expect(body.image).toBe("https://example.com/start.png");
    expect(body.end_image).toBe("https://example.com/end.png");
    expect(body).not.toHaveProperty("last_image");
  });

  it("rejects unsupported aspect_ratio against Veo's option list", () => {
    expect(() =>
      buildAtlasCloudVideoBody(
        makeReq({ model: "google/veo3.1/text-to-video", aspectRatio: "3:4" }),
      ),
    ).toThrow(/does not support aspect_ratio/);
  });

  it("requires inputImages for image-to-video models", () => {
    expect(() =>
      buildAtlasCloudVideoBody(makeReq({ model: "google/veo3.1/image-to-video" })),
    ).toThrow(/requires inputImages/);
  });

  it("requires inputVideos for video-to-video models", () => {
    expect(() =>
      buildAtlasCloudVideoBody(
        makeReq({ model: "alibaba/wan-2.6/video-to-video", prompt: "x" }),
      ),
    ).toThrow(/requires inputVideos/);
  });

  it("packs Wan 2.6 v2v inputVideos into a 'videos' array", () => {
    const body = buildAtlasCloudVideoBody(
      makeReq({
        model: "alibaba/wan-2.6/video-to-video",
        inputVideos: [{ url: "https://example.com/ref.mp4" }],
      }),
    );
    expect(body.videos).toEqual(["https://example.com/ref.mp4"]);
  });

  it("merges per-model defaults from the schema table", () => {
    const body = buildAtlasCloudVideoBody(
      makeReq({ model: "alibaba/wan-2.7/text-to-video" }),
    );
    // Wan 2.7 schema defaults: prompt_extend, seed, ratio, resolution, duration
    expect(body).toMatchObject({
      prompt_extend: true,
      seed: -1,
      ratio: "16:9",
      resolution: "1080P",
      duration: 5,
    });
  });

  it("user extraParams override per-model defaults (exact + prefix)", () => {
    const body = buildAtlasCloudVideoBody(
      makeReq({
        model: "kwaivgi/kling-v3.0-pro/text-to-video",
        cfg: {
          models: {
            providers: {
              atlascloud: {
                extraParams: {
                  "kwaivgi/kling-v3.0-pro/": { cfg_scale: 0.7 },
                  "kwaivgi/kling-v3.0-pro/text-to-video": { seed: 42 },
                },
              },
            },
          },
        } as VideoGenerationRequest["cfg"],
      }),
    );
    expect(body.cfg_scale).toBe(0.7);
    expect(body.seed).toBe(42);
  });

  it("falls back to family baseline for unregistered model ids", () => {
    const body = buildAtlasCloudVideoBody(
      makeReq({
        // not in MODEL_OVERRIDES; should hit minimax-hailuo baseline
        model: "minimax/hailuo-99/text-to-video",
        durationSeconds: 5,
      }),
    );
    expect(body.model).toBe("minimax/hailuo-99/text-to-video");
    expect(body.prompt).toBe("a calm sunrise over mountains");
    // hailuo baseline has empty fields {} so no aspect_ratio mapping
    expect(body).not.toHaveProperty("aspect_ratio");
    // hailuo baseline default
    expect(body.enable_prompt_expansion).toBe(true);
  });
});
