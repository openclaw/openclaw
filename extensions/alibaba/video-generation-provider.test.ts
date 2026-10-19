import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearRuntimeAuthProfileStoreSnapshots } from "openclaw/plugin-sdk/agent-runtime";
import {
  capturePluginRegistration,
  createRuntimeEnv,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { updateAuthProfileStoreWithLock } from "openclaw/plugin-sdk/provider-auth";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  requireFirstPostJsonRecordRequest as requireFirstPostJsonRequest,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import {
  expectDashscopeVideoTaskPoll,
  expectSuccessfulDashscopeVideoResult,
  mockSuccessfulDashscopeVideoTask,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import type { VideoGenerationProvider } from "openclaw/plugin-sdk/video-generation";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { resolveApiKeyForProviderMock, postJsonRequestMock, fetchWithTimeoutMock } =
  getProviderHttpMocks();

let alibabaVideoGenerationProvider: VideoGenerationProvider;

beforeAll(async () => {
  const { default: plugin } = await import("./index.js");
  const provider = capturePluginRegistration(plugin).videoGenerationProviders[0];
  if (!provider) {
    throw new Error("expected Alibaba video generation provider");
  }
  alibabaVideoGenerationProvider = provider;
});

installProviderHttpMockCleanup();

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  vi.unstubAllEnvs();
});

function clearAlibabaAuthEnvironment(): void {
  for (const name of ["MODELSTUDIO_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY"]) {
    vi.stubEnv(name, "");
  }
}

const requireRecord = createRequireRecord("record", "expected-label-record");

