import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";
const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
const {
  FakeWebSocket,
  fetchWithSsrFGuardMock,
  isProviderAuthProfileConfiguredMock,
  resolveProviderAuthProfileApiKeyMock,
} = mocks;
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: mocks.execFileSyncMock,
}));
vi.mock("ws", () => ({ default: mocks.FakeWebSocket }));
vi.mock("./realtime-quicksilver-socket.js", async () => {
  const { createTestMediaSocketFactory } = await import("./realtime-voice-test-support.js");
  return {
    OpenAIQuicksilverWorkerSocket: {
      create: await createTestMediaSocketFactory(mocks.FakeWebSocket),
    },
  };
});
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuardMock,
}));
vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  isProviderAuthProfileConfigured: mocks.isProviderAuthProfileConfiguredMock,
  isProviderAuthProfileConfiguredAsync: mocks.isProviderAuthProfileConfiguredMock,
  resolveProviderAuthProfileApiKey: mocks.resolveProviderAuthProfileApiKeyMock,
}));
import { createOpenAIRealtimeTestSupport } from "./realtime-voice-test-support.js";
const OPAQUE_REALTIME_MODEL = "gpt-live-test-canary";
const GA_MODEL = "gpt-realtime-2.1";
const SUBSCRIPTION_MODEL = "gpt-live-1-codex";
const PLATFORM_KEY = "test-api-key-platform";
const customEndpoint = {
  baseUrl: "wss://voice.example.test/realtime",
  apiKey: "test-realtime-key",
};
const {
  requireRecord,
  requireFetchJsonBody,
  createRealtimeTool,
  createTestJwt,
  resetTestState,
  restoreTestEnvironment,
  readInternalRealtimeVoiceProviderApi,
  mockRealtimeClientSecretResponse,
  createQuicksilverBrowserBrokerFixture,
} = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });
function browserFixture(options?: Parameters<typeof createQuicksilverBrowserBrokerFixture>[0]) {
  const fixture = createQuicksilverBrowserBrokerFixture(options);
  const provider = buildOpenAIRealtimeVoiceProvider({
    quicksilverBrowserSessionBroker: fixture.broker,
  });
  return { ...fixture, provider, internalApi: readInternalRealtimeVoiceProviderApi(provider) };
}
function mockAuthTypes(type: string) {
  isProviderAuthProfileConfiguredMock.mockImplementation(
    ({ profileTypes }: { profileTypes?: readonly string[] }) =>
      profileTypes?.includes(type) === true,
  );
}
function mockOAuth(token = accountToken("account-123")) {
  resolveProviderAuthProfileApiKeyMock.mockImplementation(
    async ({ profileTypes }: { profileTypes?: readonly string[] }) =>
      profileTypes?.includes("oauth") ? token : undefined,
  );
}
const browserRequest = {
  agentId: "main",
  workspaceDir: "/tmp/openclaw-agent-workspace",
  initialItems: [],
};
const oauth = (token: string, accountId: string) => ({ type: "oauth", token, accountId });
const authDirs: string[] = [];
const accountToken = (accountId: string) =>
  createTestJwt({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
const oauthProfile = (accountId: string, refresh: string) => ({
  type: "oauth" as const,
  provider: "openai",
  access: accountToken(accountId),
  refresh,
  expires: Date.now() + 3_600_000,
});
const tokenProfile = (token: string) => ({
  type: "token" as const,
  provider: "openai",
  token,
  expires: Date.now() + 3_600_000,
});
async function authFixture(profiles: AuthProfileStore["profiles"], order: string[]) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-voice-auth-"));
  authDirs.push(agentDir);
  const store: AuthProfileStore = { version: 1, profiles };
  const realAuth = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-auth")>(
    "openclaw/plugin-sdk/provider-auth",
  );
  isProviderAuthProfileConfiguredMock.mockImplementation((params) =>
    realAuth.isProviderAuthProfileConfiguredAsync({ ...params, agentDir }),
  );
  resolveProviderAuthProfileApiKeyMock.mockImplementation((params) =>
    realAuth.resolveProviderAuthProfileApiKey({ ...params, agentDir }),
  );
  const fixture = browserFixture();
  const save = () =>
    saveAuthProfileStore(store, agentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
  return {
    store,
    save,
    ...fixture,
    request: {
      cfg: { auth: { order: { openai: order } } },
      providerConfig: { model: SUBSCRIPTION_MODEL },
      model: SUBSCRIPTION_MODEL,
      ...browserRequest,
    },
  };
}
describe("OpenAI realtime voice provider routing", () => {
  beforeEach(resetTestState);
  afterEach(() => {
    try {
      if (authDirs.length) {
        clearRuntimeAuthProfileStoreSnapshots();
        closeOpenClawAgentDatabasesForTest();
        for (const dir of authDirs.splice(0)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    } finally {
      restoreTestEnvironment();
    }
  });

  it("keeps custom endpoints on the GA relay instead of the default GPT-Live route", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const rawConfig = { baseUrl: "wss://voice.example.test/realtime", apiKey: "test-realtime-key" };
    expect(
      await provider.resolveConfigAsync?.({ cfg: {}, rawConfig, surface: "gateway-relay" }),
    ).toMatchObject({ ...rawConfig, model: GA_MODEL });
    const internalApi = readInternalRealtimeVoiceProviderApi(provider);
    expect(await internalApi.isBrowserSessionConfiguredAsync({ providerConfig: rawConfig })).toBe(
      false,
    );
    expect(
      await internalApi.resolveBrowserSessionCapabilitiesAsync({ providerConfig: rawConfig }),
    ).toMatchObject({ transports: ["gateway-relay"], supportsBrowserSession: false });
  });

  it("rejects custom endpoint browser sessions before auth or broker calls", async () => {
    const { provider, createBrowserSession } = browserFixture();
    await expect(
      provider.createBrowserSession?.({
        model: GA_MODEL,
        providerConfig: customEndpoint,
      }),
    ).rejects.toThrow("requires gateway-relay");
    expect(createBrowserSession).not.toHaveBeenCalled();
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    expect(resolveProviderAuthProfileApiKeyMock).not.toHaveBeenCalled();
  });

  it("rejects custom endpoints for the separate GPT-Live protocol", async () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const providerConfig = { ...customEndpoint, model: "gpt-live-1" };
    expect(() =>
      provider.createBridge({ providerConfig, onAudio: vi.fn(), onClearAudio: vi.fn() }),
    ).toThrow("does not support GPT-Live");
    expect(
      await readInternalRealtimeVoiceProviderApi(provider).isGatewayRelayConfiguredAsync({
        providerConfig,
      }),
    ).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("projects gateway-relay capabilities", () => {
    const expected = {
      transports: ["webrtc", "gateway-relay"],
      handlesAgentConsult: true,
      supportsToolCalls: false,
      voices: ["marin", "cedar"],
      voiceSelectionPolicy: "allowlist-default",
    };
    const { internalApi } = browserFixture();
    const resolveCapabilities = internalApi.resolveGatewayRelayCapabilities;
    for (const model of [OPAQUE_REALTIME_MODEL, "gpt-live-test-canary-alt"]) {
      expect(resolveCapabilities({ providerConfig: { model: GA_MODEL }, model })).toMatchObject(
        expected,
      );
    }
  });

  it.each([
    ["subscription", { model: SUBSCRIPTION_MODEL }, true],
    ["Platform", { model: GA_MODEL, apiKey: PLATFORM_KEY }, undefined],
  ] as const)("checks gateway-relay readiness for %s", async (_name, providerConfig, expected) => {
    mockAuthTypes("oauth");
    const { internalApi } = browserFixture();
    expect(
      await internalApi.isGatewayRelayConfiguredAsync({
        cfg: { agents: { defaults: {} } },
        providerConfig,
        agentId: "main",
      }),
    ).toBe(expected);
  });

  it("rejects forced consult routing for prefix-routed gpt-live sessions", () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const internalApi = readInternalRealtimeVoiceProviderApi(provider);
    expect(
      internalApi.validateGatewayRelayLaunch({
        providerConfig: { model: "gpt-live-future-alias" },
        autoRespondToAudio: false,
      }),
    ).toContain("cannot use forced agent consult routing");
    expect(
      internalApi.validateGatewayRelayLaunch({
        providerConfig: { model: GA_MODEL },
        autoRespondToAudio: false,
      }),
    ).toBeUndefined();
  });

  it("excludes SIWC from voice readiness and selects a separate Codex credential", async () => {
    const { store, save, provider, internalApi, request, createBrowserSession } = await authFixture(
      {
        "openai:siwc": {
          ...oauthProfile("siwc-account", "siwc-refresh"),
          authFlow: "chatgpt-token-sharing",
        },
      },
      ["openai:siwc", "openai:codex"],
    );
    save();
    expect(await internalApi.isBrowserSessionConfiguredAsync(request)).toBe(false);
    await expect(provider.createBrowserSession?.(request)).rejects.toThrow();
    expect(createBrowserSession).not.toHaveBeenCalled();
    const profile = oauthProfile("codex-account", "codex-refresh");
    const codexToken = profile.access;
    store.profiles["openai:codex"] = profile;
    save();
    expect(await internalApi.isBrowserSessionConfiguredAsync(request)).toBe(true);
    await provider.createBrowserSession?.(request);
    expect(createBrowserSession).toHaveBeenCalledWith(
      expect.any(Object),
      oauth(codexToken, "codex-account"),
    );
  });

  it("selects a pasted ChatGPT token profile for the subscription route", async () => {
    const subscriptionToken = accountToken("token-account");
    const { store, save, provider, internalApi, request, createBrowserSession } = await authFixture(
      { "openai:default": tokenProfile(subscriptionToken) },
      ["openai:default"],
    );
    save();
    expect(await internalApi.isBrowserSessionConfiguredAsync(request)).toBe(true);
    await provider.createBrowserSession?.(request);
    expect(createBrowserSession).toHaveBeenLastCalledWith(
      expect.any(Object),
      oauth(subscriptionToken, "token-account"),
    );
    // A pasted bearer without the ChatGPT account claim never shadows a usable
    // OAuth login, and falls through to Platform auth when it is the only one.
    store.profiles["openai:default"] = tokenProfile("opaque-pasted-token");
    const profile = oauthProfile("codex-account", "codex-refresh");
    const codexToken = profile.access;
    store.profiles["openai:codex"] = profile;
    save();
    const orderedRequest = {
      ...request,
      cfg: { auth: { order: { openai: ["openai:default", "openai:codex"] } } },
    };
    await provider.createBrowserSession?.(orderedRequest);
    expect(createBrowserSession).toHaveBeenLastCalledWith(
      expect.any(Object),
      oauth(codexToken, "codex-account"),
    );
    delete store.profiles["openai:codex"];
    save();
    await provider.createBrowserSession?.({
      ...request,
      providerConfig: { model: SUBSCRIPTION_MODEL, apiKey: PLATFORM_KEY },
    });
    expect(createBrowserSession).toHaveBeenLastCalledWith(expect.any(Object), {
      type: "api-key",
      token: PLATFORM_KEY,
    });
  });

  it.each([
    { name: "Platform", broker: true, auth: "api_key", supported: true },
    { name: "missing broker", broker: false, auth: "oauth", supported: false },
  ])("negotiates native Gateway control with $name", async ({ broker, auth, supported }) => {
    mockAuthTypes(auth);
    const fixture = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider(
      broker ? { quicksilverBrowserSessionBroker: fixture.broker } : undefined,
    );
    const capabilities = await readInternalRealtimeVoiceProviderApi(
      provider,
    ).resolveBrowserSessionCapabilitiesAsync({
      cfg: {},
      providerConfig: { model: OPAQUE_REALTIME_MODEL },
      clientControl: { owner: "gateway" },
    });
    expect(capabilities.supportsGatewayControl === true).toBe(supported);
    expect(capabilities.handlesAgentConsult).toBe(true);
    expect(capabilities.supportsToolCalls).toBe(false);
    expect(fixture.createBrowserSession).not.toHaveBeenCalled();
    expect(resolveProviderAuthProfileApiKeyMock).not.toHaveBeenCalled();
  });

  it("advertises GA Gateway control from the requested agent's Platform auth", async () => {
    isProviderAuthProfileConfiguredMock.mockImplementation(
      ({ agentDir, profileTypes }: { agentDir?: string; profileTypes?: readonly string[] }) =>
        agentDir === "/tmp/openclaw-molty-agent" && profileTypes?.includes("api_key") === true,
    );
    const { provider } = browserFixture();
    const cfg = {
      agents: {
        entries: {
          helper: { agentDir: "/tmp/openclaw-helper-agent" },
          molty: { agentDir: "/tmp/openclaw-molty-agent" },
        },
      },
    } as never;
    const resolveCapabilities =
      readInternalRealtimeVoiceProviderApi(provider).resolveBrowserSessionCapabilitiesAsync;
    expect(
      await resolveCapabilities({
        cfg,
        providerConfig: {},
        agentId: "molty",
        model: GA_MODEL,
      }),
    ).toMatchObject({ supportsGatewayControl: true });
    expect(
      await resolveCapabilities({
        cfg,
        providerConfig: {},
        model: GA_MODEL,
      }),
    ).not.toHaveProperty("supportsGatewayControl");
  });

  it("gives GA OAuth the same browser session policy as Platform auth", async () => {
    const oauthToken = accountToken("account-123");
    mockOAuth(oauthToken);
    mockAuthTypes("oauth");
    const { provider, createBrowserSession } = browserFixture({
      session: { clientSecret: "broker-token" },
    });
    const cfg = { agents: { defaults: {} } } as never;
    const request = {
      cfg,
      providerConfig: {},
      model: GA_MODEL,
      voice: "cedar",
      instructions: "Use the configured tools when needed.",
      vadThreshold: 0.42,
      prefixPaddingMs: 240,
      silenceDurationMs: 620,
      reasoningEffort: "low",
      tools: [createRealtimeTool("openclaw_agent_consult")],
      ...browserRequest,
    };
    expect(await provider.isConfiguredAsync?.({ cfg, providerConfig: {} })).toBe(false);
    expect(
      await readInternalRealtimeVoiceProviderApi(provider).isBrowserSessionConfiguredAsync({
        cfg,
        providerConfig: { model: GA_MODEL },
        agentId: "main",
      }),
    ).toBe(true);
    await expect(provider.createBrowserSession?.(request)).resolves.toMatchObject({
      clientSecret: "broker-token",
      offerUrl: "/plugins/openai/realtime/calls",
    });
    expect(createBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: GA_MODEL,
        voice: "cedar",
        gaSession: {
          type: "realtime",
          model: GA_MODEL,
          instructions: "Use the configured tools when needed.",
          audio: {
            input: {
              noise_reduction: { type: "near_field" },
              turn_detection: {
                type: "server_vad",
                create_response: true,
                interrupt_response: true,
                threshold: 0.42,
                prefix_padding_ms: 240,
                silence_duration_ms: 620,
              },
              transcription: { model: "gpt-4o-mini-transcribe" },
            },
            output: { voice: "cedar" },
          },
          tools: [createRealtimeTool("openclaw_agent_consult")],
          tool_choice: "auto",
          reasoning: { effort: "low" },
        },
      }),
      { type: "oauth", token: oauthToken, accountId: "account-123" },
    );
    const brokerRequest = requireRecord(
      createBrowserSession.mock.calls[0]?.[0],
      "OAuth broker request",
    );
    const gaSession = requireRecord(brokerRequest.gaSession, "OAuth GA session");
    expect(gaSession).not.toHaveProperty("output_modalities");
    expect(gaSession).not.toHaveProperty("initial_items");
    expect(requireRecord(gaSession.audio, "OAuth GA audio").input).not.toHaveProperty("format");
    expect(requireRecord(gaSession.audio, "OAuth GA audio").output).not.toHaveProperty("format");
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    mockRealtimeClientSecretResponse();
    await provider.createBrowserSession?.({
      ...request,
      providerConfig: { apiKey: PLATFORM_KEY },
    });
    expect(gaSession).toEqual(requireFetchJsonBody().session);
    expect(createBrowserSession).toHaveBeenCalledTimes(1);
  });

  it.each([{ model: SUBSCRIPTION_MODEL, voice: "cove" }])(
    "passes $model voice and channel instructions to the native broker",
    async ({ model, voice }) => {
      const { provider, createBrowserSession } = browserFixture();
      await provider.createBrowserSession?.({
        providerConfig: await provider.resolveConfigAsync?.({
          cfg: {} as never,
          rawConfig: { apiKey: PLATFORM_KEY, model, speakerVoice: voice },
        }),
        instructions: "Always address the caller as Captain.",
        ...browserRequest,
        agentId: "voice-agent",
        runAgentConsult: vi.fn(async () => ({ text: "Done" })),
      } as never);
      expect(createBrowserSession).toHaveBeenCalledWith(expect.objectContaining({ model, voice }), {
        type: "api-key",
        token: PLATFORM_KEY,
      });
      const quicksilverRequest = requireRecord(
        createBrowserSession.mock.calls[0]?.[0],
        "quicksilver request",
      );
      expect(quicksilverRequest.instructions).toMatch(/^You are OpenClaw's realtime voice layer\./);
      for (const instruction of [
        "Delegate each user request once and wait for its result.",
        "New user follow-ups, corrections, and explicit retries are new requests.",
        "Context on the commentary channel is silent background",
        "Context on the speakable channel is your answer",
      ]) {
        expect(quicksilverRequest.instructions).toContain(instruction);
      }
      expect(quicksilverRequest.instructions).toMatch(/Always address the caller as Captain\.$/);
    },
  );

  it.each(["gpt-live-1"])("rejects OAuth-only %s before broker session creation", async (model) => {
    mockOAuth();
    const { provider, createBrowserSession } = browserFixture();
    await expect(
      provider.createBrowserSession?.({
        providerConfig: {},
        model,
      }),
    ).rejects.toThrow("GPT-Live Talk requires an OpenAI Platform API key");
    expect(createBrowserSession).not.toHaveBeenCalled();
  });

  it.each([
    ["direct", undefined, "OpenAI GPT-Live transport failed"],
    [
      "gateway",
      vi.fn(async () => ({ text: "Done" })),
      "GPT-Live Talk requires an OpenAI Platform API key",
    ],
  ] as const)(
    "rejects OAuth-only gpt-live %s startup before provider I/O",
    async (_name, runAgentConsult, expectedMessage) => {
      mockOAuth();
      const provider = buildOpenAIRealtimeVoiceProvider();
      const bridge = provider.createBridge({
        providerConfig: { model: OPAQUE_REALTIME_MODEL },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        runAgentConsult,
      });
      await expect(bridge.connect()).rejects.toThrow(expectedMessage);
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
      expect(resolveProviderAuthProfileApiKeyMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ profileTypes: ["oauth"] }),
      );
    },
  );
});
