// Openai tests cover realtime voice provider plugin behavior.
import { resolveConfiguredRealtimeVoiceProviderAsync } from "openclaw/plugin-sdk/realtime-voice";
import type { InternalRealtimeVoiceBrowserSessionCreateRequest } from "openclaw/plugin-sdk/realtime-voice-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectRealtimeVoicePublicProjection } from "./provider-policy-api.js";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
const {
  FakeWebSocket,
  execFileSyncMock,
  fetchWithSsrFGuardMock,
  isProviderAuthProfileConfiguredMock,
  resolveProviderAuthProfileApiKeyMock,
} = mocks;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: mocks.execFileSyncMock,
  };
});

vi.mock("ws", () => ({
  default: mocks.FakeWebSocket,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuardMock,
}));

// mock-isolation: Browser-auth routing uses fixture profile results while keeping host credential storage untouched.
vi.mock("openclaw/plugin-sdk/provider-auth", async () => {
  const { resolveOpenAICodexAuthIdentity } = await vi.importActual<
    typeof import("openclaw/plugin-sdk/provider-oauth-runtime")
  >("openclaw/plugin-sdk/provider-oauth-runtime");
  return {
    isProviderAuthProfileConfigured: mocks.isProviderAuthProfileConfiguredMock,
    isProviderAuthProfileConfiguredAsync: mocks.isProviderAuthProfileConfiguredMock,
    resolveProviderAuthProfileApiKey: mocks.resolveProviderAuthProfileApiKeyMock,
    resolveOpenAICodexAuthIdentity,
  };
});
import { createOpenAIRealtimeTestSupport } from "./realtime-voice-test-support.js";

const {
  createNativeBridge,
  beginBridgeConnection,
  openSocket,
  emitServerEvent,
  createJsonResponse,
  requireRecord,
  requireNestedRecord,
  expectRecordFields,
  firstMockCall,
  requireFetchRequest,
  requireFetchInit,
  requireFetchHeaders,
  requireFetchJsonBody,
  readInternalRealtimeVoiceProviderApi,
  createTestJwt,
  resetTestState,
  restoreTestEnvironment,
  mockRealtimeClientSecretResponse,
  rejectedKeyMessage: OPENAI_REALTIME_REJECTED_KEY_MESSAGE,
  createQuicksilverBrowserBrokerFixture,
} = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });

