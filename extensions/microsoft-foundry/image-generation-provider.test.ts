import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type {
  ImageGenerationProvider,
  ImageGenerationRequest,
} from "openclaw/plugin-sdk/image-generation";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { PROVIDER_ID } from "./shared.js";

type ImagePost = Parameters<typeof import("openclaw/plugin-sdk/provider-http").postJsonRequest>[0];
const { http, isConfigured, refreshAuth, resolveAuth } = vi.hoisted(() => ({
  http: {
    postJsonRequest: vi.fn<(request: ImagePost) => unknown>(),
    postMultipartRequest: vi.fn<(request: ImagePost) => unknown>(),
  },
  isConfigured: vi.fn(async () => true),
  refreshAuth: vi.fn(),
  resolveAuth: vi.fn(async () => ({
    apiKey: "foundry-key",
    mode: "api-key" as const,
    profileId: undefined as string | undefined,
  })),
}));

// mock-isolation: Credentials and network I/O stay fixture-controlled; pure HTTP helpers run normally.
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderApiKeyConfiguredAsync: isConfigured,
}));
// mock-isolation: Resolve fixture credentials without reading host authentication storage.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveAuth,
}));
vi.mock("openclaw/plugin-sdk/provider-http", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-http")>(
    "openclaw/plugin-sdk/provider-http",
  );
  return { ...actual, ...http };
});
// mock-isolation: Exercise token refresh outcomes without invoking Azure CLI or host credentials.
vi.mock("./runtime.js", () => ({ prepareFoundryRuntimeAuth: refreshAuth }));

function buildConfig({
  modelId = "image-deployment",
  modelName = "MAI-Image-2.5",
  baseUrl = "https://example.services.ai.azure.com/openai/v1",
  includeModel = true,
  mediaMaxMb,
}: {
  modelId?: string;
  modelName?: string;
  baseUrl?: string;
  includeModel?: boolean;
  mediaMaxMb?: number;
} = {}): OpenClawConfig {
  const model = {
    id: modelId,
    name: modelName,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 0,
  };
  const provider = {
    baseUrl,
    api: "openai-completions" as const,
    models: includeModel ? [model] : [],
    request: { headers: { "Content-Type": "application/json" } },
  };
  return {
    ...(mediaMaxMb !== undefined ? { agents: { defaults: { mediaMaxMb } } } : {}),
    models: { providers: { [PROVIDER_ID]: provider } },
  };
}

function imageResponse(base64 = Buffer.from("png").toString("base64")) {
  return {
    response: Response.json({ data: [{ b64_json: base64 }] }),
    release: vi.fn(async () => {}),
  };
}

function registerImageProvider() {
  const register = vi.fn<(provider: ImageGenerationProvider) => void>();
  plugin.register(createTestPluginApi({ registerImageGenerationProvider: register }));
  return expectDefined(register.mock.calls[0]?.[0], "Microsoft Foundry image provider");
}

function generateImage(overrides: Partial<ImageGenerationRequest> = {}) {
  return registerImageProvider().generateImage({
    provider: PROVIDER_ID,
    model: "image-deployment",
    prompt: "draw it",
    cfg: buildConfig(),
    ...overrides,
  });
}

function requireRequest(mock = http.postJsonRequest) {
  return expectDefined(mock.mock.calls[0]?.[0], "Microsoft Foundry image request");
}

