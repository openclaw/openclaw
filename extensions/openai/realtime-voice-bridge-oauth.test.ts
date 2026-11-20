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

function createBridge(providerConfig: Record<string, unknown> = DISCORD_PROVIDER_CONFIG) {
  return buildOpenAIRealtimeVoiceProvider().createBridge({
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
  beforeEach(resetTestState);
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

  it("keeps Platform auth ahead of OAuth on the direct socket", async () => {
    mockProfiles({
      configured: ["api_key", "oauth"],
      resolved: { api_key: "test-api-key-profile", oauth: OAUTH_TOKEN },
    });
    const bridge = createBridge();
    const { headers } = await connectReady(bridge);
    try {
      expect(headers.Authorization).toBe("Bearer test-api-key-profile");
      expect(headers).not.toHaveProperty("chatgpt-account-id");
      expect(resolveProviderAuthProfileApiKeyMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ profileTypes: ["oauth"] }),
      );
    } finally {
      await bridge.close();
    }
  });

  it("fails with the existing error when a configured Platform source is unavailable", async () => {
    mockProfiles({ configured: ["api_key", "oauth"], resolved: { oauth: OAUTH_TOKEN } });
    await expect(createBridge().connect()).rejects.toThrow(
      "OpenAI Realtime voice requires an OpenAI Platform API key",
    );
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(resolveProviderAuthProfileApiKeyMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ profileTypes: ["oauth"] }),
    );
  });

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

  it("reports a rejected ChatGPT sign-in instead of a rejected API key", async () => {
    mockOAuthOnly();
    const connecting = createBridge().connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0]?.emit("error", new Error("Unexpected server response: 401"));
    await expect(connecting).rejects.toThrow(
      "OpenAI Realtime rejected the ChatGPT sign-in. Sign in again or configure an OpenAI Platform API key",
    );
  });
});
