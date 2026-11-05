// Preload lazy SDK imports before starting provider deadlines.
import "openclaw/plugin-sdk/image-generation";
import "openclaw/plugin-sdk/provider-http";
import type { ImageGenerationRequest } from "openclaw/plugin-sdk/image-generation";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildLitellmImageGenerationProvider } from "./image-generation-provider.js";

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: async () => ({ apiKey: "fixture-provider-key", mode: "api-key" }),
}));

const origin = "http://127.0.0.1:19781";
const imageUrl = `${origin}/image.png`;
const privateUrl = "http://127.0.0.1:19782/image.png";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP4sAAAAASUVORK5CYII=",
  "base64",
);
function proxyConfig(
  baseUrl = `${origin}/v1`,
  request: ModelProviderConfig["request"] = { headers: { Cookie: "fixture-session=synthetic" } },
): ImageGenerationRequest["cfg"] {
  return { models: { providers: { litellm: { baseUrl, models: [], request } } } };
}
const config = proxyConfig();
const provider = buildLitellmImageGenerationProvider();
let images: Array<{ url: string; revised_prompt?: string; b64_json?: string }>;
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
const headersAt = (index: number) => new Headers(fetchMock.mock.calls[index]?.[1]?.headers);
const credentialsAt = (index: number) =>
  ["Authorization", "Cookie"].map((name) => headersAt(index).get(name));

beforeEach(() => {
  images = [{ url: imageUrl, revised_prompt: "Synthetic square" }];
  redirect = undefined;
  downloadBytes = png;
  downloadElapsedMs = 0;
  fetchMock.mockReset().mockImplementation(async (_url, init) => {
    if (init?.method === "POST") {
      return Response.json({ data: images });
    }
    if (downloadElapsedMs) {
      vi.advanceTimersByTime(downloadElapsedMs);
    }
    return redirect
      ? new Response(null, { status: 302, headers: { Location: redirect } })
      : new Response(new Uint8Array(downloadBytes), { headers: { "Content-Type": "image/png" } });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([
  [config, imageUrl, true],
  [proxyConfig("https://api.example.com/v1"), "https://cdn.example.com/image.png", false],
  [proxyConfig(undefined, { allowPrivateNetwork: true }), privateUrl, false],
  [{ ...config, agents: { defaults: { mediaMaxMb: 1 / (1024 * 1024) } } }, imageUrl, false],
] as const)("inlines %j URL %s in order (edit=%s) without credentials", async (cfg, url, edit) => {
  images = [
    { b64_json: png.toString("base64"), url: privateUrl, revised_prompt: "Inline" },
    { url, revised_prompt: "URL" },
  ];
  const result = await generate(cfg, {
    inputImages: edit ? [{ buffer: png, mimeType: "image/png" }] : undefined,
  });
  expect(result.images).toMatchObject([
    { buffer: png, revisedPrompt: "Inline" },
    { buffer: png, revisedPrompt: "URL" },
  ]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(credentialsAt(0)).toEqual([
    "Bearer fixture-provider-key",
    cfg.models?.providers?.litellm?.request?.headers?.Cookie ?? null,
  ]);
  expect(fetchMock.mock.calls[1]?.[0]).toBe(url);
  expect(credentialsAt(1)).toEqual([null, null]);
});

it.each([
  ["http://127.0.0.2:19781/image.png", false, 1],
  [privateUrl, false, 1],
  [privateUrl, true, 2],
] as const)("rejects private origin %s (redirect=%s)", async (url, isRedirect, requests) => {
  if (isRedirect) {
    redirect = url;
  } else {
    images = [{ url }];
  }
  await expect(generate()).rejects.toThrow(/private|blocked|internal/i);
  expect(fetchMock).toHaveBeenCalledTimes(requests);
});

it("rejects downloads above the generated image download ceiling", async () => {
  downloadBytes = Buffer.alloc(65 * 1024 * 1024);
  await expect(generate()).rejects.toThrow(/exceeds|too large/i);
});

it("keeps all downloads within the default operation deadline", async () => {
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
  vi.setSystemTime(0);
  images = [{ url: imageUrl }, { url: imageUrl }];
  downloadElapsedMs = 35_000;
  await expect(generate()).rejects.toThrow(/timed out/i);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
