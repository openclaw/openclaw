import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks — hoisted so they are available before module evaluation.
// ---------------------------------------------------------------------------

const {
  mockBuildProviderRegistry,
  mockCreateMediaAttachmentCache,
  mockNormalizeMediaAttachments,
  mockNormalizeMediaProviderId,
  mockRunCapability,
  mockReadFile,
} = vi.hoisted(() => ({
  mockBuildProviderRegistry: vi.fn(),
  mockCreateMediaAttachmentCache: vi.fn(),
  mockNormalizeMediaAttachments: vi.fn(),
  mockNormalizeMediaProviderId: vi.fn((id: string) => id),
  mockRunCapability: vi.fn(),
  mockReadFile: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  buildProviderRegistry: mockBuildProviderRegistry,
  createMediaAttachmentCache: mockCreateMediaAttachmentCache,
  normalizeMediaAttachments: mockNormalizeMediaAttachments,
  normalizeMediaProviderId: mockNormalizeMediaProviderId,
  runCapability: mockRunCapability,
}));

vi.mock("node:fs/promises", () => ({
  // Top-level named export covers any future refactor to named imports.
  readFile: mockReadFile,
  // Default export covers the current `import fs from "node:fs/promises"` usage.
  default: { readFile: mockReadFile },
}));

import {
  describeImageFile,
  describeImageFileWithModel,
  describeVideoFile,
  runMediaUnderstandingFile,
  transcribeAudioFile,
} from "./runtime.js";

// Reset mock implementations after every test so persistent mockImplementation
// calls do not bleed across tests when running with --isolate=false.
afterEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCache() {
  return { cleanup: vi.fn(async () => {}) };
}

