import { describe, expect, it } from "vitest";
import { synthesizeMediaGenerationCatalogEntries } from "./catalog.js";

describe("media-generation catalog", () => {
  it("synthesizes unique static rows with a trimmed default model", () => {
    const capabilities = { generate: { enabled: true } };

    const rows = synthesizeMediaGenerationCatalogEntries({
      kind: "image_generation",
      provider: {
        id: "example",
        label: "Example",
        defaultModel: " default-image ",
        models: ["default-image", "alternate-image", "  ", "alternate-image"],
        capabilities,
      },
    });

    const metadata = {
      kind: "image_generation",
      provider: "example",
      label: "Example",
      source: "static",
      capabilities,
    };
    expect(rows).toEqual([
      { ...metadata, model: "default-image", default: true },
      { ...metadata, model: "alternate-image" },
    ]);
  });

  it("uses per-model capabilities and modes when provided", () => {
    type VideoCapabilities = {
      generate?: { maxVideos: number };
      imageToVideo?: { enabled: boolean; maxInputImages: number };
    };
    const providerCapabilities: VideoCapabilities = {
      generate: { maxVideos: 1 },
    };
    const alternateCapabilities: VideoCapabilities = {
      imageToVideo: { enabled: true, maxInputImages: 1 },
    };

    const rows = synthesizeMediaGenerationCatalogEntries({
      kind: "video_generation",
      provider: {
        id: "example",
        defaultModel: "default-video",
        models: ["default-video", "image-video"],
        capabilities: providerCapabilities,
        catalogByModel: {
          "image-video": {
            capabilities: alternateCapabilities,
            modes: ["imageToVideo"],
          },
        },
      },
      modes: ["generate"],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        model: "default-video",
        capabilities: providerCapabilities,
        modes: ["generate"],
      }),
      expect.objectContaining({
        model: "image-video",
        capabilities: alternateCapabilities,
        modes: ["imageToVideo"],
      }),
    ]);
  });
});
