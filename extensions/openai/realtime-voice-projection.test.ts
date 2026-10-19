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
  isProviderAuthProfileConfiguredAsync: mocks.isProviderAuthProfileConfiguredMock,
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

function projectionFixture(withBroker = false) {
  const broker = withBroker ? createQuicksilverBrowserBrokerFixture().broker : undefined;
  const provider = buildOpenAIRealtimeVoiceProvider({ quicksilverBrowserSessionBroker: broker });
  const api = readInternalRealtimeVoiceProviderApi(provider);
  return {
    provider,
    api,
    project: (providerConfig: Record<string, unknown>, config = providerConfig) =>
      api.projectPublicProjection({ providerConfig, config }),
    relayConfigured: (providerConfig: Record<string, unknown>) =>
      api.isGatewayRelayConfiguredAsync({ providerConfig, agentId: "main" }),
  };
}

describe("OpenAI realtime public projection", () => {
  beforeEach(resetTestState);
  afterEach(restoreTestEnvironment);

  it("preserves native Talk for forced agent consult", () => {
    const config = { model: "gpt-live-1-codex", consultRouting: "force-agent-consult" };
    expect(projectRealtimeVoicePublicProjection({ providerConfig: config, config })).toEqual({
      config,
      clientHints: { gatewayRelaySupported: false },
    });
  });

  it.each([false, true])(
    "advertises the subscription relay capability independently of OAuth readiness=%s",
    async (hasOAuth) => {
      isProviderAuthProfileConfiguredMock.mockImplementation(
        ({ profileTypes }: { profileTypes?: readonly string[] }) =>
          hasOAuth && profileTypes?.includes("oauth") === true,
      );
      const { project, relayConfigured } = projectionFixture();
      const providerConfig = { model: "gpt-live-1-codex" };

      expect(project(providerConfig)).toEqual({
        config: providerConfig,
        clientHints: { gatewayRelaySupported: true },
      });
      expect(await relayConfigured(providerConfig)).toBe(hasOAuth);
      for (const [azureConfig, supportsRelay] of [
        [{ azureEndpoint: " https://example.openai.azure.com " }, false],
        [{ azureDeployment: " live-deployment " }, false],
        [{ baseUrl: " wss://voice.example.test/realtime " }, false],
        [{ baseUrl: " " }, true],
        [{ azureEndpoint: "", azureDeployment: " \t " }, true],
        [{ azureEndpoint: " \t ", azureDeployment: "" }, true],
      ] as const) {
        const azureProviderConfig = { ...providerConfig, ...azureConfig };
        expect(project(azureProviderConfig, providerConfig)).toEqual({
          config: providerConfig,
          clientHints: { gatewayRelaySupported: supportsRelay },
        });
        expect(await relayConfigured(azureProviderConfig)).toBe(hasOAuth && supportsRelay);
      }
    },
  );

  it("admits opaque realtime models without publishing them", async () => {
    const { provider, api, project, relayConfigured } = projectionFixture(true);
    const providerConfig = { apiKey: "test-api-key-platform", model: OPAQUE_REALTIME_MODEL };

    expect(provider.models).not.toContain(OPAQUE_REALTIME_MODEL);
    expect(await relayConfigured(providerConfig)).toBe(true);
    expect(
      api.resolveGatewayRelayCapabilities({ providerConfig, model: OPAQUE_REALTIME_MODEL }),
    ).toMatchObject({
      handlesAgentConsult: true,
      supportsToolCalls: false,
      voices: ["marin", "cedar"],
      voiceSelectionPolicy: "allowlist-default",
    });
    expect(project(providerConfig, { model: OPAQUE_REALTIME_MODEL, voice: "marin" })).toEqual({
      config: { voice: "marin" },
      clientHints: { modelSource: "gateway", gatewayRelaySupported: false },
    });
    expect(
      project({ model: "gpt-realtime-2.1" }, { model: "gpt-realtime-2.1", voice: "marin" }),
    ).toEqual({ config: { model: "gpt-realtime-2.1", voice: "marin" } });
  });

  it.each([
    {
      model: "gpt-live-1",
      selectedVoice: "quartz",
      voices:
        "alloy ash ballad beacon bossa cedar cinder coral delta echo gleam marin meridian quartz ripple sage shimmer stone tempo verse vesper willow".split(
          " ",
        ),
    },
    {
      model: "gpt-live-1-codex",
      selectedVoice: "spruce",
      voices: ["arbor", "breeze", "cove", "ember", "juniper", "maple", "sol", "spruce", "vale"],
    },
  ])("publishes $model with its own catalog voice profile", ({ model, selectedVoice, voices }) => {
    const { provider, api, project } = projectionFixture(true);

    expect(provider.models).toContain(model);
    expect(provider.capabilities).toMatchObject({ voicesByModel: { [model]: voices } });
    expect(api.resolveGatewayRelayCapabilities({ providerConfig: { model } })).toMatchObject({
      handlesAgentConsult: true,
      supportsToolCalls: false,
      supportsBargeIn: false,
      handlesInputAudioBargeIn: true,
      supportsActivationNameGating: false,
      voices,
      voiceSelectionPolicy: "allowlist-default",
    });
    expect(project({ model }, { model, voice: selectedVoice })).toEqual({
      config: { model, voice: selectedVoice },
      clientHints: { gatewayRelaySupported: true },
    });
  });
});
