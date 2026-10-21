// Preload lazy SDK imports before starting provider deadlines.
import "openclaw/plugin-sdk/image-generation";
import "openclaw/plugin-sdk/provider-http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ImageGenerationRequest } from "openclaw/plugin-sdk/image-generation";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLitellmImageGenerationProvider } from "./image-generation-provider.js";

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: async () => ({ apiKey: "fixture-provider-key", mode: "api-key" }),
}));

const origin = "http://127.0.0.1:19781";
const imageUrl = `${origin}/image.png`;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP4sAAAAASUVORK5CYII=",
  "base64",
);
function proxyConfig(
  baseUrl = `${origin}/v1`,
  request: ModelProviderConfig["request"] = { headers: { Cookie: "fixture-session=synthetic" } },
): OpenClawConfig {
  return { models: { providers: { litellm: { baseUrl, models: [], request } } } };
}
const config = proxyConfig();
const provider = buildLitellmImageGenerationProvider();
let payload: unknown;
let redirect: string | undefined;
let downloadBytes: Buffer;
let downloadElapsedMs: number;
const fetchMock = vi.fn<typeof fetch>();
const generate = (cfg = config, overrides: Partial<ImageGenerationRequest> = {}) =>
  provider.generateImage({
    provider: "litellm",
    model: "dall-e-3",
    prompt: "Synthetic square",
    cfg,
    ...overrides,
  });
const imageResponse = (bytes: Uint8Array) =>
  new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png" } });
const headersAt = (index: number) => new Headers(fetchMock.mock.calls[index]?.[1]?.headers);
function expectDownload(url: string) {
  expect(fetchMock.mock.calls[1]?.[0]).toBe(url);
  expect(headersAt(1).has("Authorization")).toBe(false);
  expect(headersAt(1).has("Cookie")).toBe(false);
}

beforeEach(() => {
  payload = { data: [{ url: imageUrl, revised_prompt: "Synthetic square" }] };
  redirect = undefined;
  downloadBytes = png;
  downloadElapsedMs = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url, init) => {
    if (init?.method === "POST") {
      return Response.json(payload);
    }
    if (downloadElapsedMs) {
      vi.setSystemTime(Date.now() + downloadElapsedMs);
    }
    return redirect
      ? new Response(null, { status: 302, headers: { Location: redirect } })
      : imageResponse(downloadBytes);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("LiteLLM image URL responses", () => {
  it.each([
    { name: "same-origin generation", cfg: config, url: imageUrl, edit: false },
    { name: "same-origin edit", cfg: config, url: imageUrl, edit: true },
    {
      name: "public CDN",
      cfg: proxyConfig("https://api.example.com/v1"),
      url: "https://cdn.example.com/image.png",
      edit: false,
    },
  ])("downloads $name URLs without credentials", async ({ cfg, url, edit }) => {
    payload = { data: [{ url, revised_prompt: "Synthetic square" }] };
    const result = await generate(cfg, {
      inputImages: edit ? [{ buffer: png, mimeType: "image/png" }] : undefined,
    });
    expect(result.images).toEqual([
      {
        buffer: png,
        mimeType: "image/png",
        fileName: "image-1.png",
        revisedPrompt: "Synthetic square",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headersAt(0).get("Authorization")).toBe("Bearer fixture-provider-key");
    expect(headersAt(0).get("Cookie")).toBe("fixture-session=synthetic");
    expectDownload(url);
  });

  it.each(["http://127.0.0.2:19781/image.png", "http://127.0.0.1:19782/image.png"])(
    "rejects an unrelated private origin %s before sending a request",
    async (url) => {
      payload = { data: [{ url }] };
      await expect(generate()).rejects.toThrow(/private|blocked|internal/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("rechecks origin trust on redirects", async () => {
    redirect = "http://127.0.0.1:19782/image.png";
    await expect(generate()).rejects.toThrow(/private|blocked|internal/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("allows another private origin only with explicit provider opt-in", async () => {
    const url = "http://127.0.0.1:19782/image.png";
    payload = { data: [{ url }] };
    const result = await generate(proxyConfig(`${origin}/v1`, { allowPrivateNetwork: true }));
    expect(result.images[0]?.buffer).toEqual(png);
    expectDownload(url);
  });

  it("preserves inline bytes and response order", async () => {
    payload = {
      data: [
        {
          b64_json: png.toString("base64"),
          url: "http://127.0.0.2/image.png",
          revised_prompt: "Inline",
        },
        { url: imageUrl, revised_prompt: "URL" },
      ],
    };
    expect(
      (await generate()).images.map(({ buffer, revisedPrompt }) => ({ buffer, revisedPrompt })),
    ).toEqual([
      { buffer: png, revisedPrompt: "Inline" },
      { buffer: png, revisedPrompt: "URL" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps downloads above the configured media cap", async () => {
    const result = await generate({
      ...config,
      agents: { defaults: { mediaMaxMb: 1 / (1024 * 1024) } },
    });
    expect(result.images[0]?.buffer).toEqual(png);
  });

  it("rejects downloads above the generated image download ceiling", async () => {
    downloadBytes = Buffer.alloc(65 * 1024 * 1024);
    await expect(generate()).rejects.toThrow(/exceeds|too large/i);
  });

  it("keeps all downloads within the default operation deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    payload = { data: [{ url: imageUrl }, { url: imageUrl }] };
    downloadElapsedMs = 35_000;
    await expect(generate()).rejects.toThrow(/timed out/i);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