function makeCapabilityResult(overrides?: {
  kind?: string;
  text?: string;
  provider?: string;
  model?: string;
}) {
  return {
    outputs: [
      {
        kind: overrides?.kind ?? "image.description",
        text: overrides?.text ?? "A fluffy cat",
        provider: overrides?.provider ?? "openai",
        model: overrides?.model ?? "gpt-5.4",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// runMediaUnderstandingFile
// ---------------------------------------------------------------------------

describe("runMediaUnderstandingFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNormalizeMediaProviderId.mockImplementation((id: string) => id);
  });

  it("returns undefined text when normalizeMediaAttachments returns empty array", async () => {
    mockNormalizeMediaAttachments.mockReturnValue([]);

    const result = await runMediaUnderstandingFile({
      capability: "image",
      filePath: "/tmp/cat.png",
      cfg: {},
    });

    expect(result).toEqual({ text: undefined });
    expect(mockRunCapability).not.toHaveBeenCalled();
  });

  it("returns early without calling providers when capability is disabled in config", async () => {
    mockNormalizeMediaAttachments.mockReturnValue([{ id: "attach-1" }]);

    const result = await runMediaUnderstandingFile({
      capability: "image",
      filePath: "/tmp/cat.png",
      cfg: { tools: { media: { image: { enabled: false } } } },
    });

    expect(result).toEqual({
      text: undefined,
      provider: undefined,
      model: undefined,
      output: undefined,
    });
    expect(mockRunCapability).not.toHaveBeenCalled();
  });

  it("returns text, provider, and model on success", async () => {
    mockNormalizeMediaAttachments.mockReturnValue([{ id: "attach-1" }]);
    const cache = makeCache();
    mockCreateMediaAttachmentCache.mockReturnValue(cache);
    mockBuildProviderRegistry.mockReturnValue(new Map());
    mockRunCapability.mockResolvedValue(makeCapabilityResult());

    const result = await runMediaUnderstandingFile({
      capability: "image",
      filePath: "/tmp/cat.png",
      cfg: {},
    });

    expect(result.text).toBe("A fluffy cat");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.4");
    expect(result.output).toBeDefined();
  });

  it("trims whitespace from output text", async () => {
    mockNormalizeMediaAttachments.mockReturnValue([{ id: "attach-1" }]);
    mockCreateMediaAttachmentCache.mockReturnValue(makeCache());
    mockBuildProviderRegistry.mockReturnValue(new Map());
    mockRunCapability.mockResolvedValue(makeCapabilityResult({ text: "  padded text  " }));

    const result = await runMediaUnderstandingFile({
      capability: "image",
      filePath: "/tmp/cat.png",
      cfg: {},
    });

    expect(result.text).toBe("padded text");
  });

  it("returns undefined text when output text is whitespace-only", async () => {
    mockNormalizeMediaAttachments.mockReturnValue([{ id: "attach-1" }]);
    mockCreateMediaAttachmentCache.mockReturnValue(makeCache());
    mockBuildProviderRegistry.mockReturnValue(new Map());
    mockRunCapability.mockResolvedValue(makeCapabilityResult({ text: "   " }));

    const result = await runMediaUnderstandingFile({
      capability: "image",
      filePath: "/tmp/cat.png",
      cfg: {},
    });

    expect(result.text).toBeUndefined();
  });

  it("calls cache.cleanup even when runCapability throws", async () => {
    mockNormalizeMediaAttachments.mockReturnValue([{ id: "attach-1" }]);
    const cache = makeCache();
    mockCreateMediaAttachmentCache.mockReturnValue(cache);
    mockBuildProviderRegistry.mockReturnValue(new Map());
    mockRunCapability.mockRejectedValue(new Error("provider failure"));

    await expect(
      runMediaUnderstandingFile({
        capability: "image",
        filePath: "/tmp/cat.png",
        cfg: {},
      }),
    ).rejects.toThrow("provider failure");

    expect(cache.cleanup).toHaveBeenCalledTimes(1);
  });

  it("calls cache.cleanup on success", async () => {
    mockNormalizeMediaAttachments.mockReturnValue([{ id: "attach-1" }]);
    const cache = makeCache();
    mockCreateMediaAttachmentCache.mockReturnValue(cache);
    mockBuildProviderRegistry.mockReturnValue(new Map());
    mockRunCapability.mockResolvedValue(makeCapabilityResult());

    await runMediaUnderstandingFile({
      capability: "image",
      filePath: "/tmp/cat.png",
      cfg: {},
    });

    expect(cache.cleanup).toHaveBeenCalledTimes(1);
  });

  it("uses audio.transcription output kind for audio capability", async () => {
    mockNormalizeMediaAttachments.mockReturnValue([{ id: "attach-1" }]);
    mockCreateMediaAttachmentCache.mockReturnValue(makeCache());
    mockBuildProviderRegistry.mockReturnValue(new Map());
    mockRunCapability.mockResolvedValue(
      makeCapabilityResult({ kind: "audio.transcription", text: "Hello world" }),
    );

    const result = await runMediaUnderstandingFile({
      capability: "audio",
      filePath: "/tmp/clip.mp3",
      cfg: {},
    });

    expect(result.text).toBe("Hello world");
    expect(mockRunCapability).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "audio" }),
    );
  });

  it("uses video.description output kind for video capability", async () => {
    mockNormalizeMediaAttachments.mockReturnValue([{ id: "attach-1" }]);
    mockCreateMediaAttachmentCache.mockReturnValue(makeCache());
    mockBuildProviderRegistry.mockReturnValue(new Map());
    mockRunCapability.mockResolvedValue(
      makeCapabilityResult({ kind: "video.description", text: "A cat jumping" }),
    );

    const result = await runMediaUnderstandingFile({
      capability: "video",
      filePath: "/tmp/video.mp4",
      cfg: {},
    });

    expect(result.text).toBe("A cat jumping");
    expect(mockRunCapability).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "video" }),
    );
  });
});

// ---------------------------------------------------------------------------
// describeImageFile / describeVideoFile / transcribeAudioFile
// ---------------------------------------------------------------------------

describe("describeImageFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to runMediaUnderstandingFile with capability=image", async () => {
    mockNormalizeMediaAttachments.mockReturnValue([]);

    const result = await describeImageFile({ filePath: "/tmp/img.jpg", cfg: {} });

    expect(result).toEqual({ text: undefined });
    expect(mockNormalizeMediaAttachments).toHaveBeenCalledTimes(1);
  });
});

describe("describeVideoFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to runMediaUnderstandingFile with capability=video", async () => {
    mockNormalizeMediaAttachments.mockReturnValue([]);

    const result = await describeVideoFile({ filePath: "/tmp/vid.mp4", cfg: {} });

    expect(result).toEqual({ text: undefined });
    expect(mockNormalizeMediaAttachments).toHaveBeenCalledTimes(1);
  });
});

