// Preload lazy SDK imports before starting provider deadlines.
import "openclaw/plugin-sdk/image-generation";
import "openclaw/plugin-sdk/provider-http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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
const config: OpenClawConfig = {
  models: {
    providers: {
      litellm: {
        baseUrl: `${origin}/v1`,
        models: [],
        request: { headers: { Cookie: "fixture-session=synthetic" } },
      },
    },
  },
};
const provider = buildLitellmImageGenerationProvider();
let payload: unknown;
let redirect: string | undefined;
const fetchMock = vi.fn<typeof fetch>();
const generate = (cfg = config) =>
  provider.generateImage({
    provider: "litellm",
    model: "dall-e-3",
    prompt: "Synthetic square",
    cfg,
  });

beforeEach(() => {
  payload = { data: [{ url: imageUrl, revised_prompt: "Synthetic square" }] };
  redirect = undefined;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url, init) => {
    if (init?.method === "POST") {
      return Response.json(payload);
    }
    return redirect
      ? new Response(null, { status: 302, headers: { Location: redirect } })
      : new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("LiteLLM image URL responses", () => {
  it.each([false, true])(
    "downloads same-origin URLs without credentials (edit=%s)",
    async (edit) => {
      const result = await provider.generateImage({
        provider: "litellm",
        model: "dall-e-3",
        prompt: "Synthetic square",
        cfg: config,
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
      expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
        "Bearer fixture-provider-key",
      );
      expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Cookie")).toBe(
        "fixture-session=synthetic",
      );
      expect(fetchMock.mock.calls[1]?.[0]).toBe(imageUrl);
      const headers = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
      expect(headers.has("Authorization")).toBe(false);
      expect(headers.has("Cookie")).toBe(false);
    },
  );

  it("downloads public CDN images returned by a DNS provider", async () => {
    const url = "https://cdn.example.com/image.png";
    payload = { data: [{ url }] };
    const result = await generate({
      models: { providers: { litellm: { baseUrl: "https://api.example.com/v1", models: [] } } },
    });
    expect(result.images[0]?.buffer).toEqual(png);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(url);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).has("Authorization")).toBe(false);
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
    const result = await generate({
      models: {
        providers: {
          litellm: { baseUrl: `${origin}/v1`, models: [], request: { allowPrivateNetwork: true } },
        },
      },
    });
    expect(result.images[0]?.buffer).toEqual(png);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(url);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).has("Authorization")).toBe(false);
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
    fetchMock.mockImplementation(async (_url, init) =>
      init?.method === "POST"
        ? Response.json(payload)
        : new Response(new Uint8Array(65 * 1024 * 1024), {
            headers: { "Content-Type": "image/png" },
          }),
    );
    await expect(generate()).rejects.toThrow(/exceeds|too large/i);
  });

  it("keeps all downloads within the default operation deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    payload = { data: [{ url: imageUrl }, { url: imageUrl }] };
    fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method === "POST") {
        return Response.json(payload);
      }
      vi.setSystemTime(Date.now() + 35_000);
      return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
    });
    await expect(generate()).rejects.toThrow(/timed out/i);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
