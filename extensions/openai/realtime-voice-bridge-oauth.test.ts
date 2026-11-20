// Openai tests cover GA realtime direct sockets over ChatGPT OAuth.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
const { FakeWebSocket, isProviderAuthProfileConfiguredMock, resolveProviderAuthProfileApiKeyMock } =
  mocks;

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: mocks.execFileSyncMock,
}));

vi.mock("openclaw/plugin-sdk/websocket-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/websocket-runtime")>()),
  WebSocket: mocks.FakeWebSocket,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuardMock,
}));

// mock-isolation: OAuth socket routing uses fixture profile results while keeping host credential storage untouched.
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
  openSocket,
  emitServerEvent,
  parseSent,
  createRealtimeTool,
  createTestJwt,
  resetTestState,
  restoreTestEnvironment,
} = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });

const GA_MODEL = "gpt-realtime-2.1";
const OAUTH_TOKEN = createTestJwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
});
const cfg = { agents: { defaults: {} } } as never;

function mockProfiles(params: { configured: string[]; resolved: Record<string, string> }) {
  isProviderAuthProfileConfiguredMock.mockImplementation(
    ({ profileTypes }: { profileTypes?: readonly string[] }) =>
      params.configured.some((type) => profileTypes?.includes(type)),
  );
  resolveProviderAuthProfileApiKeyMock.mockImplementation(
    async ({ profileTypes }: { profileTypes?: readonly string[] }) =>
      profileTypes?.length === 1 ? params.resolved[profileTypes[0] ?? ""] : undefined,
  );
}

const mockOAuthOnly = () =>
  mockProfiles({ configured: ["oauth"], resolved: { oauth: OAUTH_TOKEN } });

// Discord passes its realtime provider block (silence and reasoning settings) as providerConfig.
const DISCORD_PROVIDER_CONFIG = { model: GA_MODEL, silenceDurationMs: 650, reasoningEffort: "low" };

type FakeSocket = NonNullable<(typeof FakeWebSocket.instances)[number]>;
const logger = { debug: vi.fn(), warn: vi.fn() };

function createBridge(providerConfig: Record<string, unknown> = DISCORD_PROVIDER_CONFIG) {
  return buildOpenAIRealtimeVoiceProvider({ logger }).createBridge({
    cfg,
    agentId: "main",
    providerConfig,
    // Discord `consultPolicy: "always"` with barge-in.
    autoRespondToAudio: false,
    interruptResponseOnInputAudio: true,
    instructions: "Consult OpenClaw before answering.",
    tools: [createRealtimeTool("openclaw_agent_consult")],
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
  });
}

async function connectReady(bridge: ReturnType<typeof createBridge>) {
  const connecting = bridge.connect();
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0];
  if (!socket) {
    throw new Error("expected bridge to create a websocket");
  }
  openSocket(socket);
  emitServerEvent(socket, { type: "session.updated" });
  await connecting;
  return {
    socket,
    url: String(socket.args[0]),
    headers: (socket.args[1] as { headers: Record<string, string> }).headers,
  };
}

