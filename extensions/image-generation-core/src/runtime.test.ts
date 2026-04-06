import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { ImageGenerationProvider } from "../api.js";
import { generateImage, listRuntimeImageGenerationProviders } from "./runtime.js";

const mocks = vi.hoisted(() => {
  const debug = vi.fn();
  return {
    createSubsystemLogger: vi.fn(() => ({ debug })),
    describeFailoverError: vi.fn(),
    getImageGenerationProvider: vi.fn<
      (providerId: string, config?: OpenClawConfig) => ImageGenerationProvider | undefined
    >(() => undefined),
    getProviderEnvVars: vi.fn<(providerId: string) => string[]>(() => []),
    isFailoverError: vi.fn<(err: unknown) => boolean>(() => false),
    listImageGenerationProviders: vi.fn<(config?: OpenClawConfig) => ImageGenerationProvider[]>(
      () => [],
    ),
    parseImageGenerationModelRef: vi.fn<
      (raw?: string) => { provider: string; model: string } | undefined
    >((raw?: string) => {
      const trimmed = raw?.trim();
      if (!trimmed) {
        return undefined;
      }
      const slash = trimmed.indexOf("/");
      if (slash <= 0 || slash === trimmed.length - 1) {
        return undefined;
      }
      return {
        provider: trimmed.slice(0, slash),
        model: trimmed.slice(slash + 1),
      };
    }),
    resolveAgentModelFallbackValues: vi.fn<(value: unknown) => string[]>(() => []),
    resolveAgentModelPrimaryValue: vi.fn<(value: unknown) => string | undefined>(() => undefined),
    debug,
  };
});

vi.mock("../api.js", () => ({
  createSubsystemLogger: mocks.createSubsystemLogger,
  describeFailoverError: mocks.describeFailoverError,
  getImageGenerationProvider: mocks.getImageGenerationProvider,
  getProviderEnvVars: mocks.getProviderEnvVars,
  isFailoverError: mocks.isFailoverError,
  listImageGenerationProviders: mocks.listImageGenerationProviders,
  parseImageGenerationModelRef: mocks.parseImageGenerationModelRef,
  resolveAgentModelFallbackValues: mocks.resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue: mocks.resolveAgentModelPrimaryValue,
}));
vi.mock(
  "openclaw/plugin-sdk/media-generation-runtime-shared",
  async () => import("../../../src/media-generation/runtime-shared.js"),
);

