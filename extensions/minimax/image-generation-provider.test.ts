import type { ImageGenerationRequest } from "openclaw/plugin-sdk/image-generation";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../test-support/model-provider-config.test-support.js";
import { buildMinimaxImageGenerationProvider } from "./image-generation-provider.js";

installPinnedHostnameTestHooks();

function config(provider: string, baseUrl: string, apiKey?: string) {
  return createModelProviderConfig({ [provider]: { baseUrl, models: [], apiKey } });
}

function generateImage(
  overrides: Partial<ImageGenerationRequest> = {},
  payload: unknown = {
    data: { image_base64: [Buffer.from("png-data").toString("base64")] },
    base_resp: { status_code: 0 },
  },
) {
  vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
    apiKey: "minimax-test-key",
    source: "env",
    mode: "api-key",
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));
  const request = {
    provider: "minimax",
    model: "image-01",
    prompt: "draw a cat",
    cfg: {},
    ...overrides,
  };
  return buildMinimaxImageGenerationProvider(request.provider).generateImage(request);
}

describe("minimax image-generation provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MINIMAX_API_HOST", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("advertises minimax-portal image generation using its own config-only credential", async () => {
    const provider = buildMinimaxImageGenerationProvider("minimax-portal");
    const cfg = config("minimax-portal", "https://api.minimax.io/v1", "config-only-key");
    expect(await provider.isConfiguredAsync?.({ cfg })).toBe(true);
  });

  it.each([
    [
      { data: { image_base64: ["not-base64!"] }, base_resp: { status_code: 0 } },
      "MiniMax image generation returned malformed image base64",
    ],
    [
      { base_resp: { status_code: 1000, status_msg: "rpc timeout: timeout=1m0s" } },
      "MiniMax image generation API error (1000): rpc timeout: timeout=1m0s",
    ],
  ] as const)("rejects invalid image response %j", async (payload, message) => {
    await expect(generateImage({}, payload)).rejects.toThrow(message);
  });

  it("passes SSRF and portal request policy to the provider HTTP helper", async () => {
    const postJsonResponse = vi.spyOn(providerHttp, "postJsonResponse");
    await generateImage({
      provider: "minimax-portal",
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      cfg: createModelProviderConfig({
        ...config("minimax", "https://wrong.example/anthropic").models.providers,
        "minimax-portal": {
          baseUrl: "https://api.minimaxi.com/anthropic",
          models: [],
          request: {
            allowPrivateNetwork: true,
            headers: { "X-MiniMax-Image-Policy": "enabled" },
          },
        },
      }),
    });
    expect(postJsonResponse).toHaveBeenCalledOnce();
    const request = postJsonResponse.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      url: "https://api.minimaxi.com/v1/image_generation",
      allowPrivateNetwork: true,
    });
    expect(request?.body).toEqual({
      model: "image-01",
      prompt: "draw a cat",
      response_format: "base64",
      n: 1,
    });
    expect(request?.ssrfPolicy).toEqual({ allowRfc2544BenchmarkRange: true });
    expect(new Headers(request?.headers).get("x-minimax-image-policy")).toBe("enabled");
  });

  it.each([
    ["minimax", "http://127.0.0.1:8080/anthropic", "", "api.minimax.io"],
    ["minimax", "", "https://api.minimaxi.com/anthropic", "api.minimaxi.com"],
    ["minimax-portal", "api.minimaxi.com/anthropic", "", "api.minimaxi.com"],
  ])("resolves image region for %s config=%s env=%s", async (provider, baseUrl, env, host) => {
    vi.stubEnv("MINIMAX_API_HOST", env);
    await generateImage({ provider, cfg: config(provider, baseUrl) });
    expect(fetch).toHaveBeenCalledWith(
      `https://${host}/v1/image_generation`,
      expect.objectContaining({ method: "POST" }),
    );
  });
});
