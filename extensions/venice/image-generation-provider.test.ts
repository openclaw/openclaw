import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

import {
  buildVeniceImageGenerationProvider,
  setVeniceImageFetchGuardForTesting,
} from "./image-generation-provider.js";

// 1x1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function lastRequest() {
  const request = fetchWithSsrFGuardMock.mock.calls.at(-1)?.[0];
  if (!request) {
    throw new Error("expected a venice fetch request");
  }
  return request;
}

describe("venice image-generation provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "venice-test-key",
      source: "env",
      mode: "api-key",
    });
    setVeniceImageFetchGuardForTesting(fetchWithSsrFGuardMock);
  });

  afterEach(() => {
    setVeniceImageFetchGuardForTesting(null);
    vi.restoreAllMocks();
  });

  function mockImageResponse(): void {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ id: "img-1", images: [PNG_BASE64] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      release: vi.fn(async () => {}),
    });
  }

  it("posts to the venice image endpoint and decodes base64 images", async () => {
    mockImageResponse();
    const provider = buildVeniceImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "venice",
      model: "lustify-v8",
      prompt: "a serene mountain lake",
      cfg: {} as never,
      aspectRatio: "16:9",
      count: 2,
    });

    const request = lastRequest();
    expect(request.url).toBe("https://api.venice.ai/api/v1/image/generate");
    expect(request.auditContext).toBe("venice-image-generate");
    expect(request.policy).toEqual({ allowedHostnames: ["api.venice.ai"] });
    expect(request.init?.method).toBe("POST");
    expect(new Headers(request.init?.headers).get("authorization")).toBe("Bearer venice-test-key");

    const body = JSON.parse(String(request.init?.body));
    expect(body).toMatchObject({
      model: "lustify-v8",
      prompt: "a serene mountain lake",
      aspect_ratio: "16:9",
      variants: 2,
      return_binary: false,
      // Uncensored-by-default: the Venice plugin disables safe_mode.
      safe_mode: false,
    });
    expect(body.width).toBeUndefined();

    expect(result.model).toBe("lustify-v8");
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.mimeType).toBe("image/png");
    expect(result.images[0]?.buffer.length).toBeGreaterThan(0);
  });

  it("maps an explicit size to clamped width/height and defaults the model", async () => {
    mockImageResponse();
    const provider = buildVeniceImageGenerationProvider();
    await provider.generateImage({
      provider: "venice",
      prompt: "test",
      cfg: {} as never,
      size: "2048x768",
    });

    const body = JSON.parse(String(lastRequest().init?.body));
    expect(body.model).toBe(provider.defaultModel);
    expect(body.width).toBe(1280); // clamped to Venice max edge
    expect(body.height).toBe(768);
    expect(body.aspect_ratio).toBeUndefined();
    expect(body.variants).toBe(1);
  });

  it("throws on a malformed response", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ images: "nope" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      release: vi.fn(async () => {}),
    });
    const provider = buildVeniceImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "venice",
        prompt: "test",
        cfg: {} as never,
      }),
    ).rejects.toThrow(/malformed/);
  });
});
