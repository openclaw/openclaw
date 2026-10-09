import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectRealtimeVoicePublicProjection } from "./provider-policy-api.js";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";
import { createOpenAIRealtimeTestSupport } from "./realtime-voice-test-support.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: mocks.execFileSyncMock,
}));
vi.mock("ws", () => ({ default: mocks.FakeWebSocket }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuardMock,
}));
vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  isProviderAuthProfileConfigured: mocks.isProviderAuthProfileConfiguredMock,
  resolveProviderAuthProfileApiKey: mocks.resolveProviderAuthProfileApiKeyMock,
}));
const { isProviderAuthProfileConfiguredMock } = mocks;
const {
  resetTestState,
  restoreTestEnvironment,
  readInternalRealtimeVoiceProviderApi,
  createQuicksilverBrowserBrokerFixture,
} = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });
const OPAQUE_REALTIME_MODEL = "gpt-live-test-canary";

describe("OpenAI realtime public projection", () => {
  beforeEach(() => resetTestState());
  afterEach(() => restoreTestEnvironment());

  it("preserves native Talk for forced agent consult", () => {
    const config = { model: "gpt-live-1-codex", consultRouting: "force-agent-consult" };
    expect(projectRealtimeVoicePublicProjection({ providerConfig: config, config })).toEqual({
      config,
      clientHints: { gatewayRelaySupported: false },
    });
  });

  it.each([false, true])(
    "advertises the subscription relay capability independently of OAuth readiness=%s",
    (hasOAuth) => {
      isProviderAuthProfileConfiguredMock.mockImplementation(
        ({ profileTypes }: { profileTypes?: readonly string[] }) =>
          hasOAuth && profileTypes?.includes("oauth") === true,
      );
      const internalApi = readInternalRealtimeVoiceProviderApi(buildOpenAIRealtimeVoiceProvider());
      const providerConfig = { model: "gpt-live-1-codex" };

      expect(
        internalApi.projectPublicProjection({ providerConfig, config: providerConfig }),
      ).toEqual({
        config: providerConfig,
        clientHints: { gatewayRelaySupported: true },
      });
      expect(internalApi.isGatewayRelayConfigured({ providerConfig, agentId: "main" })).toBe(
        hasOAuth,
      );
      for (const [azureConfig, supportsRelay] of [
        [{ azureEndpoint: " https://example.openai.azure.com " }, false],
        [{ azureDeployment: " live-deployment " }, false],
        [{ baseUrl: " wss://voice.example.test/realtime " }, false],
        [{ baseUrl: " " }, true],
        [{ azureEndpoint: "", azureDeployment: " \t " }, true],
        [{ azureEndpoint: " \t ", azureDeployment: "" }, true],
      ] as const) {
        const azureProviderConfig = { ...providerConfig, ...azureConfig };
        expect(
          internalApi.projectPublicProjection({
            providerConfig: azureProviderConfig,
            config: providerConfig,
          }),
        ).toEqual({
          config: providerConfig,
          clientHints: { gatewayRelaySupported: supportsRelay },
        });
        expect(
          internalApi.isGatewayRelayConfigured({
            providerConfig: azureProviderConfig,
            agentId: "main",
          }),
        ).toBe(hasOAuth && supportsRelay);
      }
    },
  );

  it("admits opaque realtime models without publishing them", () => {
    const { broker } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });
    const internalApi = readInternalRealtimeVoiceProviderApi(provider);
    const providerConfig = {
      apiKey: "test-api-key-platform",
      model: OPAQUE_REALTIME_MODEL,
    };

    expect(provider.models).not.toContain(OPAQUE_REALTIME_MODEL);
    expect(
      internalApi.isGatewayRelayConfigured({
        providerConfig,
        agentId: "main",
      }),
    ).toBe(true);
    expect(
      internalApi.resolveGatewayRelayCapabilities({
        providerConfig,
        model: OPAQUE_REALTIME_MODEL,
      }),
    ).toMatchObject({
      handlesAgentConsult: true,
      supportsToolCalls: false,
      voices: ["marin", "cedar"],
      voiceSelectionPolicy: "allowlist-default",
    });
    expect(
      internalApi.projectPublicProjection({
        providerConfig,
        config: { model: OPAQUE_REALTIME_MODEL, voice: "marin" },
      }),
    ).toEqual({
      config: { voice: "marin" },
      clientHints: { modelSource: "gateway", gatewayRelaySupported: false },
    });
    expect(
      internalApi.projectPublicProjection({
        providerConfig: { model: "gpt-realtime-2.1" },
        config: { model: "gpt-realtime-2.1", voice: "marin" },
      }),
    ).toEqual({ config: { model: "gpt-realtime-2.1", voice: "marin" } });
  });

  it.each([
    {
      model: "gpt-live-1",
      selectedVoice: "quartz",
      voices: [
        "alloy",
        "ash",
        "ballad",
        "beacon",
        "bossa",
        "cedar",
        "cinder",
        "coral",
        "delta",
        "echo",
        "gleam",
        "marin",
        "meridian",
        "quartz",
        "ripple",
        "sage",
        "shimmer",
        "stone",
        "tempo",
        "verse",
        "vesper",
        "willow",
      ],
    },
    {
      model: "gpt-live-1-codex",
      selectedVoice: "spruce",
      voices: ["arbor", "breeze", "cove", "ember", "juniper", "maple", "sol", "spruce", "vale"],
    },
  ])("publishes $model with its own catalog voice profile", ({ model, selectedVoice, voices }) => {
    const { broker } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });
    const internalApi = readInternalRealtimeVoiceProviderApi(provider);

    expect(provider.models).toContain(model);
    expect(provider.capabilities).toMatchObject({ voicesByModel: { [model]: voices } });
    expect(
      internalApi.resolveGatewayRelayCapabilities({
        providerConfig: { model },
      }),
    ).toMatchObject({
      handlesAgentConsult: true,
      supportsToolCalls: false,
      supportsBargeIn: false,
      handlesInputAudioBargeIn: true,
      supportsActivationNameGating: false,
      voices,
      voiceSelectionPolicy: "allowlist-default",
    });
    expect(
      internalApi.projectPublicProjection({
        providerConfig: { model },
        config: { model, voice: selectedVoice },
      }),
    ).toEqual({
      config: { model, voice: selectedVoice },
      clientHints: { gatewayRelaySupported: true },
    });
  });
});
