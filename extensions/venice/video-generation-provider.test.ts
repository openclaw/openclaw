import { describe, expect, it } from "vitest";
import { buildVeniceVideoGenerationProvider } from "./video-generation-provider.js";

describe("Venice video generation provider", () => {
  const provider = buildVeniceVideoGenerationProvider();

  it("has expected id and aliases", () => {
    expect(provider.id).toBe("venice");
    expect(provider.aliases).toContain("veniceai");
  });

  it("has a default model", () => {
    expect(provider.defaultModel).toBe("wan-2.7-image-to-video");
  });

  it("lists WAN models", () => {
    expect(provider.models).toContain("wan-2.7-image-to-video");
    expect(provider.models).toContain("wan-2.7-text-to-video");
    expect(provider.models).toContain("wan-2.6-image-to-video");
    expect(provider.models).toContain("wan-2.5-preview-image-to-video");
  });

  it("lists Kling models", () => {
    expect(provider.models).toContain("kling-2.6-pro-image-to-video");
    expect(provider.models).toContain("kling-2.6-pro-text-to-video");
    expect(provider.models).toContain("kling-2.5-turbo-pro-image-to-video");
    expect(provider.models).toContain("kling-2.5-turbo-pro-text-to-video");
  });

  it("lists Seedance models", () => {
    expect(provider.models).toContain("seedance-2-0-image-to-video");
    expect(provider.models).toContain("seedance-2-0-text-to-video");
    expect(provider.models).toContain("seedance-1-5-pro-image-to-video");
    expect(provider.models).toContain("seedance-1-5-pro-text-to-video");
  });

  it("lists Vidu and OVI models", () => {
    expect(provider.models).toContain("vidu-q3-image-to-video");
    expect(provider.models).toContain("vidu-q3-text-to-video");
    expect(provider.models).toContain("ovi-image-to-video");
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
