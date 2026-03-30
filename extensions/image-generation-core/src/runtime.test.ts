import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks — must use vi.hoisted so they are available before
// the actual module import is evaluated.
// ---------------------------------------------------------------------------

const {
  mockGetImageGenerationProvider,
  mockParseImageGenerationModelRef,
  mockListImageGenerationProviders,
  mockResolveAgentModelPrimaryValue,
  mockResolveAgentModelFallbackValues,
  mockIsFailoverError,
  mockDescribeFailoverError,
  mockLog,
} = vi.hoisted(() => ({
  mockGetImageGenerationProvider: vi.fn(),
  mockParseImageGenerationModelRef: vi.fn(),
  mockListImageGenerationProviders: vi.fn(),
  mockResolveAgentModelPrimaryValue: vi.fn((v: unknown) => v),
  mockResolveAgentModelFallbackValues: vi.fn(),
  mockIsFailoverError: vi.fn(() => false),
  mockDescribeFailoverError: vi.fn(),
  mockLog: { debug: vi.fn() },
}));

vi.mock("../api.js", () => ({
  createSubsystemLogger: vi.fn(() => mockLog),
  getImageGenerationProvider: mockGetImageGenerationProvider,
  getProviderEnvVars: vi.fn(() => []),
  isFailoverError: mockIsFailoverError,
  describeFailoverError: mockDescribeFailoverError,
  listImageGenerationProviders: mockListImageGenerationProviders,
  parseImageGenerationModelRef: mockParseImageGenerationModelRef,
  resolveAgentModelFallbackValues: mockResolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue: mockResolveAgentModelPrimaryValue,
}));

import { generateImage, listRuntimeImageGenerationProviders } from "./runtime.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSuccessProvider(overrides?: Partial<{ model: string }>) {
  return {
    generateImage: vi.fn(async () => ({
      images: [
        {
          buffer: Buffer.from("png-data"),
          mimeType: "image/png",
          fileName: "image-1.png",
        },
      ],
      model: overrides?.model ?? "dall-e-3",
    })),
  };
}

// ---------------------------------------------------------------------------
// generateImage
// ---------------------------------------------------------------------------

