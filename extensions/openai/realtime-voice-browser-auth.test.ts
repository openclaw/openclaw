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

const rt = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });

describe("OpenAI realtime voice browser authentication", () => {
  let provider: ReturnType<typeof buildOpenAIRealtimeVoiceProvider>;
  beforeEach(() => {
    rt.resetTestState();
    provider = buildOpenAIRealtimeVoiceProvider();
  });
  afterEach(rt.restoreTestEnvironment);

  function browserSession(req: Parameters<NonNullable<typeof provider.createBrowserSession>>[0]) {
    if (!provider.createBrowserSession) {
      throw new Error("expected OpenAI realtime provider to support browser sessions");
    }
    return provider.createBrowserSession(req);
  }

  function authBridge(overrides: Parameters<typeof rt.createNativeBridge>[0] = {}) {
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
    const socket = rt.requireSocket();
    rt.openSocket(socket);
    rt.emitServerEvent(socket, { type: "session.updated" });
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
    rt.mockRealtimeClientSecretResponse({ expiresAt: 1_765_000_000 });
    const session = await browserSession({
      providerConfig: { apiKey: "test-api-key-test" },
      voice: " Marin ",
    });

    rt.expectRecordFields(rt.requireFetchRequest(), "fetch request", {
      url: "https://api.openai.com/v1/realtime/client_secrets",
      policy: {
        allowRfc2544BenchmarkRange: true,
        allowIpv6UniqueLocalRange: true,
        hostnameAllowlist: ["api.openai.com"],
      },
    });
    rt.expectRecordFields(rt.requireFetchInit(), "fetch init", { method: "POST" });
    expect(rt.requireFetchHeaders()).toMatchObject({
      Authorization: "Bearer test-api-key-test",
      "Content-Type": "application/json",
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });
    const bodySession = rt.requireRecord(rt.requireFetchJsonBody().session, "fetch session");
    expect(bodySession.model).toBe("gpt-realtime-2.1");
    expect(rt.requireNestedRecord(bodySession, ["audio", "input"])).toEqual({
      noise_reduction: { type: "near_field" },
      turn_detection: {
        type: "server_vad",
        create_response: true,
        interrupt_response: true,
      },
      transcription: { model: "gpt-4o-mini-transcribe" },
    });
    expect(rt.requireNestedRecord(bodySession, ["audio", "output"])).toEqual({ voice: "marin" });
    expect(bodySession).not.toHaveProperty("temperature");
    rt.expectRecordFields(session, "browser session", {
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
      response: rt.createJsonResponse(
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

  it.each(["browser", "bridge"])("resolves keychain refs for %s sessions", async (surface) => {
    const account = `OPENAI_REALTIME_${surface.toUpperCase()}_TEST`;
    const key = `test-api-key-${surface}-env`;
    vi.stubEnv("OPENAI_API_KEY", `keychain:openclaw:${account}`);
    execFileSyncMock.mockReturnValueOnce(`${key}\n`);
    if (surface === "browser") {
      rt.mockRealtimeClientSecretResponse();
      await browserSession({ providerConfig: {} });
      expect(rt.requireFetchHeaders()).toMatchObject({ Authorization: `Bearer ${key}` });
    } else {
      const [first, second] = [authBridge(), authBridge()];
      void first.connect();
      void second.connect();
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
      await first.close();
      await second.close();
      for (const socket of FakeWebSocket.instances) {
        expect(socket.args[1]).toMatchObject({ headers: { Authorization: `Bearer ${key}` } });
      }
    }
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [binary, args, options] = rt.firstMockCall(execFileSyncMock, "security keychain lookup");
    expect([binary, args]).toEqual([
      "/usr/bin/security",
      ["find-generic-password", "-s", "openclaw", "-a", account, "-w"],
    ]);
    expect(options).toMatchObject({ encoding: "utf8", timeout: 5000 });
  });

  it("does not use GA OAuth fallback when a Platform credential source is unresolved", async () => {
    const oauthToken = rt.createTestJwt({
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
    const { broker, createBrowserSession } = rt.createQuicksilverBrowserBrokerFixture();
    provider = buildOpenAIRealtimeVoiceProvider({ quicksilverBrowserSessionBroker: broker });

    await expect(
      browserSession({
        cfg: {} as never,
        providerConfig: {},
        model: "gpt-realtime-2.1",
        agentId: "main",
      }),
    ).rejects.toThrow("OpenAI Realtime voice requires an OpenAI Platform API key");
    expect(createBrowserSession).not.toHaveBeenCalled();
    expect(resolveProviderAuthProfileApiKeyMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ profileTypes: ["oauth"] }),
    );
  });

  it("does not configure Azure realtime sessions without a Platform API key", async () => {
    expect(
      await provider.isConfiguredAsync?.({
        cfg: { agents: { defaults: {} } } as never,
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
    const bridge = rt.createNativeBridge({ onError, onClose });
    const { connecting, socket } = rt.beginBridgeConnection(bridge);

    rt.openSocket(socket);
    const authError = {
      type: "error",
      error: { message: "Incorrect API key provided: test-api-key-proj-***" },
    };
    rt.emitServerEvent(socket, authError);
    rt.emitServerEvent(socket, authError);

    await expect(connecting).rejects.toThrow(rt.rejectedKeyMessage);
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(socket.closed).toBe(true);
    expect(bridge.isConnected()).toBe(false);
  });

  it.each([
    ["structured", undefined],
    ["handshake", undefined],
    [
      "handshake",
      {
        azureEndpoint: "https://example.openai.azure.com",
        azureDeployment: "realtime-prod",
      },
    ],
    ["handshake", { azureEndpoint: "https://realtime-proxy.example.com" }],
  ] as const)("handles %s errors for endpoint %j", async (event, endpoint) => {
    const bridge = rt.createNativeBridge({
      providerConfig: { apiKey: "test-api-key-test", ...endpoint },
    });
    const { connecting, socket } = rt.beginBridgeConnection(bridge);

    if (event === "structured") {
      rt.openSocket(socket);
      rt.emitServerEvent(socket, {
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

    await expect(connecting).rejects.toThrow(
      endpoint ? "Unexpected server response: 401" : rt.rejectedKeyMessage,
    );
    expect(bridge.isConnected()).toBe(false);
  });
});