describe("transcribeAudioFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only text from the underlying result", async () => {
    mockNormalizeMediaAttachments.mockReturnValue([{ id: "a" }]);
    mockCreateMediaAttachmentCache.mockReturnValue(makeCache());
    mockBuildProviderRegistry.mockReturnValue(new Map());
    mockRunCapability.mockResolvedValue(
      makeCapabilityResult({ kind: "audio.transcription", text: "Transcribed" }),
    );

    const result = await transcribeAudioFile({ filePath: "/tmp/clip.ogg", cfg: {} });

    expect(result).toEqual({ text: "Transcribed" });
    expect(Object.keys(result)).toEqual(["text"]);
  });
});

// ---------------------------------------------------------------------------
// describeImageFileWithModel
// ---------------------------------------------------------------------------

describe("describeImageFileWithModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNormalizeMediaProviderId.mockImplementation((id: string) => id);
  });

  it("throws when the provider is not registered or lacks describeImage", async () => {
    const registry = new Map();
    mockBuildProviderRegistry.mockReturnValue(registry);

    await expect(
      describeImageFileWithModel({
        filePath: "/tmp/cat.png",
        cfg: {},
        provider: "unknown-provider",
        model: "v1",
        prompt: "describe this",
      }),
    ).rejects.toThrow(/Provider does not support image analysis: unknown-provider/);
  });

  it("throws when provider exists but has no describeImage method", async () => {
    const registry = new Map([["openai", { someOtherMethod: vi.fn() }]]);
    mockBuildProviderRegistry.mockReturnValue(registry);

    await expect(
      describeImageFileWithModel({
        filePath: "/tmp/cat.png",
        cfg: {},
        provider: "openai",
        model: "gpt-5.4",
        prompt: "describe this",
      }),
    ).rejects.toThrow(/Provider does not support image analysis: openai/);
  });

  it("calls provider.describeImage with correct params", async () => {
    const mockDescribeImage = vi.fn(async () => ({ text: "A cat" }));
    const registry = new Map([["openai", { describeImage: mockDescribeImage }]]);
    mockBuildProviderRegistry.mockReturnValue(registry);
    mockReadFile.mockResolvedValue(Buffer.from("image-bytes"));

    await describeImageFileWithModel({
      filePath: "/tmp/cat.png",
      cfg: {},
      provider: "openai",
      model: "gpt-5.4",
      prompt: "describe this",
      maxTokens: 256,
      timeoutMs: 10_000,
    });

    expect(mockDescribeImage).toHaveBeenCalledWith(
      expect.objectContaining({
        buffer: Buffer.from("image-bytes"),
        fileName: "cat.png",
        provider: "openai",
        model: "gpt-5.4",
        prompt: "describe this",
        maxTokens: 256,
        timeoutMs: 10_000,
        cfg: {},
        agentDir: "",
      }),
    );
  });

  it("defaults timeoutMs to 30000 when not provided", async () => {
    const mockDescribeImage = vi.fn(async () => ({ text: "A cat" }));
    const registry = new Map([["openai", { describeImage: mockDescribeImage }]]);
    mockBuildProviderRegistry.mockReturnValue(registry);
    mockReadFile.mockResolvedValue(Buffer.from("image-bytes"));

    await describeImageFileWithModel({
      filePath: "/tmp/cat.png",
      cfg: {},
      provider: "openai",
      model: "gpt-5.4",
      prompt: "describe this",
    });

    expect(mockDescribeImage).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30_000 }));
  });

  it("passes agentDir to provider.describeImage", async () => {
    const mockDescribeImage = vi.fn(async () => ({ text: "ok" }));
    const registry = new Map([["openai", { describeImage: mockDescribeImage }]]);
    mockBuildProviderRegistry.mockReturnValue(registry);
    mockReadFile.mockResolvedValue(Buffer.from("img"));

    await describeImageFileWithModel({
      filePath: "/tmp/cat.png",
      cfg: {},
      provider: "openai",
      model: "gpt-5.4",
      prompt: "what is this",
      agentDir: "/agents/my-agent",
    });

    expect(mockDescribeImage).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: "/agents/my-agent" }),
    );
  });
});
