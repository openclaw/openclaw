// Prepare lazy SDK imports during collection, before any request deadline starts.
import "openclaw/plugin-sdk/image-generation";
import "openclaw/plugin-sdk/media-generation-runtime";
import "openclaw/plugin-sdk/provider-http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import { openAIImageConfig } from "./image-generation-provider.test-support.js";

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: async () => ({ apiKey: "endpoint-key", mode: "api-key" }),
}));

const origin = "http://127.0.0.1:19613";
const imageUrl = `${origin}/generated.png`;
const privateUrl = "http://127.0.0.2:19613/generated.png";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP4sAAAAASUVORK5CYII=",
  "base64",
);
const provider = buildOpenAIImageGenerationProvider({
  ensureAuthProfileStoreAsync: async () => ({ version: 1, profiles: {} }),
  listProfilesForProvider: () => [],
  isProviderApiKeyConfiguredAsync: async () => true,
});
const config = {
  ...openAIImageConfig({ baseUrl: `${origin}/v1`, apiKey: "endpoint-key" }),
  agents: { defaults: { mediaMaxMb: 1 / (1024 * 1024) } },
};
const image = (
  buffer = png,
  mimeType = "image/png",
  fileName = "image-1.png",
  revisedPrompt = "Revised fixture",
) => ({ buffer, mimeType, fileName, revisedPrompt });
type OpenAIImageRequest = Parameters<typeof provider.generateImage>[0];
let payload: unknown;
let contentType: string | undefined;
let imageBytes: Uint8Array<ArrayBuffer>;
let redirect: string | undefined;
const fetchMock = vi.fn<typeof fetch>();
const generate = (overrides: Partial<OpenAIImageRequest> = {}) =>
  provider.generateImage({
    provider: "openai",
    model: "gpt-image-2",
    prompt: "Synthetic image",
    cfg: config,
    ssrfPolicy: { allowedOrigins: [origin] },
    ...overrides,
  });

beforeEach(() => {
  vi.stubEnv("OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER", "");
  payload = { data: [{ url: imageUrl, revised_prompt: "Revised fixture" }] };
  contentType = "image/png";
  imageBytes = new Uint8Array(png);
  redirect = undefined;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_input, init) => {
    if (init?.method === "POST") {
      return Response.json(payload);
    }
    if (redirect) {
      return new Response(null, { status: 302, headers: { Location: redirect } });
    }
    return new Response(imageBytes, {
      headers: contentType ? { "Content-Type": contentType } : {},
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("OpenAI-compatible image URL responses", () => {
  it.each(["generations", "edits"])(
    "downloads URL results above the media cap from %s",
    async (action) => {
      const result = await generate({
        inputImages: action === "edits" ? [{ buffer: png, mimeType: "image/png" }] : undefined,
      });
      expect(result.images).toEqual([image()]);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`${origin}/v1/images/${action}`);
      expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
        "Bearer endpoint-key",
      );
      expect(fetchMock.mock.calls[1]?.[0]).toBe(imageUrl);
      const headers = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
      expect(headers.has("Authorization")).toBe(false);
      expect(headers.has("Cookie")).toBe(false);
    },
  );

  it("prefers inline bytes when both response forms are present", async () => {
    payload = { data: [{ b64_json: png.toString("base64"), url: privateUrl }] };
    expect((await generate()).images[0]?.buffer).toEqual(png);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves ordering, MIME filenames, and revised prompts for mixed responses", async () => {
    imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    contentType = "image/jpeg; charset=binary";
    payload = {
      data: [
        { b64_json: png.toString("base64"), revised_prompt: "Inline" },
        { url: imageUrl, revised_prompt: "Remote" },
      ],
    };
    const result = await generate({ count: 2 });
    expect(result.images).toEqual([
      image(png, "image/png", "image-1.png", "Inline"),
      image(Buffer.from(imageBytes), "image/jpeg", "image-2.jpg", "Remote"),
    ]);
  });

  it.each(["direct", "local API allowance", "redirect"])(
    "blocks private image origins: %s",
    async (route) => {
      if (route === "redirect") {
        redirect = privateUrl;
      } else {
        vi.stubEnv(
          "OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER",
          route === "local API allowance" ? "1" : "",
        );
        payload = { data: [{ url: privateUrl }] };
      }
      await expect(generate()).rejects.toThrow(/private|blocked|internal/i);
      expect(fetchMock).toHaveBeenCalledTimes(route === "redirect" ? 2 : 1);
    },
  );

  it("applies the provider's explicit private-network opt-in to image downloads", async () => {
    payload = { data: [{ url: privateUrl }] };
    const result = await generate({
      cfg: { ...config, browser: { ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } } },
    });
    expect(result.images[0]?.buffer).toEqual(png);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(privateUrl);
  });

  it.each([undefined, "text/html"])("rejects non-image Content-Type %s", async (mimeType) => {
    contentType = mimeType;
    await expect(generate()).rejects.toThrow(/image.*content.type/i);
  });

  it("rejects streamed downloads above the generated image download ceiling", async () => {
    imageBytes = new Uint8Array(65 * 1024 * 1024);
    await expect(generate()).rejects.toThrow(/exceeds|too large/i);
  });

  it("bounds downloads by the provider's declared maximum result count", async () => {
    payload = { data: Array.from({ length: 5 }, () => ({ url: imageUrl })) };
    await expect(generate()).rejects.toThrow(/too many image URLs/i);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
