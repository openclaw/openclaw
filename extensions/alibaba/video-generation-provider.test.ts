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
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import type { VideoGenerationProvider } from "openclaw/plugin-sdk/video-generation";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const { resolveApiKeyForProviderMock, postJsonRequestMock, fetchWithTimeoutMock } =
  getProviderHttpMocks();

let videoProvider: VideoGenerationProvider;
let captured: ReturnType<typeof capturePluginRegistration>;
const authChoice = "alibaba-model-studio-api-key";
const videoRequest = {
  provider: "alibaba",
  model: "wan2.6-t2v",
  prompt: "animate this shot",
  cfg: {},
};

beforeAll(async () => {
  const { default: plugin } = await import("./index.js");
  captured = capturePluginRegistration(plugin);
  const provider = captured.videoGenerationProviders[0];
  if (!provider) {
    throw new Error("expected Alibaba video generation provider");
  }
  videoProvider = provider;
});

installProviderHttpMockCleanup();

const agentDirs = useSessionStoreTempDirs((cleanup) => {
  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    vi.unstubAllEnvs();
    await cleanup();
  });
}, "openclaw-alibaba-wan-auth-");

beforeEach(() => {
  for (const name of ["MODELSTUDIO_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY"]) {
    vi.stubEnv(name, "");
  }
});

function alibabaConfig(
  apiKey: string | { source: "env"; provider: string; id: string },
  auth?: "api-key",
) {
  const alibaba = { apiKey, auth, baseUrl: "https://dashscope-intl.aliyuncs.com", models: [] };
  return { models: { providers: { alibaba } } };
}

it("registers media-only API-key onboarding alongside video generation", async () => {
  expect(captured.videoGenerationProviders.map((provider) => provider.id)).toEqual(["alibaba"]);
  expect(captured.modelCatalogProviders).toEqual([]);
  expect(captured.providers).toHaveLength(1);
  expect(captured.providers[0]).toMatchObject({
    id: "alibaba",
    docsPath: "/providers/alibaba",
    envVars: ["MODELSTUDIO_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY"],
  });

  const choice = resolveProviderPluginChoice({ providers: captured.providers, choice: authChoice });
  expect(choice?.method).toMatchObject({ id: "api-key", starterModel: undefined });
  expect(choice?.wizard?.onboardingScopes).toEqual(["image-generation"]);
  const resolveApiKey = vi.fn(async () => ({ key: "alibaba-test-key", source: "flag" as const }));
  expect(
    await choice?.method.validateNonInteractive?.({
      authChoice,
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
  const envKey = "ALIBABA_QA_CONFIG_KEY";
  vi.stubEnv(envKey, "resolved-alibaba-config-key");
  const cfg = {
    ...alibabaConfig({ source: "env", provider: "test", id: envKey }),
    secrets: {
      defaults: { env: "test" },
      providers: { test: { source: "env" as const, allowlist: [envKey] } },
    },
  };
  expect(await videoProvider.isConfiguredAsync?.({ cfg })).toBe(true);
  vi.stubEnv(envKey, "");
  expect(await videoProvider.isConfiguredAsync?.({ cfg })).toBe(false);
});

it("keeps explicit Standard config above an inherited Coding Plan environment key", async () => {
  vi.stubEnv("QWEN_API_KEY", "sk-sp-qwen-coding-plan-key");
  const cfg = alibabaConfig("sk-ws-alibaba-standard-key", "api-key");
  expect(await videoProvider.isConfiguredAsync?.({ cfg })).toBe(true);
});

it.each([
  ["sk-ws-alibaba-profile", "sk-sp-qwen-environment", true],
  ["sk-sp-alibaba-profile", "sk-ws-qwen-environment", false],
])("preserves actual profile precedence for %s", async (profileKey, envKey, expected) => {
  vi.stubEnv("QWEN_API_KEY", envKey);
  const agentDir = agentDirs.make();
  const profile = { type: "api_key" as const, provider: "alibaba", key: profileKey };
  await expect(
    updateAuthProfileStoreWithLock({
      agentDir,
      saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
      updater(store) {
        store.profiles = { "alibaba:standard": profile };
        return true;
      },
    }),
  ).resolves.not.toBeNull();

  expect(await videoProvider.isConfiguredAsync?.({ cfg: {}, agentDir })).toBe(expected);
});

it("rejects a resolved Coding Plan API key before submitting a Wan request", async () => {
  resolveApiKeyForProviderMock.mockResolvedValueOnce({ apiKey: "sk-sp-qwen-coding-plan-key" });

  await expect(videoProvider.generateVideo(videoRequest)).rejects.toThrow(
    /Standard DashScope endpoint.*same-region Standard API key/i,
  );

  expect(postJsonRequestMock).not.toHaveBeenCalled();
});

it("animates a local image with Wan, polls task status, and downloads the resulting video", async () => {
  mockSuccessfulDashscopeVideoTask({ postJsonRequestMock, fetchWithTimeoutMock });

  const result = await videoProvider.generateVideo({
    ...videoRequest,
    model: "wan2.6-i2v",
    inputImages: [{ buffer: Buffer.from("jpeg-bytes"), mimeType: "image/jpeg" }],
    durationSeconds: 6,
    audio: true,
    watermark: false,
  });

  expect(postJsonRequestMock).toHaveBeenCalledOnce();
  const request = requireFirstPostJsonRequest(postJsonRequestMock, "DashScope request");
  expect(request).toMatchObject({
    url: "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
    body: {
      model: "wan2.6-i2v",
      input: { prompt: "animate this shot", img_url: "data:image/jpeg;base64,anBlZy1ieXRlcw==" },
      parameters: { duration: 6, audio: true, watermark: false },
    },
  });
  expectDashscopeVideoTaskPoll(fetchWithTimeoutMock);
  expectSuccessfulDashscopeVideoResult(result);
});
