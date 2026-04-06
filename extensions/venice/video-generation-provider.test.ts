import { describe, expect, it } from "vitest";
import { buildVeniceVideoGenerationProvider } from "./video-generation-provider.js";

describe("Venice video generation provider", () => {
  const provider = buildVeniceVideoGenerationProvider();

  it("has expected id and aliases", () => {
    expect(provider.id).toBe("venice");
    expect(provider.aliases).toContain("veniceai");
  });

  it("has a default model", () => {
    expect(provider.defaultModel).toBe("wan-2.5-preview-image-to-video");
  });

  it("lists expected image-to-video models", () => {
    expect(provider.models).toContain("wan-2.5-preview-image-to-video");
    expect(provider.models).toContain("wan-2.6-720p-image-to-video");
    expect(provider.models).toContain("wan-2.6-1080p-image-to-video");
    expect(provider.models).toContain("kling-2.1-master-image-to-video");
    expect(provider.models).toContain("kling-2.1-pro-image-to-video");
    expect(provider.models).toContain("hunyuan-image-to-video");
    expect(provider.models).toContain("minimax-image-to-video");
    expect(provider.models).toContain("luma-ray-2-image-to-video");
    expect(provider.models).toContain("seedance-1-image-to-video");
    expect(provider.models).toContain("vidu-2-image-to-video");
  });

  it("lists expected text-to-video models", () => {
    expect(provider.models).toContain("kling-2.1-master-text-to-video");
    expect(provider.models).toContain("kling-2.1-pro-text-to-video");
    expect(provider.models).toContain("minimax-text-to-video");
    expect(provider.models).toContain("luma-ray-2-text-to-video");
    expect(provider.models).toContain("seedance-1-text-to-video");
    expect(provider.models).toContain("vidu-2-text-to-video");
  });

  it("lists video upscale models", () => {
    expect(provider.models).toContain("video-upscale-topaz");
    expect(provider.models).toContain("video-upscale-standard");
  });

  it("has expected capabilities", () => {
    expect(provider.capabilities.maxVideos).toBe(1);
    expect(provider.capabilities.maxInputImages).toBe(1);
    expect(provider.capabilities.maxInputVideos).toBe(1);
    expect(provider.capabilities.maxDurationSeconds).toBe(10);
    expect(provider.capabilities.supportedDurationSeconds).toEqual([5, 10]);
    expect(provider.capabilities.supportsResolution).toBe(true);
    expect(provider.capabilities.supportsAspectRatio).toBe(true);
    expect(provider.capabilities.supportsAudio).toBe(true);
  });

  it("has isConfigured function", () => {
    expect(typeof provider.isConfigured).toBe("function");
  });

  it("has generateVideo function", () => {
    expect(typeof provider.generateVideo).toBe("function");
  });
});
