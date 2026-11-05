import "openclaw/plugin-sdk/image-generation";
import "openclaw/plugin-sdk/media-generation-runtime";
import "openclaw/plugin-sdk/provider-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";

const { postJsonRequest, postMultipartRequest } = vi.hoisted(() => ({
  postJsonRequest: vi.fn(),
  postMultipartRequest: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: async () => ({ apiKey: "image-fixture-key", mode: "api-key" }),
}));
vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  postJsonRequest,
  postMultipartRequest,
}));

const provider = buildOpenAIImageGenerationProvider({
  ensureAuthProfileStoreAsync: async () => ({ version: 1, profiles: {} }),
  listProfilesForProvider: () => [],
  isProviderApiKeyConfiguredAsync: async () => true,
});
type Request = Parameters<typeof provider.generateImage>[0];
const generate = (overrides: Partial<Request> = {}) =>
  provider.generateImage({
    provider: "openai",
    model: "gpt-image-2.6-flare",
    prompt: "A blinking cat",
    cfg: {},
    ...overrides,
  });
const requestBody = () =>
  (postJsonRequest.mock.calls[0]?.[0] as { body: Record<string, unknown> } | undefined)?.body;

beforeEach(() => {
  postJsonRequest.mockReset();
  postMultipartRequest.mockReset();
  postJsonRequest.mockResolvedValue({
    response: Response.json({ data: [{ b64_json: "R0lGODlhAQABAAAAACw=" }] }),
    release: async () => {},
  });
});

describe("OpenAI GPT Image 2.6 GIF output", () => {
  it("declares GIF only for 2.6 models", () => {
    const output = provider.capabilities.output;
    expect(provider.models).toEqual(
      expect.arrayContaining(["gpt-image-2.6-flare", "gpt-image-2.6-sunburst"]),
    );
    expect(output?.formatsByModel?.["gpt-image-2.6-flare"]).toContain("gif");
    expect(output?.formatsByModel?.["gpt-image-2.6-sunburst"]).toContain("gif");
    expect(output?.formatsByModel?.["gpt-image-2.5-flare"]).toBeUndefined();
    expect(output?.formats).not.toContain("gif");
    expect(output?.qualitiesByModel?.["gpt-image-2.6-flare"]).toContain("max");
  });

  it("sends frame controls, lets OpenAI pick the frame size, and returns a GIF", async () => {
    const result = await generate({
      outputFormat: "gif",
      providerOptions: {
        openai: { frameCount: 12, frameDurationMs: 120, outputCompression: 50 },
      },
    });
    expect(requestBody()).toEqual({
      model: "gpt-image-2.6-flare",
      prompt: "A blinking cat",
      n: 1,
      size: "auto",
      output_format: "gif",
      frame_count: 12,
      frame_duration_ms: 120,
    });
    expect(result.images[0]).toMatchObject({ mimeType: "image/gif", fileName: "image-1.gif" });
  });

  it("keeps small per-frame GIF sizes that still images would normalize", async () => {
    await generate({ model: "gpt-image-2.6-sunburst", outputFormat: "gif", size: "512x512" });
    expect(requestBody()).toMatchObject({ size: "512x512", output_format: "gif" });
  });

  it("omits frame controls from still-image requests", async () => {
    await generate({
      outputFormat: "png",
      providerOptions: { openai: { frameCount: 12, frameDurationMs: 120 } },
    });
    expect(requestBody()).not.toHaveProperty("frame_count");
    expect(requestBody()).not.toHaveProperty("frame_duration_ms");
    expect(requestBody()?.size).toBe("1024x1024");
  });

  it("rejects GIF edits before sending a request", async () => {
    await expect(
      generate({
        outputFormat: "gif",
        inputImages: [{ buffer: Buffer.from("png"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow("OpenAI GIF output supports image generation only, not edits.");
    expect(postJsonRequest).not.toHaveBeenCalled();
    expect(postMultipartRequest).not.toHaveBeenCalled();
  });
});
