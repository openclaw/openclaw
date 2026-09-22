import { resolveConfiguredRealtimeVoiceProvider } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { buildOpenAIRealtimeVoiceProvider as createProvider } from "./realtime-voice-provider-factory.js";
import {
  createOpenAIRealtimeMockState,
  createOpenAIRealtimeTestSupport,
} from "./realtime-voice-test-support.js";

const mocks = createOpenAIRealtimeMockState();
const { isProviderAuthProfileConfiguredMock, resolveProviderAuthProfileApiKeyMock } = mocks;
function buildOpenAIRealtimeVoiceProvider(options?: Parameters<typeof createProvider>[1]) {
  return createProvider(
    {
      ...openAIRealtimeHost,
      isProviderAuthProfileConfigured: isProviderAuthProfileConfiguredMock,
      resolveProviderAuthProfileApiKey: resolveProviderAuthProfileApiKeyMock,
    },
    options,
  );
}
const {
  createTestJwt,
  resetTestState,
  restoreTestEnvironment,
  readInternalRealtimeVoiceProviderApi,
  createQuicksilverBrowserBrokerFixture,
} = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });

describe("OpenAI Talk account defaults", () => {
  beforeEach(resetTestState);
  afterEach(restoreTestEnvironment);

  it.each([
    { name: "fresh", config: {} },
    { name: "existing", config: { voice: "cedar", interruptResponseOnInputAudio: false } },
    { name: "explicit Live", config: { model: "gpt-live-1", voice: "marin" } },
  ])("preserves provider defaults for $name Discord relay configuration", ({ config }) => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const resolved = resolveConfiguredRealtimeVoiceProvider({
      providers: [provider],
      configuredProviderId: provider.id,
      providerConfigs: { openai: { apiKey: "test-api-key-platform", ...config } },
      cfg: {},
      surface: "gateway-relay",
      autoRespondToAudio: true,
      useProviderDefaultModel: true,
    });
    expect(resolved.providerConfig.model).toBe(config.model ?? provider.defaultModel);
    if (config.voice) {
      expect(resolved.providerConfig.voice).toBe(config.voice);
    }
  });

  it.each([
    {
      account: "Platform profile",
      apiProfile: true,
      oauth: false,
      configuredKey: false,
      model: "gpt-live-1",
    },
    {
      account: "ChatGPT profile",
      apiProfile: false,
      oauth: true,
      configuredKey: false,
      model: "gpt-live-1-codex",
    },
    {
      account: "configured Platform key with ChatGPT",
      apiProfile: false,
      oauth: true,
      configuredKey: true,
      model: "gpt-live-1",
    },
  ])(
    "starts audio-only browser Talk with the $account default and matching auth",
    async ({ apiProfile, oauth, configuredKey, model }) => {
      const cfg = {
        agents: { list: [{ id: "voice-agent", agentDir: "/tmp/openclaw-voice-agent" }] },
      };
      const oauthToken = createTestJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
      });
      isProviderAuthProfileConfiguredMock.mockImplementation(
        ({ agentDir, profileTypes }: { agentDir?: string; profileTypes?: readonly string[] }) =>
          agentDir === "/tmp/openclaw-voice-agent" &&
          (profileTypes?.includes("api_key") ? apiProfile : oauth),
      );
      resolveProviderAuthProfileApiKeyMock.mockImplementation(
        async ({ profileTypes }: { profileTypes?: readonly string[] }) =>
          profileTypes?.includes("api_key")
            ? apiProfile
              ? "test-api-key-platform"
              : undefined
            : oauth
              ? oauthToken
              : undefined,
      );
      const { broker, createBrowserSession } = createQuicksilverBrowserBrokerFixture();
      const provider = buildOpenAIRealtimeVoiceProvider({
        quicksilverBrowserSessionBroker: broker,
      });
      const { providerConfig } = resolveConfiguredRealtimeVoiceProvider({
        cfg,
        agentId: "voice-agent",
        surface: "browser-session",
        requiredCapabilities: { supportsVideoFrames: false },
        providers: [provider],
        providerConfigs: { openai: configuredKey ? { apiKey: "test-api-key-platform" } : {} },
      });

      expect(providerConfig.model).toBe(model);
      expect(
        readInternalRealtimeVoiceProviderApi(provider).resolveBrowserSessionCapabilities({
          cfg,
          agentId: "voice-agent",
          providerConfig,
        }),
      ).toMatchObject({ handlesAgentConsult: true, supportsToolCalls: false });
      const request = {
        cfg,
        providerConfig,
        agentId: "voice-agent",
        workspaceDir: "/tmp/openclaw-voice-workspace",
        initialItems: [],
        runAgentConsult: async () => ({ text: "Done" }),
      };
      await provider.createBrowserSession?.(request);
      expect(createBrowserSession).toHaveBeenCalledWith(
        expect.objectContaining({ model }),
        model === "gpt-live-1"
          ? { type: "api-key", token: "test-api-key-platform" }
          : { type: "oauth", token: oauthToken, accountId: "account-123" },
      );
    },
  );

  it.each([
    {
      name: "browser discovery",
      context: { surface: "browser-session" as const },
      rawConfig: {},
      model: "gpt-live-1",
    },
    {
      name: "manual replies",
      context: { autoRespondToAudio: false },
      rawConfig: {},
      model: "gpt-realtime-2.1",
    },
    {
      name: "video",
      context: { requiredCapabilities: { supportsVideoFrames: true } },
      rawConfig: {},
      model: "gpt-realtime-2.1",
    },
    {
      name: "Azure",
      context: {},
      rawConfig: { azureDeployment: "voice-deployment" },
      model: "gpt-realtime-2.1",
    },
    {
      name: "an explicit model",
      context: {},
      rawConfig: { model: "gpt-realtime-2.1-mini" },
      model: "gpt-realtime-2.1-mini",
    },
  ])("preserves $name when resolving Talk defaults", ({ context, rawConfig, model }) => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    expect(
      provider.resolveConfig?.({
        cfg: {},
        rawConfig: { apiKey: "test-api-key-platform", ...rawConfig },
        surface: "gateway-relay",
        ...context,
      })?.model,
    ).toBe(model);
  });
});