describe("generateImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFailoverError.mockReturnValue(false);
    mockListImageGenerationProviders.mockReturnValue([]);
    mockResolveAgentModelFallbackValues.mockReturnValue([]);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("throws when no model is configured (no candidates)", async () => {
    // No modelOverride, no config → parseImageGenerationModelRef always returns null
    mockParseImageGenerationModelRef.mockReturnValue(null);
    mockResolveAgentModelPrimaryValue.mockReturnValue(undefined);

    await expect(generateImage({ cfg: {}, prompt: "draw a cat" })).rejects.toThrow(
      /No image-generation model configured/,
    );
  });

  it("error message includes provider/model suggestion when providers are registered", async () => {
    mockParseImageGenerationModelRef.mockReturnValue(null);
    mockResolveAgentModelPrimaryValue.mockReturnValue(undefined);
    mockListImageGenerationProviders.mockReturnValue([{ id: "openai", defaultModel: "dall-e-3" }]);

    await expect(generateImage({ cfg: {}, prompt: "draw a cat" })).rejects.toThrow(
      /openai\/dall-e-3/,
    );
  });

  it("throws when the provider is not registered in the registry", async () => {
    mockParseImageGenerationModelRef.mockReturnValue({ provider: "unknown", model: "v1" });
    mockGetImageGenerationProvider.mockReturnValue(undefined);

    await expect(
      generateImage({ cfg: {}, prompt: "draw a cat", modelOverride: "unknown/v1" }),
    ).rejects.toThrow(/No image-generation provider registered for unknown/);
  });

  it("throws when the provider returns an empty images array", async () => {
    mockParseImageGenerationModelRef.mockReturnValue({ provider: "openai", model: "dall-e-3" });
    mockGetImageGenerationProvider.mockReturnValue({
      generateImage: vi.fn(async () => ({ images: [], model: "dall-e-3" })),
    });

    await expect(
      generateImage({ cfg: {}, prompt: "draw a cat", modelOverride: "openai/dall-e-3" }),
    ).rejects.toThrow("Image generation provider returned no images.");
  });

  it("returns the generated images on success", async () => {
    mockParseImageGenerationModelRef.mockReturnValue({ provider: "openai", model: "dall-e-3" });
    const provider = makeSuccessProvider();
    mockGetImageGenerationProvider.mockReturnValue(provider);

    const result = await generateImage({
      cfg: {},
      prompt: "draw a cat",
      modelOverride: "openai/dall-e-3",
    });

    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      buffer: Buffer.from("png-data"),
      mimeType: "image/png",
    });
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("dall-e-3");
    expect(result.attempts).toHaveLength(0);
  });

  it("passes prompt, count, size, and aspectRatio to the provider", async () => {
    mockParseImageGenerationModelRef.mockReturnValue({ provider: "openai", model: "dall-e-3" });
    const provider = makeSuccessProvider();
    mockGetImageGenerationProvider.mockReturnValue(provider);

    await generateImage({
      cfg: {},
      prompt: "wide shot",
      modelOverride: "openai/dall-e-3",
      count: 2,
      size: "1792x1024",
      aspectRatio: "16:9",
    });

    expect(provider.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "wide shot",
        count: 2,
        size: "1792x1024",
        aspectRatio: "16:9",
        model: "dall-e-3",
        provider: "openai",
      }),
    );
  });

  it("falls back to the second candidate when the first throws", async () => {
    mockParseImageGenerationModelRef
      .mockReturnValueOnce({ provider: "failing", model: "v1" })
      .mockReturnValueOnce({ provider: "openai", model: "dall-e-3" });
    mockResolveAgentModelFallbackValues.mockReturnValue(["openai/dall-e-3"]);

    const failingProvider = {
      generateImage: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    };
    const successProvider = makeSuccessProvider();
    mockGetImageGenerationProvider
      .mockReturnValueOnce(failingProvider)
      .mockReturnValueOnce(successProvider);

    const result = await generateImage({
      cfg: {},
      prompt: "draw a cat",
      modelOverride: "failing/v1",
    });

    expect(result.provider).toBe("openai");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      provider: "failing",
      model: "v1",
      error: "provider unavailable",
    });
  });

  it("throws with a summary of all attempts when all candidates fail", async () => {
    mockParseImageGenerationModelRef
      .mockReturnValueOnce({ provider: "a", model: "m1" })
      .mockReturnValueOnce({ provider: "b", model: "m2" });
    mockResolveAgentModelFallbackValues.mockReturnValue(["b/m2"]);

    const failA = {
      generateImage: vi.fn(async () => {
        throw new Error("error A");
      }),
    };
    const failB = {
      generateImage: vi.fn(async () => {
        throw new Error("error B");
      }),
    };
    mockGetImageGenerationProvider.mockReturnValueOnce(failA).mockReturnValueOnce(failB);

    await expect(
      generateImage({ cfg: {}, prompt: "draw a cat", modelOverride: "a/m1" }),
    ).rejects.toThrow(/All image generation models failed.*2/);
  });

  it("skips duplicate provider/model combinations", async () => {
    // modelOverride and the config's primary value both parse to the same
    // provider/model pair — the seen-set in resolveImageGenerationCandidates
    // must drop the duplicate so generateImage is called exactly once.
    mockParseImageGenerationModelRef
      .mockReturnValueOnce({ provider: "openai", model: "dall-e-3" }) // from modelOverride
      .mockReturnValueOnce({ provider: "openai", model: "dall-e-3" }); // from cfg primary
    mockResolveAgentModelPrimaryValue.mockReturnValue("openai/dall-e-3");
    const provider = makeSuccessProvider();
    mockGetImageGenerationProvider.mockReturnValue(provider);

    await generateImage({
      cfg: {},
      prompt: "draw a cat",
      modelOverride: "openai/dall-e-3",
    });

    // Deduplication collapsed two identical candidates into one attempt.
    expect(provider.generateImage).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// listRuntimeImageGenerationProviders
// ---------------------------------------------------------------------------

describe("listRuntimeImageGenerationProviders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("delegates to listImageGenerationProviders", () => {
    const providers = [{ id: "openai" }, { id: "fal" }];
    mockListImageGenerationProviders.mockReturnValue(providers);

    const result = listRuntimeImageGenerationProviders();
    expect(result).toBe(providers);
    expect(mockListImageGenerationProviders).toHaveBeenCalledTimes(1);
  });

  it("forwards the config argument to listImageGenerationProviders", () => {
    mockListImageGenerationProviders.mockReturnValue([]);
    const cfg = { models: { providers: {} } };

    listRuntimeImageGenerationProviders({ config: cfg });
    expect(mockListImageGenerationProviders).toHaveBeenCalledWith(cfg);
  });

  it("calls listImageGenerationProviders with undefined when no config is given", () => {
    mockListImageGenerationProviders.mockReturnValue([]);

    listRuntimeImageGenerationProviders();
    expect(mockListImageGenerationProviders).toHaveBeenCalledWith(undefined);
  });
});
