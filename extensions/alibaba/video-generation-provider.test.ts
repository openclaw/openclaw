import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  capturePluginRegistration,
  createRuntimeEnv,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
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
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { resolveApiKeyForProviderMock, postJsonRequestMock, fetchWithTimeoutMock } =
  getProviderHttpMocks();

let alibabaVideoGenerationProvider: typeof import("./video-generation-provider.js").alibabaVideoGenerationProvider;

beforeAll(async () => {
  ({ alibabaVideoGenerationProvider } = await import("./video-generation-provider.js"));
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

  it("advertises Wan video generation with a config-only Standard API key", () => {
    clearAlibabaAuthEnvironment();

    expect(
      alibabaVideoGenerationProvider.isConfigured?.({
        cfg: {
          models: {
            providers: {
              alibaba: {
                apiKey: "sk-alibaba-legacy-standard-key",
                baseUrl: "https://dashscope-intl.aliyuncs.com",
                models: [],
              },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("does not use Qwen Coding Plan credentials for Alibaba video discovery", () => {
    clearAlibabaAuthEnvironment();

    expect(
      alibabaVideoGenerationProvider.isConfigured?.({
        cfg: {
          models: {
            providers: {
              qwen: {
                apiKey: "qwen-coding-plan-key",
                baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
                models: [],
              },
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("tracks whether an allowed Alibaba API-key SecretRef resolves", () => {
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

    expect(alibabaVideoGenerationProvider.isConfigured?.({ cfg })).toBe(true);
    vi.stubEnv("ALIBABA_QA_CONFIG_KEY", "");
    expect(alibabaVideoGenerationProvider.isConfigured?.({ cfg })).toBe(false);
  });

  it("preserves Alibaba environment API-key discovery", () => {
    clearAlibabaAuthEnvironment();
    vi.stubEnv("MODELSTUDIO_API_KEY", "alibaba-environment-key");

    expect(alibabaVideoGenerationProvider.isConfigured?.({ cfg: {} })).toBe(true);
  });

  it("does not advertise an inherited Qwen Coding Plan API key", () => {
    clearAlibabaAuthEnvironment();
    vi.stubEnv("QWEN_API_KEY", "sk-sp-qwen-coding-plan-key");

    expect(alibabaVideoGenerationProvider.isConfigured?.({ cfg: {} })).toBe(false);
  });

  it("keeps explicit Standard config above an inherited Coding Plan environment key", () => {
    clearAlibabaAuthEnvironment();
    vi.stubEnv("QWEN_API_KEY", "sk-sp-qwen-coding-plan-key");

    expect(
      alibabaVideoGenerationProvider.isConfigured?.({
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
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "alibaba:standard": {
              type: "api_key",
              provider: "alibaba",
              key: profileKey,
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false, syncExternalCli: false },
      );

      expect(alibabaVideoGenerationProvider.isConfigured?.({ cfg: {}, agentDir })).toBe(expected);
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      // Saving the profile store opens the per-agent database under the temporary agent
      // dir, and clearing the snapshots does not release it, so Windows fails the removal
      // with EBUSY unless the cached handles are closed first.
      closeOpenClawAgentDatabasesForTest();
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

  it("submits async Wan generation, polls task status, and downloads the resulting video", async () => {
    mockSuccessfulDashscopeVideoTask({ postJsonRequestMock, fetchWithTimeoutMock });

    const result = await alibabaVideoGenerationProvider.generateVideo({
      provider: "alibaba",
      model: "wan2.6-r2v-flash",
      prompt: "animate this shot",
      cfg: {},
      inputImages: [{ url: "https://example.com/ref.png" }],
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
    expect(body.model).toBe("wan2.6-r2v-flash");
    const input = requireRecord(body.input, "DashScope request input");
    expect(input.prompt).toBe("animate this shot");
    expect(input.reference_urls).toEqual(["https://example.com/ref.png"]);
    const parameters = requireRecord(body.parameters, "DashScope request parameters");
    expect(parameters.duration).toBe(6);
    expect(parameters.audio).toBe(true);
    expect(parameters.watermark).toBe(false);
    expectDashscopeVideoTaskPoll(fetchWithTimeoutMock);
    expectSuccessfulDashscopeVideoResult(result);
  });
});
