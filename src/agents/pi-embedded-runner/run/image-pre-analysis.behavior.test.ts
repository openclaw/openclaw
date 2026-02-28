import type { ImageContent } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  runWithImageModelFallbackMock,
  ensureOpenClawModelsJsonMock,
  discoverAuthStorageMock,
  discoverModelsMock,
} = vi.hoisted(() => ({
  runWithImageModelFallbackMock: vi.fn(),
  ensureOpenClawModelsJsonMock: vi.fn(),
  discoverAuthStorageMock: vi.fn(),
  discoverModelsMock: vi.fn(),
}));

vi.mock("../../model-fallback.js", () => ({
  runWithImageModelFallback: runWithImageModelFallbackMock,
}));

vi.mock("../../models-config.js", () => ({
  ensureOpenClawModelsJson: ensureOpenClawModelsJsonMock,
}));

vi.mock("../../pi-model-discovery.js", () => ({
  discoverAuthStorage: discoverAuthStorageMock,
  discoverModels: discoverModelsMock,
}));

import { analyzeImagesWithImageModel } from "./image-pre-analysis.js";

const TEST_IMAGES: ImageContent[] = [
  {
    type: "image",
    data: "aW1hZ2UtMQ==",
    mimeType: "image/png",
  },
  {
    type: "image",
    data: "aW1hZ2UtMg==",
    mimeType: "image/jpeg",
  },
];

describe("analyzeImagesWithImageModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureOpenClawModelsJsonMock.mockResolvedValue(undefined);
    discoverAuthStorageMock.mockReturnValue({
      setRuntimeApiKey: vi.fn(),
    });
    discoverModelsMock.mockReturnValue({
      find: vi.fn(),
    });
  });

  it("reports zero successful analyses when all image-model attempts fail", async () => {
    runWithImageModelFallbackMock.mockRejectedValue(new Error("vision unavailable"));

    const result = await analyzeImagesWithImageModel({
      images: TEST_IMAGES,
      config: {
        agents: {
          defaults: {
            imageModel: {
              primary: "openai/gpt-4o",
            },
          },
        },
      },
      agentDir: "/tmp/agent",
      userPrompt: "what is in these images?",
    });

    expect(result.imageCount).toBe(2);
    expect(result.successfulImageCount).toBe(0);
    expect(result.provider).toBe("");
    expect(result.model).toBe("");
    expect(result.analysisText).toContain("(Image analysis failed.)");
    expect(runWithImageModelFallbackMock).toHaveBeenCalledTimes(2);
  });

  it("tracks successful analyses when some images are analyzed successfully", async () => {
    runWithImageModelFallbackMock
      .mockResolvedValueOnce({
        result: { text: "A cat on a sofa.", provider: "openai", model: "gpt-4o" },
      })
      .mockRejectedValueOnce(new Error("second image failed"));

    const result = await analyzeImagesWithImageModel({
      images: TEST_IMAGES,
      config: {
        agents: {
          defaults: {
            imageModel: {
              primary: "openai/gpt-4o",
            },
          },
        },
      },
      agentDir: "/tmp/agent",
    });

    expect(result.imageCount).toBe(2);
    expect(result.successfulImageCount).toBe(1);
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4o");
    expect(result.analysisText).toContain("[Image 1 Analysis]");
    expect(result.analysisText).toContain("[Image 2]");
  });
});
