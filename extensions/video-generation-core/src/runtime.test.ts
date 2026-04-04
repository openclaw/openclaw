import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { VideoGenerationProvider } from "../api.js";
import { generateVideo, listRuntimeVideoGenerationProviders } from "./runtime.js";

const mocks = vi.hoisted(() => {
  const debug = vi.fn();
  return {
    createSubsystemLogger: vi.fn(() => ({ debug })),
    describeFailoverError: vi.fn(),
    getProviderEnvVars: vi.fn<(providerId: string) => string[]>(() => []),
    getVideoGenerationProvider: vi.fn<
      (providerId: string, config?: OpenClawConfig) => VideoGenerationProvider | undefined
    >(() => undefined),
    isFailoverError: vi.fn<(err: unknown) => boolean>(() => false),
    listVideoGenerationProviders: vi.fn<(config?: OpenClawConfig) => VideoGenerationProvider[]>(
      () => [],
    ),
    parseVideoGenerationModelRef: vi.fn<
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
  getProviderEnvVars: mocks.getProviderEnvVars,
  getVideoGenerationProvider: mocks.getVideoGenerationProvider,
  isFailoverError: mocks.isFailoverError,
  listVideoGenerationProviders: mocks.listVideoGenerationProviders,
  parseVideoGenerationModelRef: mocks.parseVideoGenerationModelRef,
  resolveAgentModelFallbackValues: mocks.resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue: mocks.resolveAgentModelPrimaryValue,
}));

describe("video-generation runtime", () => {
  beforeEach(() => {
    mocks.createSubsystemLogger.mockClear();
    mocks.describeFailoverError.mockReset();
    mocks.getProviderEnvVars.mockReset();
    mocks.getProviderEnvVars.mockReturnValue([]);
    mocks.getVideoGenerationProvider.mockReset();
    mocks.isFailoverError.mockReset();
    mocks.isFailoverError.mockReturnValue(false);
    mocks.listVideoGenerationProviders.mockReset();
    mocks.listVideoGenerationProviders.mockReturnValue([]);
    mocks.parseVideoGenerationModelRef.mockClear();
    mocks.resolveAgentModelFallbackValues.mockReset();
    mocks.resolveAgentModelFallbackValues.mockReturnValue([]);
    mocks.resolveAgentModelPrimaryValue.mockReset();
    mocks.resolveAgentModelPrimaryValue.mockReturnValue(undefined);
    mocks.debug.mockReset();
  });

  it("generates videos through the active video-generation provider", async () => {
    const authStore = { version: 1, profiles: {} } as const;
    let seenAuthStore: unknown;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("video-plugin/vid-v1");
    const provider: VideoGenerationProvider = {
      id: "video-plugin",
      capabilities: {},
      async generateVideo(req: { authStore?: unknown }) {
        seenAuthStore = req.authStore;
        return {
          videos: [
            {
              buffer: Buffer.from("mp4-bytes"),
              mimeType: "video/mp4",
              fileName: "sample.mp4",
            },
          ],
          model: "vid-v1",
        };
      },
    };
    mocks.getVideoGenerationProvider.mockReturnValue(provider);

    const result = await generateVideo({
      cfg: {
        agents: {
          defaults: {
            videoGenerationModel: { primary: "video-plugin/vid-v1" },
          },
        },
      } as OpenClawConfig,
      prompt: "animate a cat",
      agentDir: "/tmp/agent",
      authStore,
    });

    expect(result.provider).toBe("video-plugin");
    expect(result.model).toBe("vid-v1");
    expect(result.attempts).toEqual([]);
    expect(seenAuthStore).toEqual(authStore);
    expect(result.videos).toEqual([
      {
        buffer: Buffer.from("mp4-bytes"),
        mimeType: "video/mp4",
        fileName: "sample.mp4",
      },
    ]);
  });

  it("lists runtime video-generation providers through the owner runtime", () => {
    const providers: VideoGenerationProvider[] = [
      {
        id: "video-plugin",
        defaultModel: "vid-v1",
        models: ["vid-v1"],
        capabilities: {
          supportsAudio: true,
        },
        generateVideo: async () => ({
          videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
        }),
      },
    ];
    mocks.listVideoGenerationProviders.mockReturnValue(providers);

    expect(listRuntimeVideoGenerationProviders({ config: {} as OpenClawConfig })).toEqual(
      providers,
    );
    expect(mocks.listVideoGenerationProviders).toHaveBeenCalledWith({} as OpenClawConfig);
  });

  it("explains native video-generation config and provider auth when no model is configured", async () => {
    mocks.listVideoGenerationProviders.mockReturnValue([
      {
        id: "qwen",
        defaultModel: "wan2.6-t2v",
        capabilities: {},
        generateVideo: async () => ({
          videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
        }),
      },
    ]);
    mocks.getProviderEnvVars.mockReturnValue(["QWEN_API_KEY"]);

    const promise = generateVideo({ cfg: {} as OpenClawConfig, prompt: "animate a cat" });

    await expect(promise).rejects.toThrow("No video-generation model configured.");
    await expect(promise).rejects.toThrow(
      'Set agents.defaults.videoGenerationModel.primary to a provider/model like "',
    );
    await expect(promise).rejects.toThrow("qwen: QWEN_API_KEY");
  });
});
