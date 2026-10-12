// Openai tests cover realtime voice provider plugin behavior.
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

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>();
  return {
    ...actual,
    isProviderAuthProfileConfigured: mocks.isProviderAuthProfileConfiguredMock,
    isProviderAuthProfileConfiguredAsync: mocks.isProviderAuthProfileConfiguredMock,
    resolveProviderAuthProfileApiKey: mocks.resolveProviderAuthProfileApiKeyMock,
  };
});
import { createOpenAIRealtimeTestSupport } from "./realtime-voice-test-support.js";

const OPAQUE_REALTIME_MODEL = "gpt-live-test-canary";

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

describe("OpenAI realtime voice provider routing", () => {
  beforeEach(() => {
    resetTestState();
  });

  afterEach(() => {
    restoreTestEnvironment();
  });

  it("keeps custom endpoints on the GA relay instead of the default GPT-Live route", () => {
    const provider = buildOpenAIRealtimeVoiceProvider();
    const rawConfig = { baseUrl: "wss://voice.example.test/realtime", apiKey: "test-realtime-key" };
    expect(
      provider.resolveConfig?.({ cfg: {}, rawConfig, surface: "gateway-relay" }),
    ).toMatchObject({
      ...rawConfig,
      model: "gpt-realtime-2.1",
    });
    const internalApi = readInternalRealtimeVoiceProviderApi(provider);
    expect(internalApi.isBrowserSessionConfigured({ providerConfig: rawConfig })).toBe(false);
    expect(
      internalApi.resolveBrowserSessionCapabilities({ providerConfig: rawConfig }),
    ).toMatchObject({
      transports: ["gateway-relay"],
      supportsBrowserSession: false,
    });
  });

  it.each(["gpt-realtime-2.1"])(
    "rejects custom endpoint browser sessions before auth or broker calls (%s)",
    async (model) => {
      const { broker, createBrowserSession } = createQuicksilverBrowserBrokerFixture();
      const provider = buildOpenAIRealtimeVoiceProvider({
        quicksilverBrowserSessionBroker: broker,
      });
      await expect(
        provider.createBrowserSession?.({
          model,
          providerConfig: {
            baseUrl: "wss://voice.example.test/realtime",
            apiKey: "test-realtime-key",
          },
        }),
      ).rejects.toThrow("requires gateway-relay");
      expect(createBrowserSession).not.toHaveBeenCalled();
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
      expect(resolveProviderAuthProfileApiKeyMock).not.toHaveBeenCalled();
    },
  );

  it.each(["gpt-live-1"])(
    "rejects custom endpoints for the separate GPT-Live protocol (%s)",
    (model) => {
      const provider = buildOpenAIRealtimeVoiceProvider();
      const providerConfig = {
        baseUrl: "wss://voice.example.test/realtime",
        apiKey: "test-realtime-key",
        model,
      };
      expect(() =>
        provider.createBridge({ providerConfig, onAudio: vi.fn(), onClearAudio: vi.fn() }),
      ).toThrow("does not support GPT-Live");
      const internalApi = readInternalRealtimeVoiceProviderApi(provider);
      expect(internalApi.isGatewayRelayConfigured({ providerConfig })).toBe(false);
      expect(FakeWebSocket.instances).toHaveLength(0);
    },
  );

  it.each([
    {
      name: "gateway-relay capability projection",
      expected: {
        transports: ["webrtc", "gateway-relay"],
        handlesAgentConsult: true,
        supportsToolCalls: false,
        voices: ["marin", "cedar"],
        voiceSelectionPolicy: "allowlist-default",
      },
    },
  ])("$name", ({ expected }) => {
    const { broker } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });
    const internalApi = readInternalRealtimeVoiceProviderApi(provider);
    const resolveCapabilities = internalApi.resolveGatewayRelayCapabilities;

    expect(
      resolveCapabilities({
        providerConfig: { model: "gpt-realtime-2.1" },
        model: OPAQUE_REALTIME_MODEL,
      }),
    ).toMatchObject(expected);
    expect(
      resolveCapabilities({
        providerConfig: { model: "gpt-realtime-2.1" },
        model: "gpt-live-test-canary-alt",
      }),
    ).toMatchObject(expected);
  });

  it.each([
    {
      name: "gateway-relay | released model | ChatGPT OAuth | standard endpoint | ready",
      providerConfig: { model: "gpt-live-1-codex" },
      agentId: "main",
      expected: true,
    },
    {
      name: "gateway-relay | gpt-realtime-2.1 | Platform API key | standard endpoint | not applicable",
      providerConfig: { model: "gpt-realtime-2.1", apiKey: "test-api-key-platform" },
      agentId: "main",
      expected: undefined,
    },
  ])("$name", ({ providerConfig, agentId, expected }) => {
    isProviderAuthProfileConfiguredMock.mockImplementation(
      ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes("oauth") === true,
    );
    const { broker } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });
    const cfg = { agents: { defaults: {} } } as never;
    const internalApi = readInternalRealtimeVoiceProviderApi(provider);
    const readiness = internalApi.isGatewayRelayConfigured({ cfg, providerConfig, agentId });

    expect(readiness).toBe(expected);
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
        providerConfig: { model: "gpt-realtime-2.1" },
        autoRespondToAudio: false,
      }),
    ).toBeUndefined();
  });

  it("prefers ChatGPT OAuth for the released route and falls back to Platform auth", async () => {
    const oauthToken = createTestJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
    });
    resolveProviderAuthProfileApiKeyMock.mockImplementation(
      async ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes("oauth") ? oauthToken : undefined,
    );
    const { broker, createBrowserSession } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });
    const request = {
      providerConfig: { apiKey: "test-api-key-platform" },
      model: "gpt-live-1-codex",
      agentId: "main",
      workspaceDir: "/tmp/openclaw-agent-workspace",
      initialItems: [],
      runAgentConsult: vi.fn(async () => ({ text: "Done" })),
    };

    await provider.createBrowserSession?.(request);
    expect(createBrowserSession).toHaveBeenLastCalledWith(expect.any(Object), {
      type: "oauth",
      token: oauthToken,
      accountId: "account-123",
    });

    resolveProviderAuthProfileApiKeyMock.mockResolvedValue(undefined);
    await provider.createBrowserSession?.(request);
    expect(createBrowserSession).toHaveBeenLastCalledWith(expect.any(Object), {
      type: "api-key",
      token: "test-api-key-platform",
    });
  });

  it("excludes SIWC from voice readiness and selects a separate Codex credential", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-voice-capabilities-"));
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:siwc": {
          type: "oauth",
          provider: "openai",
          authFlow: "chatgpt-token-sharing",
          access: createTestJwt({
            "https://api.openai.com/auth": { chatgpt_account_id: "siwc-account" },
          }),
          refresh: "siwc-refresh",
          expires: Date.now() + 3_600_000,
        },
      },
    };
    const realAuth = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-auth")>(
      "openclaw/plugin-sdk/provider-auth",
    );
    isProviderAuthProfileConfiguredMock.mockImplementation((params) =>
      realAuth.isProviderAuthProfileConfigured({ ...params, agentDir }),
    );
    resolveProviderAuthProfileApiKeyMock.mockImplementation((params) =>
      realAuth.resolveProviderAuthProfileApiKey({ ...params, agentDir }),
    );
    const { broker, createBrowserSession } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({ quicksilverBrowserSessionBroker: broker });
    const internalApi = readInternalRealtimeVoiceProviderApi(provider);
    const cfg = { auth: { order: { openai: ["openai:siwc", "openai:codex"] } } };
    const request = {
      cfg,
      providerConfig: { model: "gpt-live-1-codex" },
      model: "gpt-live-1-codex",
      agentId: "main",
      workspaceDir: "/tmp/openclaw-agent-workspace",
      initialItems: [],
    };
    try {
      saveAuthProfileStore(store, agentDir, {
        filterExternalAuthProfiles: false,
        syncExternalCli: false,
      });
      expect(internalApi.isBrowserSessionConfigured(request)).toBe(false);
      await expect(provider.createBrowserSession?.(request)).rejects.toThrow();
      expect(createBrowserSession).not.toHaveBeenCalled();

      const codexToken = createTestJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "codex-account" },
      });
      store.profiles["openai:codex"] = {
        type: "oauth",
        provider: "openai",
        access: codexToken,
        refresh: "codex-refresh",
        expires: Date.now() + 3_600_000,
      };
      saveAuthProfileStore(store, agentDir, {
        filterExternalAuthProfiles: false,
        syncExternalCli: false,
      });
      expect(internalApi.isBrowserSessionConfigured(request)).toBe(true);
      await provider.createBrowserSession?.(request);
      expect(createBrowserSession).toHaveBeenCalledWith(expect.any(Object), {
        type: "oauth",
        token: codexToken,
        accountId: "codex-account",
      });
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      closeOpenClawAgentDatabasesForTest();
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "Platform", broker: true, auth: "api_key", supported: true },
    { name: "missing broker", broker: false, auth: "oauth", supported: false },
  ])("negotiates native Gateway control with $name", ({ broker, auth, supported }) => {
    isProviderAuthProfileConfiguredMock.mockImplementation(
      ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes(auth) === true,
    );
    const fixture = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider(
      broker ? { quicksilverBrowserSessionBroker: fixture.broker } : undefined,
    );
    const capabilities = readInternalRealtimeVoiceProviderApi(
      provider,
    ).resolveBrowserSessionCapabilities({
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

  it("advertises GA Gateway control from the requested agent's Platform auth", () => {
    isProviderAuthProfileConfiguredMock.mockImplementation(
      ({ agentDir, profileTypes }: { agentDir?: string; profileTypes?: readonly string[] }) =>
        agentDir === "/tmp/openclaw-molty-agent" && profileTypes?.includes("api_key") === true,
    );
    const { broker } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });
    const cfg = {
      agents: {
        entries: {
          helper: { agentDir: "/tmp/openclaw-helper-agent" },
          molty: { agentDir: "/tmp/openclaw-molty-agent" },
        },
      },
    } as never;
    const resolveCapabilities =
      readInternalRealtimeVoiceProviderApi(provider).resolveBrowserSessionCapabilities;

    expect(
      resolveCapabilities({
        cfg,
        providerConfig: {},
        agentId: "molty",
        model: "gpt-realtime-2.1",
      }),
    ).toMatchObject({ supportsGatewayControl: true });
    expect(
      resolveCapabilities({
        cfg,
        providerConfig: {},
        model: "gpt-realtime-2.1",
      }),
    ).not.toHaveProperty("supportsGatewayControl");
  });

  it("gives GA OAuth the same browser session policy as Platform auth", async () => {
    const oauthToken = createTestJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
    });
    resolveProviderAuthProfileApiKeyMock.mockImplementation(
      async ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes("oauth") ? oauthToken : undefined,
    );
    isProviderAuthProfileConfiguredMock.mockImplementation(
      ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes("oauth") === true,
    );
    const { broker, createBrowserSession } = createQuicksilverBrowserBrokerFixture({
      session: { clientSecret: "broker-token" },
    });
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });
    const cfg = { agents: { defaults: {} } } as never;
    const request = {
      cfg,
      providerConfig: {},
      model: "gpt-realtime-2.1",
      voice: "cedar",
      instructions: "Use the configured tools when needed.",
      vadThreshold: 0.42,
      prefixPaddingMs: 240,
      silenceDurationMs: 620,
      reasoningEffort: "low",
      tools: [createRealtimeTool("openclaw_agent_consult")],
      agentId: "main",
      workspaceDir: "/tmp/openclaw-agent-workspace",
      initialItems: [],
    };

    expect(provider.isConfigured({ cfg, providerConfig: {} })).toBe(false);
    expect(
      readInternalRealtimeVoiceProviderApi(provider).isBrowserSessionConfigured({
        cfg,
        providerConfig: { model: "gpt-realtime-2.1" },
        agentId: "main",
      }),
    ).toBe(true);
    await expect(provider.createBrowserSession?.(request)).resolves.toMatchObject({
      clientSecret: "broker-token",
      offerUrl: "/plugins/openai/realtime/calls",
    });
    expect(createBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-realtime-2.1",
        voice: "cedar",
        gaSession: {
          type: "realtime",
          model: "gpt-realtime-2.1",
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
      providerConfig: { apiKey: "test-api-key-platform" },
    });
    expect(gaSession).toEqual(requireFetchJsonBody().session);
    expect(createBrowserSession).toHaveBeenCalledTimes(1);
  });

  it.each([{ model: "gpt-live-1-codex", voice: "cove" }])(
    "passes $model voice and channel instructions to the native broker",
    async ({ model, voice }) => {
      const { broker, createBrowserSession } = createQuicksilverBrowserBrokerFixture();
      const provider = buildOpenAIRealtimeVoiceProvider({
        quicksilverBrowserSessionBroker: broker,
      });

      await provider.createBrowserSession?.({
        providerConfig: provider.resolveConfig?.({
          cfg: {} as never,
          rawConfig: {
            apiKey: "test-api-key-platform",
            model,
            speakerVoice: voice,
          },
        }),
        instructions: "Always address the caller as Captain.",
        agentId: "voice-agent",
        workspaceDir: "/tmp/openclaw-agent-workspace",
        initialItems: [],
        runAgentConsult: vi.fn(async () => ({ text: "Done" })),
      } as never);

      expect(createBrowserSession).toHaveBeenCalledWith(expect.objectContaining({ model, voice }), {
        type: "api-key",
        token: "test-api-key-platform",
      });
      const quicksilverRequest = requireRecord(
        createBrowserSession.mock.calls[0]?.[0],
        "quicksilver request",
      );
      expect(quicksilverRequest.instructions).toMatch(/^You are OpenClaw's realtime voice layer\./);
      expect(quicksilverRequest.instructions).toContain(
        "Delegate each user request once and wait for its result.",
      );
      expect(quicksilverRequest.instructions).toContain(
        "New user follow-ups, corrections, and explicit retries are new requests.",
      );
      expect(quicksilverRequest.instructions).toContain(
        "Context on the commentary channel is silent background",
      );
      expect(quicksilverRequest.instructions).toContain(
        "Context on the speakable channel is your answer",
      );
      expect(quicksilverRequest.instructions).toMatch(/Always address the caller as Captain\.$/);
    },
  );

  it.each(["gpt-live-1"])("rejects OAuth-only %s before broker session creation", async (model) => {
    resolveProviderAuthProfileApiKeyMock.mockImplementation(
      async ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes("oauth")
          ? createTestJwt({
              "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
            })
          : undefined,
    );
    const { broker, createBrowserSession } = createQuicksilverBrowserBrokerFixture();
    const provider = buildOpenAIRealtimeVoiceProvider({
      quicksilverBrowserSessionBroker: broker,
    });

    await expect(
      provider.createBrowserSession?.({
        providerConfig: {},
        model,
      }),
    ).rejects.toThrow("GPT-Live Talk requires an OpenAI Platform API key");
    expect(createBrowserSession).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "unlisted direct",
      model: OPAQUE_REALTIME_MODEL,
      runAgentConsult: undefined,
      expectedMessage: "OpenAI GPT-Live transport failed",
    },
    {
      name: "unlisted gateway",
      model: OPAQUE_REALTIME_MODEL,
      runAgentConsult: vi.fn(async () => ({ text: "Done" })),
      expectedMessage: "GPT-Live Talk requires an OpenAI Platform API key",
    },
  ])(
    "rejects OAuth-only gpt-live $name startup before provider I/O",
    async ({ model, runAgentConsult, expectedMessage }) => {
      resolveProviderAuthProfileApiKeyMock.mockImplementation(
        async ({ profileTypes }: { profileTypes?: readonly string[] }) =>
          profileTypes?.includes("oauth")
            ? createTestJwt({
                "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
              })
            : undefined,
      );
      const provider = buildOpenAIRealtimeVoiceProvider();
      const bridge = provider.createBridge({
        providerConfig: { model },
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
