import "openclaw/plugin-sdk/image-generation";
import "openclaw/plugin-sdk/media-generation-runtime";
import "openclaw/plugin-sdk/provider-http";
import { expectDefined } from "@openclaw/normalization-core";
import { generateImage } from "openclaw/plugin-sdk/image-generation-runtime";
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

function createImageProvider(configured: boolean) {
  return buildOpenAIImageGenerationProvider({
    ensureAuthProfileStoreAsync: async () => ({ version: 1, profiles: {} }),
    listProfilesForProvider: () => [],
    isProviderApiKeyConfiguredAsync: async () => configured,
  });
}

const provider = createImageProvider(true);
const runtimeDeps = { getProvider: () => provider, listProviders: () => [provider] };

function mockGeneratedPngResponse(quality?: string) {
  const result = {
    response: Response.json({ data: [{ b64_json: "cG5nLWJ5dGVz" }], quality }),
    release: async () => {},
  };
  postJsonRequest.mockResolvedValue(result);
  postMultipartRequest.mockResolvedValue(result);
}
beforeEach(() => {
  postJsonRequest.mockReset();
  postMultipartRequest.mockReset();
});

it("keeps model auth scoped to each registration on concurrent first use", async () => {
  const checks = [true, false].map((configured) => {
    const isConfigured = expectDefined(
      createImageProvider(configured).isConfiguredAsync,
      "OpenAI image configuration hook",
    );
    return isConfigured({});
  });
  expect(await Promise.all(checks)).toEqual([true, false]);
});

describe("OpenAI GPT Image 2.6 models", () => {
  it.each(["gpt-image-2.6-sunburst", "gpt-image-2.6-flare"])(
    "lists %s and forwards its flexible size, xhigh quality and transparent background",
    async (model) => {
      expect(provider.models).toContain(model);
      mockGeneratedPngResponse("xhigh");

      const result = await generateImage(
        {
          cfg: {},
          modelOverride: `openai/${model}`,
          prompt: "A transparent poster",
          size: "1536x864",
          quality: "xhigh",
          outputFormat: "png",
          background: "transparent",
        },
        runtimeDeps,
      );

      const request = postJsonRequest.mock.calls[0]?.[0];
      expect(request?.url).toBe("https://api.openai.com/v1/images/generations");
      expect(request?.body).toMatchObject({
        model,
        size: "1536x864",
        quality: "xhigh",
        output_format: "png",
        background: "transparent",
      });
      expect(result.ignoredOverrides).toEqual([]);
      expect(result.images[0]?.metadata).toEqual({ quality: "xhigh" });
    },
  );

  it("sends edits with automatic size and max quality", async () => {
    mockGeneratedPngResponse();

    await generateImage(
      {
        cfg: {},
        modelOverride: "openai/gpt-image-2.6-sunburst",
        prompt: "Keep the layout and recolor the sign",
        size: "auto",
        quality: "max",
        inputImages: [{ buffer: Buffer.from("reference"), mimeType: "image/png" }],
      },
      runtimeDeps,
    );

    const request = postMultipartRequest.mock.calls[0]?.[0];
    expect(request?.url).toBe("https://api.openai.com/v1/images/edits");
    const body = request?.body as FormData;
    expect(body.get("model")).toBe("gpt-image-2.6-sunburst");
    expect(body.get("size")).toBe("auto");
    expect(body.get("quality")).toBe("max");
  });
});