describe("OpenAI GA realtime direct socket over ChatGPT OAuth", () => {
  beforeEach(() => {
    resetTestState();
    logger.debug.mockReset();
    logger.warn.mockReset();
  });
  afterEach(restoreTestEnvironment);

  it("connects OAuth-only installs with the ChatGPT account and the full session policy", async () => {
    mockOAuthOnly();
    const provider = buildOpenAIRealtimeVoiceProvider();
    expect(await provider.isConfiguredAsync?.({ cfg, providerConfig: { model: GA_MODEL } })).toBe(
      true,
    );
    expect(provider.isConfigured({ cfg, providerConfig: {} })).toBe(true);

    const bridge = createBridge();
    const { socket, url, headers } = await connectReady(bridge);
    try {
      expect(url).toBe(`wss://api.openai.com/v1/realtime?model=${GA_MODEL}`);
      expect(headers.Authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
      expect(headers["chatgpt-account-id"]).toBe("account-123");
      const sessionUpdate = parseSent(socket).find((event) => event.type === "session.update");
      expect(sessionUpdate?.session).toMatchObject({
        type: "realtime",
        model: GA_MODEL,
        instructions: "Consult OpenClaw before answering.",
        reasoning: { effort: "low" },
        tool_choice: "auto",
        tools: [expect.objectContaining({ name: "openclaw_agent_consult" })],
        audio: {
          input: {
            turn_detection: {
              type: "server_vad",
              silence_duration_ms: 650,
              create_response: false,
              interrupt_response: true,
            },
          },
        },
      });
    } finally {
      await bridge.close();
    }
  });

  it("prefers the ChatGPT subscription over a Platform key profile", async () => {
    mockProfiles({
      configured: ["api_key", "oauth"],
      resolved: { api_key: "test-api-key-profile", oauth: OAUTH_TOKEN },
    });
    const bridge = createBridge();
    const { headers } = await connectReady(bridge);
    try {
      expect(headers.Authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
      expect(headers["chatgpt-account-id"]).toBe("account-123");
      expect(logger.debug).toHaveBeenCalledWith("OpenAI realtime auth: ChatGPT subscription");
    } finally {
      await bridge.close();
    }
  });

  it("uses a key configured on the voice provider ahead of the subscription", async () => {
    mockOAuthOnly();
    const bridge = createBridge({ ...DISCORD_PROVIDER_CONFIG, apiKey: "test-api-key-voice" });
    const { headers } = await connectReady(bridge);
    try {
      expect(headers.Authorization).toBe("Bearer test-api-key-voice");
      expect(headers).not.toHaveProperty("chatgpt-account-id");
      expect(resolveProviderAuthProfileApiKeyMock).not.toHaveBeenCalled();
    } finally {
      await bridge.close();
    }
  });

  it("falls back to the Platform key profile without a subscription", async () => {
    mockProfiles({ configured: ["api_key"], resolved: { api_key: "test-api-key-profile" } });
    const bridge = createBridge();
    const { headers } = await connectReady(bridge);
    try {
      expect(headers.Authorization).toBe("Bearer test-api-key-profile");
      expect(headers).not.toHaveProperty("chatgpt-account-id");
      expect(logger.debug).toHaveBeenCalledWith("OpenAI realtime auth: Platform API key");
    } finally {
      await bridge.close();
    }
  });

  it("keeps the existing error when only an unavailable Platform source is configured", async () => {
    mockProfiles({ configured: ["api_key"], resolved: {} });
    await expect(createBridge().connect()).rejects.toThrow(
      "OpenAI Realtime voice requires an OpenAI Platform API key",
    );
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it.each([
    [
      "HTTP 401",
      (socket: FakeSocket) => socket.emit("error", new Error("Unexpected server response: 401")),
    ],
    [
      "HTTP 403",
      (socket: FakeSocket) => socket.emit("error", new Error("Unexpected server response: 403")),
    ],
    [
      "invalid_jwt error event",
      (socket: FakeSocket) => {
        openSocket(socket);
        emitServerEvent(socket, {
          type: "error",
          error: {
            type: "invalid_request_error",
            code: "invalid_jwt",
            message: "Could not parse your authentication token. Please try signing in again.",
          },
        });
      },
    ],
  ] as const)(
    "retries once with the Platform key when OpenAI refuses the ChatGPT sign-in (%s)",
    async (_name, reject) => {
      mockProfiles({
        configured: ["api_key", "oauth"],
        resolved: { api_key: "test-api-key-profile", oauth: OAUTH_TOKEN },
      });
      const bridge = createBridge();
      const connecting = bridge.connect();
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const first = FakeWebSocket.instances[0];
      if (!first) {
        throw new Error("expected a ChatGPT socket");
      }
      reject(first);
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
      const retry = FakeWebSocket.instances[1];
      if (!retry) {
        throw new Error("expected a Platform-key retry socket");
      }
      openSocket(retry);
      emitServerEvent(retry, { type: "session.updated" });
      await connecting;
      try {
        const headers = (retry.args[1] as { headers: Record<string, string> }).headers;
        expect(headers.Authorization).toBe("Bearer test-api-key-profile");
        expect(headers).not.toHaveProperty("chatgpt-account-id");
        expect(logger.warn).toHaveBeenCalledWith(
          "OpenAI realtime rejected the ChatGPT sign-in; retrying with the OpenAI Platform API key",
        );
        expect(logger.debug).toHaveBeenLastCalledWith(
          "OpenAI realtime auth: Platform API key after the ChatGPT sign-in was rejected",
        );
      } finally {
        await bridge.close();
      }
    },
  );

  it("names both credentials when neither is configured", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    expect(await provider.isConfiguredAsync?.({ cfg, providerConfig: {} })).toBe(false);
    await expect(createBridge().connect()).rejects.toThrow(
      "OpenAI Realtime voice requires an OpenAI Platform API key or a ChatGPT sign-in",
    );
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it.each([
    ["custom endpoint", { model: GA_MODEL, baseUrl: "wss://voice.example.test/realtime" }],
    ["GPT-Live model", { model: "gpt-live-1" }],
  ])("does not offer OAuth for a %s", async (_name, providerConfig) => {
    mockOAuthOnly();
    const provider = buildOpenAIRealtimeVoiceProvider();
    expect(await provider.isConfiguredAsync?.({ cfg, providerConfig })).toBe(false);
    expect(provider.isConfigured({ cfg, providerConfig })).toBe(false);
  });

  it("never sends the OAuth token to a custom endpoint", async () => {
    mockOAuthOnly();
    await expect(
      createBridge({ model: GA_MODEL, baseUrl: "wss://voice.example.test/realtime" }).connect(),
    ).rejects.toThrow("OpenAI Realtime voice requires an OpenAI Platform API key");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("reports a rejected ChatGPT sign-in when no Platform key can take over", async () => {
    mockOAuthOnly();
    const connecting = createBridge().connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0]?.emit("error", new Error("Unexpected server response: 401"));
    await expect(connecting).rejects.toThrow(
      "OpenAI Realtime rejected the ChatGPT sign-in. Sign in again or configure an OpenAI Platform API key",
    );
  });
});