const inputImage = { buffer: Buffer.from("input"), mimeType: "image/png" };
describe("microsoft foundry image generation provider", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    http.postJsonRequest.mockImplementation(async () => imageResponse());
  });
  afterEach(() => {
    vi.clearAllMocks();
    http.postJsonRequest.mockReset();
    http.postMultipartRequest.mockReset();
    refreshAuth.mockReset();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("exposes MAI image provider metadata and capabilities", async () => {
    const provider = registerImageProvider();
    const cfg = buildConfig();
    expect(provider).toMatchObject({ id: PROVIDER_ID, models: [] });
    expect(provider.defaultModel).toBeUndefined();
    expect(provider.capabilities.geometry?.sizes).toBeUndefined();
    expect(provider.capabilities).toMatchObject({
      generate: { maxCount: 1 },
      edit: { enabled: true, maxInputImages: 1 },
      output: { formats: ["png"] },
    });
    expect(await provider.isConfiguredAsync?.({ agentDir: "/agent", cfg })).toBe(true);
    expect(isConfigured).toHaveBeenCalledWith({ provider: PROVIDER_ID, agentDir: "/agent", cfg });
  });

  it.each([
    ["image-deployment", "MAI-Image-2.5", true, "768x1365", 768, 1365, false],
    ["prod-image", "prod-image", false, "800x1000", 800, 1000, false],
    ["mai-image-2-live", "mai-image-2-live", false, undefined, 1024, 1024, false],
    ["prod-image", "prod-image", true, undefined, 1024, 1024, false],
    ["image-deployment", "MAI-Image-2.5", true, undefined, 1024, 1024, true],
  ] as const)(
    "generates %s (%s, metadata=%s, size=%s)",
    async (model, modelName, includeModel, size, width, height, fromEnv) => {
      if (fromEnv) {
        vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://env.services.ai.azure.com");
      }
      const cfg = buildConfig({
        modelId: model,
        modelName,
        includeModel,
        ...(fromEnv ? { baseUrl: "" } : {}),
      });
      const result = await generateImage({
        model,
        cfg,
        size,
        timeoutMs: fromEnv ? undefined : 12_345,
        ssrfPolicy: { allowPrivateNetwork: true },
      });
      const request = requireRequest();
      expect(request).toMatchObject({
        url: `https://${fromEnv ? "env" : "example"}.services.ai.azure.com/mai/v1/images/generations`,
        timeoutMs: fromEnv ? 600_000 : 12_345,
        allowPrivateNetwork: false,
        ssrfPolicy: { allowPrivateNetwork: true },
      });
      expect(Object.fromEntries(request.headers.entries())).toEqual({
        "api-key": "foundry-key",
        "content-type": "application/json",
      });
      expect(request.body).toEqual({ model, prompt: "draw it", width, height });
      expect(result).toMatchObject({
        model,
        images: [{ buffer: Buffer.from("png"), mimeType: "image/png" }],
      });
    },
  );

  it("honors configured generated media caps above the default image limit", async () => {
    const imageBytes = Buffer.alloc(7 * 1024 * 1024, 1);
    http.postJsonRequest.mockResolvedValue(imageResponse(imageBytes.toString("base64")));

    const result = await generateImage({ cfg: buildConfig({ mediaMaxMb: 8 }) });

    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.buffer.byteLength).toBe(imageBytes.byteLength);
  });

  it("rejects oversized MAI image JSON responses", async () => {
    // One image result: the bound is the 64 MiB download ceiling as base64.
    http.postJsonRequest.mockResolvedValue(imageResponse("x".repeat(90 * 1024 * 1024)));

    await expect(generateImage()).rejects.toThrow(
      "microsoft-foundry.image-generation: JSON response exceeds",
    );
  });

  it("refreshes Entra ID auth and sends MAI image edits as multipart form data", async () => {
    resolveAuth.mockResolvedValueOnce({
      apiKey: "__entra_id_dynamic__",
      mode: "api-key",
      profileId: "microsoft-foundry:entra",
    });
    refreshAuth.mockResolvedValueOnce({
      apiKey: "entra-token",
      baseUrl: "https://example.services.ai.azure.com/openai/v1",
    });
    http.postMultipartRequest.mockResolvedValue(
      imageResponse(Buffer.from("edited").toString("base64")),
    );

    const result = await generateImage({
      agentDir: "/agent",
      inputImages: [{ ...inputImage, fileName: "input.png" }],
    });

    expect(refreshAuth.mock.calls[0]?.[0]).toMatchObject({
      agentDir: "/agent",
      provider: PROVIDER_ID,
      modelId: "image-deployment",
      apiKey: "__entra_id_dynamic__",
      authMode: "api-key",
      profileId: "microsoft-foundry:entra",
    });
    const request = requireRequest(http.postMultipartRequest);
    expect(request.url).toBe("https://example.services.ai.azure.com/mai/v1/images/edits");
    expect(Object.fromEntries(request.headers.entries())).toEqual({
      authorization: "Bearer entra-token",
    });
    const form = request.body as FormData;
    expect([form.get("model"), form.get("prompt")]).toEqual(["image-deployment", "draw it"]);
    const image = form.get("image");
    expect(image).toBeInstanceOf(Blob);
    expect(image).toMatchObject({ name: "input.png", type: "image/png" });
    expect(result.images[0]?.buffer.toString()).toBe("edited");
  });

  it.each([
    ["", "MAI-Image-2.5", false, "requires a deployment name"],
    ["x", "MAI-Image-2e", true, "MAI-Image-2e does not support Microsoft Foundry MAI image edits."],
    ["prod-image", undefined, true, "edits require MAI-Image-2.5 model metadata"],
    ["gpt-deployment", "gpt-5.4", false, 'supports MAI image deployments only, got "gpt-5.4"'],
    ["MAI-DS-R1", undefined, false, 'supports MAI image deployments only, got "MAI-DS-R1"'],
  ] as const)("rejects %s / %s before auth (edit=%s)", async (model, modelName, edit, error) => {
    await expect(
      generateImage({
        model,
        cfg: buildConfig({ modelId: model, modelName, includeModel: modelName !== undefined }),
        ...(edit ? { inputImages: [inputImage] } : {}),
      }),
    ).rejects.toThrow(error);
    expect(resolveAuth).not.toHaveBeenCalled();
    expect(edit ? http.postMultipartRequest : http.postJsonRequest).not.toHaveBeenCalled();
  });

  it("rejects MAI image sizes outside Microsoft Foundry limits", async () => {
    await expect(generateImage({ size: "512x512" })).rejects.toThrow("at least 768x768");
    expect(http.postJsonRequest).not.toHaveBeenCalled();
  });
});
