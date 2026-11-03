import "openclaw/plugin-sdk/image-generation";
import "openclaw/plugin-sdk/media-generation-runtime";
import "openclaw/plugin-sdk/provider-http";
import { generateImage } from "openclaw/plugin-sdk/image-generation-runtime";
import { encodePngRgba } from "openclaw/plugin-sdk/media-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";

const { postJsonRequest, postMultipartRequest, resolveApiKeyForProvider } = vi.hoisted(() => ({
  postJsonRequest: vi.fn(),
  postMultipartRequest: vi.fn(),
  resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: "image-fixture-key", mode: "api-key" })),
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider,
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
    model: "gpt-image-1",
    prompt: "Account for image tokens",
    cfg: {},
    ...overrides,
  });
function mockGeneratedPngResponse(usage?: Record<string, unknown>) {
  const result = {
    response: Response.json({ data: [{ b64_json: "cG5nLWJ5dGVz" }], usage }),
    release: async () => {},
  };
  postJsonRequest.mockResolvedValue(result);
  postMultipartRequest.mockResolvedValue(result);
}
beforeEach(() => {
  postJsonRequest.mockReset();
  postMultipartRequest.mockReset();
});

describe("direct OpenAI image token usage", () => {
  it.each([false, true])("preserves image usage and size metadata (edit=%s)", async (edit) => {
    const usage = {
      input_tokens: 0,
      output_tokens: 92,
      total_tokens: 92,
      input_tokens_details: { text_tokens: 0, image_tokens: 0 },
      output_tokens_details: { text_tokens: 0, image_tokens: 92 },
    };
    mockGeneratedPngResponse(usage);
    const result = await generate({
      model: "gpt-image-1",
      size: "2048x1152",
      ...(edit
        ? { inputImages: [{ buffer: Buffer.from("reference"), mimeType: "image/png" }] }
        : {}),
    });
    expect(result.metadata).toEqual({
      requestedSize: "2048x1152",
      normalizedSize: "1536x1024",
      usage,
    });
    expect(edit ? postMultipartRequest : postJsonRequest).toHaveBeenCalledOnce();
  });

  it("keeps only valid documented image token counters", async () => {
    mockGeneratedPngResponse({
      input_tokens: -1,
      output_tokens: 1.5,
      total_tokens: Number.MAX_SAFE_INTEGER + 1,
      input_tokens_details: { text_tokens: 0, image_tokens: 9, cached_tokens: 3 },
      output_tokens_details: { text_tokens: "4", image_tokens: null },
      provider_metadata: "unsupported",
    });
    const result = await generate();
    expect(result.metadata).toEqual({
      usage: { input_tokens_details: { text_tokens: 0, image_tokens: 9 } },
    });
  });
});

describe("Codex Responses image sizes", () => {
  it.each([
    ["2048x1152", [{ key: "size", value: "2048x1152" }]],
    ["1536x1024", []],
    [undefined, []],
  ] as const)("reports ignored size %s from returned image dimensions", async (size, ignored) => {
    resolveApiKeyForProvider.mockResolvedValueOnce({ apiKey: "image-fixture-key", mode: "oauth" });
    const buffer = encodePngRgba(Buffer.alloc(1536 * 1024 * 4), 1536, 1024);
    const event = {
      type: "response.completed",
      response: { output: [{ type: "image_generation_call", result: buffer.toString("base64") }] },
    };
    postJsonRequest.mockResolvedValue({
      response: new Response(`data: ${JSON.stringify(event)}\n\n`),
      release: async () => {},
    });
    const result = await generateImage(
      { cfg: {}, modelOverride: "openai/gpt-image-1", prompt: "A red bicycle", size },
      { getProvider: () => provider, listProviders: () => [provider] },
    );
    expect(result.images[0]?.buffer).toEqual(buffer);
    expect(result.ignoredOverrides).toEqual(ignored);
  });
});
