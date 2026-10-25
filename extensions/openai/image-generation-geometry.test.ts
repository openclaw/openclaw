import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { generateImage } from "openclaw/plugin-sdk/image-generation-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import { openAIImageConfig } from "./image-generation-provider.test-support.js";

const { postJsonRequestMock, postMultipartRequestMock } = vi.hoisted(() => ({
  postJsonRequestMock: vi.fn(),
  postMultipartRequestMock: vi.fn(),
}));

// mock-isolation: Keep operator credentials outside this request-geometry fixture.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: async () => ({ apiKey: "test-key", mode: "api-key" }),
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  postJsonRequest: postJsonRequestMock,
  postMultipartRequest: postMultipartRequestMock,
}));

describe("OpenAI image request geometry", () => {
  const provider = buildOpenAIImageGenerationProvider({
    ensureAuthProfileStore: () => ({ version: 1, profiles: {} }),
    listProfilesForProvider: () => [],
    isProviderApiKeyConfigured: () => true,
  });

  beforeEach(() => {
    const respond = async () => ({
      response: new Response(
        JSON.stringify({ data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }] }),
        { headers: { "Content-Type": "application/json" } },
      ),
      release: async () => {},
    });
    postJsonRequestMock.mockImplementation(respond);
    postMultipartRequestMock.mockImplementation(respond);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function jsonRequestCall(): { url: string; body: Record<string, unknown> } {
    return postJsonRequestMock.mock.calls[0]![0];
  }

  function multipartRequestCall(): { url: string; body: FormData } {
    return postMultipartRequestMock.mock.calls[0]![0];
  }

  function generateOpenAIImage(
    prompt: string,
    request: Omit<Parameters<typeof provider.generateImage>[0], "prompt" | "provider">,
  ) {
    return provider.generateImage({ provider: "openai", prompt, ...request });
  }

  it.each([
    ["gpt-image-1-mini", "https://api.openai.com/v1"],
    ["gpt-image-1.5", "https://api.openai.com/v1"],
    ["gpt-image-1.5", "https://myresource.openai.azure.com/openai/v1"],
  ])("normalizes legacy native image dimensions for %s at %s", async (model, baseUrl) => {
    const result = await generateOpenAIImage("Wide image", {
      model,
      cfg: openAIImageConfig({ baseUrl }),
      size: "2048x1152",
    });
    expect(jsonRequestCall().body).toMatchObject({ size: "1536x1024" });
    expect(result.metadata).toEqual({ requestedSize: "2048x1152", normalizedSize: "1536x1024" });
  });

  describe.each(["gpt-image-1", "gpt-image-1-mini", "gpt-image-1.5"])(
    "%s through a custom endpoint",
    (model) => {
      it.each([
        ["16:9", "1536x1024", false],
        ["9:16", "1024x1536", false],
        ["21:9", "1536x1024", true],
      ] as const)("maps %s to %s (edit=%s)", async (aspectRatio, size, edit) => {
        const result = await generateImage(
          {
            cfg: openAIImageConfig({ baseUrl: "https://openai-compatible.example.com/v1" }),
            modelOverride: `openai/${model}`,
            prompt: "A lighthouse",
            aspectRatio,
            ...(edit
              ? { inputImages: [{ buffer: Buffer.from("reference"), mimeType: "image/png" }] }
              : {}),
          },
          { getProvider: () => provider, listProviders: () => [provider] },
        );

        if (edit) {
          const request = multipartRequestCall();
          expect(request.url).toBe("https://openai-compatible.example.com/v1/images/edits");
          expect((request.body as FormData).get("size")).toBe(size);
          expect((request.body as FormData).get("model")).toBe(model);
        } else {
          expect(jsonRequestCall().url).toBe(
            "https://openai-compatible.example.com/v1/images/generations",
          );
          expect(jsonRequestCall().body).toMatchObject({ model, size });
        }
        expect(result.normalization?.size).toEqual({ applied: size, derivedFrom: "aspectRatio" });
        expect(result.images[0]?.buffer).toEqual(Buffer.from("png-bytes"));
      });
    },
  );
});