describe("OpenAI realtime voice browser authentication", () => {
  beforeEach(() => {
    resetTestState();
  });

  afterEach(() => {
    restoreTestEnvironment();
  });

  it("resolves native bridge API-key profiles in the requested agent scope", async () => {
    resolveProviderAuthProfileApiKeyMock.mockResolvedValueOnce("test-api-key-profile");
    const provider = buildOpenAIRealtimeVoiceProvider();
    const cfg = {
      agents: { entries: { main: {}, "voice-agent": {} } },
    } as never;
    const bridge = provider.createBridge({
      agentId: "voice-agent",
      cfg,
      providerConfig: { model: "gpt-realtime-2" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected bridge to create a websocket");
    }
    openSocket(socket);
    emitServerEvent(socket, { type: "session.updated" });
    await connecting;

    expect(resolveProviderAuthProfileApiKeyMock).toHaveBeenCalledWith({
      provider: "openai",
      cfg,
      agentDir: expect.stringContaining("voice-agent"),
      profileTypes: ["api_key"],
      includeExternalCliAuth: false,
    });
    const options = socket.args[1] as { headers?: Record<string, string> } | undefined;
    expect(options?.headers?.Authorization).toBe("Bearer test-api-key-profile");
    await bridge.close();
  });

  it("requires an API key for custom realtime endpoints", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      cfg: {} as never,
      providerConfig: {
        azureEndpoint: "https://example.openai.azure.com",
        model: "gpt-realtime-2",
      },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await expect(bridge.connect()).rejects.toThrow("OpenAI Realtime voice requires an API key");

    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("returns browser-safe OpenClaw attribution headers for native WebRTC offers", async () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    mockRealtimeClientSecretResponse({ expiresAt: 1_765_000_000 });
    const provider = buildOpenAIRealtimeVoiceProvider();
    if (!provider.createBrowserSession) {
      throw new Error("expected OpenAI realtime provider to support browser sessions");
    }

    const session = await provider.createBrowserSession({
      providerConfig: { apiKey: "test-api-key-test" },
      instructions: "Be concise.",
      voice: " Marin ",
    });

    expectRecordFields(requireFetchRequest(), "fetch request", {
      url: "https://api.openai.com/v1/realtime/client_secrets",
      policy: {
        allowRfc2544BenchmarkRange: true,
        allowIpv6UniqueLocalRange: true,
        hostnameAllowlist: ["api.openai.com"],
      },
    });
    expectRecordFields(requireFetchInit(), "fetch init", { method: "POST" });
    expectRecordFields(requireFetchHeaders(), "fetch headers", {
      Authorization: "Bearer test-api-key-test",
      "Content-Type": "application/json",
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });
    const body = requireFetchJsonBody();
    const bodySession = requireRecord(body.session, "fetch session");
    expect(bodySession.model).toBe("gpt-realtime-2.1");
    expect(requireNestedRecord(bodySession, ["audio", "input"])).toEqual({
      noise_reduction: { type: "near_field" },
      turn_detection: {
        type: "server_vad",
        create_response: true,
        interrupt_response: true,
      },
      transcription: { model: "gpt-4o-mini-transcribe" },
    });
    expect(requireNestedRecord(bodySession, ["audio", "output"])).toEqual({ voice: "marin" });
    expect(bodySession).not.toHaveProperty("temperature");
    expectRecordFields(session, "browser session", {
      provider: "openai",
      transport: "webrtc",
      clientSecret: "client-secret-123",
      offerUrl: "https://api.openai.com/v1/realtime/calls",
      offerResponseMaxBytes: 256 * 1024,
      model: "gpt-realtime-2.1",
      expiresAt: 1_765_000_000_000,
    });
    // originator, version, and User-Agent are server-side attribution headers; they
    // must not be forwarded to the browser so that the browser's direct SDP POST to
    // api.openai.com passes the CORS preflight (only authorization,content-type
    // allowed — #76435). All three are filtered, leaving no browser offer headers.
    expect((session as { offerHeaders?: Record<string, string> }).offerHeaders).toBeUndefined();
  });

  it("explains auth precedence when the selected API key is rejected", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: createJsonResponse(
        { error: { message: "Incorrect API key provided: test-api-key-proj-***" } },
        { status: 401 },
      ),
      release: vi.fn(async () => undefined),
    });
    const provider = buildOpenAIRealtimeVoiceProvider();
    await expect(
      provider.createBrowserSession?.({ providerConfig: { apiKey: "test-api-key-stale" } }),
    ).rejects.toThrow(
      "OpenAI Realtime rejected the selected API key. Update or remove the active OpenAI API-key source",
    );
  });

  it("resolves keychain OPENAI_API_KEY refs before creating browser sessions", async () => {
    vi.stubEnv("OPENAI_API_KEY", "keychain:openclaw:OPENAI_REALTIME_BROWSER_TEST");
    execFileSyncMock.mockReturnValueOnce("test-api-key-browser-env\n");
    mockRealtimeClientSecretResponse();
    const provider = buildOpenAIRealtimeVoiceProvider();
    if (!provider.createBrowserSession) {
      throw new Error("expected OpenAI realtime provider to support browser sessions");
    }

    await provider.createBrowserSession({
      providerConfig: {},
      instructions: "Be concise.",
    });

    const [securityBinary, securityArgs, securityOptions] = firstMockCall(
      execFileSyncMock,
      "security keychain lookup",
    );
    expect(securityBinary).toBe("/usr/bin/security");
    expect(securityArgs).toEqual([
      "find-generic-password",
      "-s",
      "openclaw",
      "-a",
      "OPENAI_REALTIME_BROWSER_TEST",
      "-w",
    ]);
    expectRecordFields(securityOptions, "security command options", {
      encoding: "utf8",
      timeout: 5000,
    });
    expectRecordFields(requireFetchHeaders(), "fetch headers", {
      Authorization: "Bearer test-api-key-browser-env",
    });
  });

  it("resolves and caches keychain OPENAI_API_KEY refs before creating bridges", async () => {
    vi.stubEnv("OPENAI_API_KEY", "keychain:openclaw:OPENAI_REALTIME_BRIDGE_TEST");
    execFileSyncMock.mockReturnValue("test-api-key-bridge-env\n");
    const provider = buildOpenAIRealtimeVoiceProvider();

    const first = provider.createBridge({
      providerConfig: {},
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });
    const second = provider.createBridge({
      providerConfig: {},
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });
    void first.connect();
    void second.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2));
    await first.close();
    await second.close();

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    for (const socket of FakeWebSocket.instances) {
      const options = socket.args[1] as { headers?: Record<string, string> } | undefined;
      expectRecordFields(options?.headers, "websocket headers", {
        Authorization: "Bearer test-api-key-bridge-env",
      });
    }
  });

  it("does not use GA OAuth fallback when a Platform credential source is unresolved", async () => {
    const oauthToken = createTestJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
    });
    resolveProviderAuthProfileApiKeyMock.mockImplementation(
      async ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes("oauth") ? oauthToken : undefined,
    );
    isProviderAuthProfileConfiguredMock.mockImplementation(
      ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes("api_key") === true,
    );
    const { broker, createBrowserSession } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });

    await expect(
      provider.createBrowserSession?.({
        cfg: {} as never,
        providerConfig: {},
        model: "gpt-realtime-2.1",
        agentId: "main",
        workspaceDir: "/tmp/openclaw-agent-workspace",
        initialItems: [],
      } as never),
    ).rejects.toThrow("OpenAI Realtime voice requires an OpenAI Platform API key");
    expect(createBrowserSession).not.toHaveBeenCalled();
    expect(resolveProviderAuthProfileApiKeyMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ profileTypes: ["oauth"] }),
    );
  });

  it("does not configure Azure realtime sessions without a Platform API key", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const cfg = { agents: { defaults: {} } } as never;

    expect(
      await provider.isConfiguredAsync?.({
        cfg,
        providerConfig: {
          azureEndpoint: "https://example.openai.azure.com",
          azureDeployment: "realtime",
        },
      }),
    ).toBe(false);
  });

  it("requires Platform auth before minting browser realtime client secrets", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    if (!provider.createBrowserSession) {
      throw new Error("expected OpenAI realtime provider to support browser sessions");
    }
    const cfg = { agents: { defaults: {} } } as never;

    await expect(
      provider.createBrowserSession({
        cfg,
        providerConfig: {},
        instructions: "Be concise.",
      }),
    ).rejects.toThrow("OpenAI Realtime voice requires an OpenAI Platform API key");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("fails closed when keychain refs cannot be resolved", async () => {
    vi.stubEnv("OPENAI_API_KEY", "keychain:openclaw:OPENAI_REALTIME_MISSING_TEST");
    resolveProviderAuthProfileApiKeyMock.mockResolvedValueOnce(undefined);
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error("keychain unavailable");
    });
    const provider = buildOpenAIRealtimeVoiceProvider();

    const bridge = provider.createBridge({
      providerConfig: {},
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await expect(bridge.connect()).rejects.toThrow(
      "OpenAI Realtime voice requires an OpenAI Platform API key",
    );
    expect(resolveProviderAuthProfileApiKeyMock).toHaveBeenCalledTimes(1);
  });

  it("treats pre-ready auth errors as a single startup failure", async () => {
    const onError = vi.fn();
    const onClose = vi.fn();
    const bridge = createNativeBridge({ onError, onClose });
    const { connecting, socket } = beginBridgeConnection(bridge);

    openSocket(socket);
    emitServerEvent(socket, {
      type: "error",
      error: { message: "Incorrect API key provided: test-api-key-proj-***" },
    });
    emitServerEvent(socket, {
      type: "error",
      error: { message: "Incorrect API key provided: test-api-key-proj-***" },
    });

    await expect(connecting).rejects.toThrow(OPENAI_REALTIME_REJECTED_KEY_MESSAGE);
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(socket.closed).toBe(true);
    expect(bridge.isConnected()).toBe(false);
  });

  it.each([
    {
      name: "structured direct error expects normalization",
      event: "structured" as const,
      providerConfig: undefined,
      expectedMessage: OPENAI_REALTIME_REJECTED_KEY_MESSAGE,
    },
    {
      name: "direct handshake error expects normalization",
      event: "handshake" as const,
      providerConfig: undefined,
      expectedMessage: OPENAI_REALTIME_REJECTED_KEY_MESSAGE,
    },
    {
      name: "Azure handshake error expects raw preservation",
      event: "handshake" as const,
      providerConfig: {
        apiKey: "test-api-key-test",
        azureEndpoint: "https://example.openai.azure.com",
        azureDeployment: "realtime-prod",
      },
      expectedMessage: "Unexpected server response: 401",
    },
    {
      name: "custom-endpoint handshake error expects raw preservation",
      event: "handshake" as const,
      providerConfig: {
        apiKey: "test-api-key-test",
        azureEndpoint: "https://realtime-proxy.example.com",
      },
      expectedMessage: "Unexpected server response: 401",
    },
  ])("$name", async ({ event, providerConfig, expectedMessage }) => {
    const bridge = createNativeBridge(providerConfig ? { providerConfig } : {});
    const { connecting, socket } = beginBridgeConnection(bridge);

    if (event === "structured") {
      openSocket(socket);
      emitServerEvent(socket, {
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "invalid_api_key",
          message: "Invalid API key",
        },
      });
    } else {
      socket.emit("error", new Error("Unexpected server response: 401"));
    }

    await expect(connecting).rejects.toThrow(expectedMessage);
    expect(bridge.isConnected()).toBe(false);
  });
});

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
      api.resolveGatewayRelayCapabilities({
        providerConfig: { ...providerConfig, model: "gpt-realtime-2.1" },
        model: OPAQUE_REALTIME_MODEL,
      }),
    ).toMatchObject({
      transports: ["webrtc", "gateway-relay"],
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
