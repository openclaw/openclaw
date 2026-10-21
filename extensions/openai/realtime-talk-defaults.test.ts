import { resolveConfiguredRealtimeVoiceProviderAsync } from "openclaw/plugin-sdk/realtime-voice";
import type { InternalRealtimeVoiceBrowserSessionCreateRequest } from "openclaw/plugin-sdk/realtime-voice-provider";
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
      isProviderAuthProfileConfiguredAsync: isProviderAuthProfileConfiguredMock,
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
    { name: "existing", config: { voice: "cedar", interruptResponseOnInputAudio: false } },
    { name: "explicit Live", config: { model: "gpt-live-1", voice: "marin" } },
  ])("preserves provider defaults for $name Discord relay configuration", async ({ config }) => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const resolved = await resolveConfiguredRealtimeVoiceProviderAsync({
      providers: [provider],
      configuredProviderId: provider.id,
      providerConfigs: { openai: { apiKey: "test-api-key-platform", ...config } },
      cfg: {},
      surface: "gateway-relay",
      autoRespondToAudio: true,
      useProviderDefaultModel: true,
    });
    expect(resolved.providerConfig.model).toBe(config.model ?? provider.defaultModel);
    expect(resolved.providerConfig.voice).toBe(config.voice);
  });

  it.each([
    ["Platform profile", true, false, false, "gpt-live-1"],
    ["ChatGPT profile", false, true, false, "gpt-live-1-codex"],
    ["configured Platform key with ChatGPT", false, true, true, "gpt-live-1"],
  ] as const)(
    "starts browser Talk with the %s default and matching auth",
    async (_account, apiProfile, oauth, configuredKey, model) => {
      const cfg = {
        agents: { entries: { "voice-agent": { agentDir: "/tmp/openclaw-voice-agent" } } },
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
      const { providerConfig } = await resolveConfiguredRealtimeVoiceProviderAsync({
        cfg,
        agentId: "voice-agent",
        surface: "browser-session",
        requiredCapabilities: { supportsVideoFrames: false },
        providers: [provider],
        providerConfigs: { openai: configuredKey ? { apiKey: "test-api-key-platform" } : {} },
      });

      expect(providerConfig.model).toBe(model);
      const sessionContext = { cfg, agentId: "voice-agent", providerConfig };
      const api = readInternalRealtimeVoiceProviderApi(provider);
      const capabilities = await api.resolveBrowserSessionCapabilitiesAsync(sessionContext);
      expect(capabilities).toMatchObject({ handlesAgentConsult: true, supportsToolCalls: false });
      const request: InternalRealtimeVoiceBrowserSessionCreateRequest = {
        ...sessionContext,
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
    ["manual replies", { autoRespondToAudio: false }, {}],
    ["video", { requiredCapabilities: { supportsVideoFrames: true } }, {}],
    ["Azure", {}, { azureDeployment: "voice-deployment" }],
  ] as const)("preserves %s when resolving Talk defaults", async (_name, context, rawConfig) => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const config = await provider.resolveConfigAsync?.({
      cfg: {},
      rawConfig: { apiKey: "test-api-key-platform", ...rawConfig },
      surface: "gateway-relay",
      ...context,
    });
    expect(config?.model).toBe("gpt-realtime-2.1");
  });
});