describe("alibaba video generation provider", () => {
  it("registers media-only API-key onboarding alongside video generation", async () => {
    const { default: plugin } = await import("./index.js");
    const captured = capturePluginRegistration(plugin);

    expect(captured.videoGenerationProviders.map((provider) => provider.id)).toEqual(["alibaba"]);
    expect(captured.modelCatalogProviders).toEqual([]);
    expect(captured.providers).toHaveLength(1);
    expect(captured.providers[0]).toMatchObject({
      id: "alibaba",
      docsPath: "/providers/alibaba",
      envVars: ["MODELSTUDIO_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY"],
    });

    const choice = resolveProviderPluginChoice({
      providers: captured.providers,
      choice: "alibaba-model-studio-api-key",
    });
    expect(choice?.method.id).toBe("api-key");
    expect(choice?.method.starterModel).toBeUndefined();
    expect(choice?.wizard?.onboardingScopes).toEqual(["image-generation"]);
    if (!choice?.method.validateNonInteractive) {
      throw new Error("expected Alibaba non-interactive API-key validation");
    }

    const resolveApiKey = vi.fn(async () => ({ key: "alibaba-test-key", source: "flag" as const }));
    expect(
      await choice.method.validateNonInteractive({
        authChoice: "alibaba-model-studio-api-key",
        config: {},
        baseConfig: {},
        opts: { alibabaModelStudioApiKey: "alibaba-test-key" },
        runtime: createRuntimeEnv(),
        resolveApiKey,
      }),
    ).toBe(true);
    expect(resolveApiKey).toHaveBeenCalledWith({
      provider: "alibaba",
      flagValue: "alibaba-test-key",
      flagName: "--alibaba-model-studio-api-key",
      envVar: "MODELSTUDIO_API_KEY",
    });
  });

  it("tracks whether an allowed Alibaba API-key SecretRef resolves", async () => {
    clearAlibabaAuthEnvironment();
    vi.stubEnv("ALIBABA_QA_CONFIG_KEY", "resolved-alibaba-config-key");

    const cfg = {
      models: {
        providers: {
          alibaba: {
            apiKey: {
              source: "env" as const,
              provider: "alibaba-test-env",
              id: "ALIBABA_QA_CONFIG_KEY",
            },
            baseUrl: "https://dashscope-intl.aliyuncs.com",
            models: [],
          },
        },
      },
      secrets: {
        defaults: { env: "alibaba-test-env" },
        providers: {
          "alibaba-test-env": {
            source: "env" as const,
            allowlist: ["ALIBABA_QA_CONFIG_KEY"],
          },
        },
      },
    };

    expect(await alibabaVideoGenerationProvider.isConfiguredAsync?.({ cfg })).toBe(true);
    vi.stubEnv("ALIBABA_QA_CONFIG_KEY", "");
    expect(await alibabaVideoGenerationProvider.isConfiguredAsync?.({ cfg })).toBe(false);
  });

  it("keeps explicit Standard config above an inherited Coding Plan environment key", async () => {
    clearAlibabaAuthEnvironment();
    vi.stubEnv("QWEN_API_KEY", "sk-sp-qwen-coding-plan-key");

    expect(
      await alibabaVideoGenerationProvider.isConfiguredAsync?.({
        cfg: {
          models: {
            providers: {
              alibaba: {
                auth: "api-key",
                apiKey: "sk-ws-alibaba-standard-key",
                baseUrl: "https://dashscope-intl.aliyuncs.com",
                models: [],
              },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it.each([
    ["sk-ws-alibaba-profile", "sk-sp-qwen-environment", true],
    ["sk-sp-alibaba-profile", "sk-ws-qwen-environment", false],
  ])("preserves actual profile precedence for %s", async (profileKey, envKey, expected) => {
    clearAlibabaAuthEnvironment();
    vi.stubEnv("QWEN_API_KEY", envKey);
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-alibaba-wan-auth-"));

    try {
      await expect(
        updateAuthProfileStoreWithLock({
          agentDir,
          saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
          updater(store) {
            store.profiles = {
              "alibaba:standard": {
                type: "api_key",
                provider: "alibaba",
                key: profileKey,
              },
            };
            return true;
          },
        }),
      ).resolves.not.toBeNull();

      expect(await alibabaVideoGenerationProvider.isConfiguredAsync?.({ cfg: {}, agentDir })).toBe(
        expected,
      );
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      // Release the worker's database handles before Windows removes the temporary directory.
      await closeOpenClawAgentDatabasesAsync();
      await fs.rm(agentDir, { force: true, recursive: true });
    }
  });

  it("rejects a resolved Coding Plan API key before submitting a Wan request", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({ apiKey: "sk-sp-qwen-coding-plan-key" });

    await expect(
      alibabaVideoGenerationProvider.generateVideo({
        provider: "alibaba",
        model: "wan2.6-t2v",
        prompt: "animate this shot",
        cfg: {},
      }),
    ).rejects.toThrow(/Standard DashScope endpoint.*same-region Standard API key/i);

    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("animates a local image with Wan, polls task status, and downloads the resulting video", async () => {
    mockSuccessfulDashscopeVideoTask({ postJsonRequestMock, fetchWithTimeoutMock });

    const result = await alibabaVideoGenerationProvider.generateVideo({
      provider: "alibaba",
      model: "wan2.6-i2v",
      prompt: "animate this shot",
      cfg: {},
      inputImages: [{ buffer: Buffer.from("jpeg-bytes"), mimeType: "image/jpeg" }],
      durationSeconds: 6,
      audio: true,
      watermark: false,
    });

    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    const request = requireFirstPostJsonRequest(postJsonRequestMock, "DashScope request");
    expect(request.url).toBe(
      "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
    );
    const body = requireRecord(request.body, "DashScope request body");
    expect(body.model).toBe("wan2.6-i2v");
    const input = requireRecord(body.input, "DashScope request input");
    expect(input.prompt).toBe("animate this shot");
    expect(input.img_url).toBe("data:image/jpeg;base64,anBlZy1ieXRlcw==");
    const parameters = requireRecord(body.parameters, "DashScope request parameters");
    expect(parameters.duration).toBe(6);
    expect(parameters.audio).toBe(true);
    expect(parameters.watermark).toBe(false);
    expectDashscopeVideoTaskPoll(fetchWithTimeoutMock);
    expectSuccessfulDashscopeVideoResult(result);
  });
});