describe("image-generation runtime", () => {
  beforeEach(() => {
    mocks.createSubsystemLogger.mockClear();
    mocks.describeFailoverError.mockReset();
    mocks.getImageGenerationProvider.mockReset();
    mocks.getProviderEnvVars.mockReset();
    mocks.getProviderEnvVars.mockReturnValue([]);
    mocks.isFailoverError.mockReset();
    mocks.isFailoverError.mockReturnValue(false);
    mocks.listImageGenerationProviders.mockReset();
    mocks.listImageGenerationProviders.mockReturnValue([]);
    mocks.parseImageGenerationModelRef.mockClear();
    mocks.resolveAgentModelFallbackValues.mockReset();
    mocks.resolveAgentModelFallbackValues.mockReturnValue([]);
    mocks.resolveAgentModelPrimaryValue.mockReset();
    mocks.resolveAgentModelPrimaryValue.mockReturnValue(undefined);
    mocks.debug.mockReset();
  });

  it("generates images through the active image-generation provider", async () => {
    const authStore = { version: 1, profiles: {} } as const;
    let seenAuthStore: unknown;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("image-plugin/img-v1");
    const provider: ImageGenerationProvider = {
      id: "image-plugin",
      capabilities: {
        generate: {},
        edit: { enabled: false },
      },
      async generateImage(req: { authStore?: unknown }) {
        seenAuthStore = req.authStore;
        return {
          images: [
            {
              buffer: Buffer.from("png-bytes"),
              mimeType: "image/png",
              fileName: "sample.png",
            },
          ],
          model: "img-v1",
        };
      },
    };
    mocks.getImageGenerationProvider.mockReturnValue(provider);

    const result = await generateImage({
      cfg: {
        agents: {
          defaults: {
            imageGenerationModel: { primary: "image-plugin/img-v1" },
          },
        },
      } as OpenClawConfig,
      prompt: "draw a cat",
      agentDir: "/tmp/agent",
      authStore,
    });

    expect(result.provider).toBe("image-plugin");
    expect(result.model).toBe("img-v1");
    expect(result.attempts).toEqual([]);
    expect(seenAuthStore).toEqual(authStore);
    expect(result.images).toEqual([
      {
        buffer: Buffer.from("png-bytes"),
        mimeType: "image/png",
        fileName: "sample.png",
      },
    ]);
  });

  it("lists runtime image-generation providers through the owner runtime", () => {
    const providers: ImageGenerationProvider[] = [
      {
        id: "image-plugin",
        defaultModel: "img-v1",
        models: ["img-v1", "img-v2"],
        capabilities: {
          generate: {
            supportsResolution: true,
          },
          edit: {
            enabled: true,
            maxInputImages: 3,
          },
          geometry: {
            resolutions: ["1K", "2K"],
          },
        },
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
        }),
      },
    ];
    mocks.listImageGenerationProviders.mockReturnValue(providers);

    expect(listRuntimeImageGenerationProviders({ config: {} as OpenClawConfig })).toEqual(
      providers,
    );
    expect(mocks.listImageGenerationProviders).toHaveBeenCalledWith({} as OpenClawConfig);
  });

  it("explains native image-generation config and provider auth when no model is configured", async () => {
    mocks.listImageGenerationProviders.mockReturnValue([
      {
        id: "google",
        defaultModel: "gemini-3-pro-image-preview",
        isConfigured: () => false,
        capabilities: {
          generate: {},
          edit: { enabled: false },
        },
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
        }),
      },
      {
        id: "openai",
        defaultModel: "gpt-image-1",
        isConfigured: () => false,
        capabilities: {
          generate: {},
          edit: { enabled: false },
        },
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
        }),
      },
    ]);
    mocks.getProviderEnvVars.mockImplementation((providerId: string) => {
      if (providerId === "google") {
        return ["GEMINI_API_KEY", "GOOGLE_API_KEY"];
      }
      if (providerId === "openai") {
        return ["OPENAI_API_KEY"];
      }
      return [];
    });

    const promise = generateImage({ cfg: {} as OpenClawConfig, prompt: "draw a cat" });

    await expect(promise).rejects.toThrow("No image-generation model configured.");
    await expect(promise).rejects.toThrow(
      'Set agents.defaults.imageGenerationModel.primary to a provider/model like "',
    );
    await expect(promise).rejects.toThrow("google: GEMINI_API_KEY / GOOGLE_API_KEY");
    await expect(promise).rejects.toThrow("openai: OPENAI_API_KEY");
  });

  it("does not crash on prototype-like provider ids in auth hints", async () => {
    mocks.listImageGenerationProviders.mockReturnValue([
      {
        id: "__proto__",
        defaultModel: "proto-v1",
        isConfigured: () => false,
        capabilities: {
          generate: {},
          edit: { enabled: false },
        },
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
        }),
      },
    ]);

    await expect(
      generateImage({ cfg: {} as OpenClawConfig, prompt: "draw a cat" }),
    ).rejects.toThrow("No image-generation model configured.");
  });

  it("maps requested size to the closest supported fallback geometry", async () => {
    let seenRequest:
      | {
          size?: string;
          aspectRatio?: string;
          resolution?: string;
        }
      | undefined;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("minimax/image-01");
    mocks.getImageGenerationProvider.mockReturnValue({
      id: "minimax",
      capabilities: {
        generate: {
          supportsSize: false,
          supportsAspectRatio: true,
          supportsResolution: false,
        },
        edit: {
          enabled: true,
          supportsSize: false,
          supportsAspectRatio: true,
          supportsResolution: false,
        },
        geometry: {
          aspectRatios: ["1:1", "16:9"],
        },
      },
      async generateImage(req) {
        seenRequest = {
          size: req.size,
          aspectRatio: req.aspectRatio,
          resolution: req.resolution,
        };
        return {
          images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
          model: "image-01",
        };
      },
    });

    const result = await generateImage({
      cfg: {
        agents: {
          defaults: {
            imageGenerationModel: { primary: "minimax/image-01" },
          },
        },
      } as OpenClawConfig,
      prompt: "draw a cat",
      size: "1280x720",
    });

    expect(seenRequest).toEqual({
      size: undefined,
      aspectRatio: "16:9",
      resolution: undefined,
    });
    expect(result.metadata).toMatchObject({
      requestedSize: "1280x720",
      normalizedAspectRatio: "16:9",
      aspectRatioDerivedFromSize: "16:9",
    });
  });
});
