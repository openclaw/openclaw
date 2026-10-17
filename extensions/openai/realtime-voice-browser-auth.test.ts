import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: mocks.execFileSyncMock,
}));
vi.mock("ws", () => ({ default: mocks.FakeWebSocket }));
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
  requireSocket,
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
  createTestJwt,
  resetTestState,
  restoreTestEnvironment,
  mockRealtimeClientSecretResponse,
  rejectedKeyMessage: OPENAI_REALTIME_REJECTED_KEY_MESSAGE,
  createQuicksilverBrowserBrokerFixture,
} = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });

describe("OpenAI realtime voice browser authentication", () => {
  let provider: ReturnType<typeof buildOpenAIRealtimeVoiceProvider>;
  beforeEach(() => {
    resetTestState();
    provider = buildOpenAIRealtimeVoiceProvider();
  });
  afterEach(restoreTestEnvironment);

  function browserSession(
    request: Parameters<NonNullable<typeof provider.createBrowserSession>>[0],
  ) {
    if (!provider.createBrowserSession) {
      throw new Error("expected OpenAI realtime provider to support browser sessions");
    }
    return provider.createBrowserSession(request);
  }

  function authBridge(overrides: Parameters<typeof createNativeBridge>[0] = {}) {
    return provider.createBridge({
      providerConfig: {},
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      ...overrides,
    });
  }

  it("resolves native bridge API-key profiles in the requested agent scope", async () => {
    resolveProviderAuthProfileApiKeyMock.mockResolvedValueOnce("test-api-key-profile");
    const cfg = { agents: { entries: { main: {}, "voice-agent": {} } } } as never;
    const bridge = authBridge({
      agentId: "voice-agent",
      cfg,
      providerConfig: { model: "gpt-realtime-2" },
    });

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = requireSocket();
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
    expect(socket.args[1]).toMatchObject({
      headers: { Authorization: "Bearer test-api-key-profile" },
    });
    await bridge.close();
  });

  it("requires an API key for custom realtime endpoints", async () => {
    const bridge = authBridge({
      cfg: {} as never,
      providerConfig: {
        azureEndpoint: "https://example.openai.azure.com",
        model: "gpt-realtime-2",
      },
    });

    await expect(bridge.connect()).rejects.toThrow("OpenAI Realtime voice requires an API key");

    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("returns browser-safe OpenClaw attribution headers for native WebRTC offers", async () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    mockRealtimeClientSecretResponse({ expiresAt: 1_765_000_000 });
    const session = await browserSession({
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
    const bodySession = requireRecord(requireFetchJsonBody().session, "fetch session");
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
    // #76435: server attribution headers fail the browser's SDP CORS preflight.
    expect(session.offerHeaders).toBeUndefined();
  });

  it("explains auth precedence when the selected API key is rejected", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: createJsonResponse(
        { error: { message: "Incorrect API key provided: test-api-key-proj-***" } },
        { status: 401 },
      ),
      release: vi.fn(async () => undefined),
    });
    await expect(
      browserSession({ providerConfig: { apiKey: "test-api-key-stale" } }),
    ).rejects.toThrow(
      "OpenAI Realtime rejected the selected API key. Update or remove the active OpenAI API-key source",
    );
  });

  it("resolves keychain OPENAI_API_KEY refs before creating browser sessions", async () => {
    vi.stubEnv("OPENAI_API_KEY", "keychain:openclaw:OPENAI_REALTIME_BROWSER_TEST");
    execFileSyncMock.mockReturnValueOnce("test-api-key-browser-env\n");
    mockRealtimeClientSecretResponse();
    await browserSession({
      providerConfig: {},
      instructions: "Be concise.",
    });

    const [securityBinary, securityArgs, securityOptions] = firstMockCall(
      execFileSyncMock,
      "security keychain lookup",
    );
    expect([securityBinary, securityArgs]).toEqual([
      "/usr/bin/security",
      ["find-generic-password", "-s", "openclaw", "-a", "OPENAI_REALTIME_BROWSER_TEST", "-w"],
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
    const first = authBridge();
    const second = authBridge();
    void first.connect();
    void second.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2));
    await first.close();
    await second.close();

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    for (const socket of FakeWebSocket.instances) {
      expect(socket.args[1]).toMatchObject({
        headers: { Authorization: "Bearer test-api-key-bridge-env" },
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
    provider = buildOpenAIRealtimeVoiceProvider({ quicksilverBrowserSessionBroker: broker });

    await expect(
      browserSession({
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
    await expect(
      browserSession({
        cfg: { agents: { defaults: {} } } as never,
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
    const bridge = authBridge();

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
    const authError = {
      type: "error",
      error: { message: "Incorrect API key provided: test-api-key-proj-***" },
    };
    emitServerEvent(socket, authError);
    emitServerEvent(socket, authError);

    await expect(connecting).rejects.toThrow(OPENAI_REALTIME_REJECTED_KEY_MESSAGE);
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(socket.closed).toBe(true);
    expect(bridge.isConnected()).toBe(false);
  });

  it.each([
    ["structured direct", "structured", undefined, OPENAI_REALTIME_REJECTED_KEY_MESSAGE],
    ["direct handshake", "handshake", undefined, OPENAI_REALTIME_REJECTED_KEY_MESSAGE],
    [
      "Azure handshake",
      "handshake",
      {
        apiKey: "test-api-key-test",
        azureEndpoint: "https://example.openai.azure.com",
        azureDeployment: "realtime-prod",
      },
      "Unexpected server response: 401",
    ],
    [
      "custom-endpoint handshake",
      "handshake",
      {
        apiKey: "test-api-key-test",
        azureEndpoint: "https://realtime-proxy.example.com",
      },
      "Unexpected server response: 401",
    ],
  ] as const)("handles %s errors", async (_name, event, providerConfig, expectedMessage) => {
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
