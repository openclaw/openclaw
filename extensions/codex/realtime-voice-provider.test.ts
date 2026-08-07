import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCodexRealtimeVoiceProvider } from "./realtime-voice-provider.js";

function createRuntime(
  options: {
    missingSession?: boolean;
    nativeConnectFailure?: Error;
    replaceSessionBeforeRunFailure?: Record<string, unknown>;
    runFailureBeforeReady?: Error;
    sessionHarnessId?: string;
    patchSessionHarnessId?: string;
  } = {},
) {
  let attempt: Record<string, unknown> | undefined;
  let nativeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
  let storedEntry: Record<string, unknown> | undefined = options.missingSession
    ? undefined
    : {
        sessionId: "session-1",
        updatedAt: Date.now(),
        agentHarnessId: options.sessionHarnessId ?? "codex",
      };
  const nativeBridge: RealtimeVoiceBridge = {
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    connect: vi.fn(async () => {
      if (options.nativeConnectFailure) {
        throw options.nativeConnectFailure;
      }
    }),
    isConnected: vi.fn(() => true),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    submitToolResult: vi.fn(),
  };
  const runEmbeddedAgent = vi.fn(async (params: Record<string, unknown>) => {
    attempt = params;
    const realtimeVoice = params.realtimeVoice as {
      request: RealtimeVoiceBridgeCreateRequest;
      onBridgeReady: (bridge: RealtimeVoiceBridge) => void;
    };
    nativeRequest = realtimeVoice.request;
    if (options.runFailureBeforeReady) {
      storedEntry = options.replaceSessionBeforeRunFailure ?? storedEntry;
      throw options.runFailureBeforeReady;
    }
    realtimeVoice.onBridgeReady(nativeBridge);
    await new Promise<void>((resolve) => {
      const signal = params.abortSignal as AbortSignal;
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return {};
  });
  let patchCalls = 0;
  const patchSessionEntry = vi.fn(
    async (params: {
      fallbackEntry: { sessionId: string; updatedAt: number };
      replaceEntry?: boolean;
      update: (entry: {
        sessionId: string;
        updatedAt: number;
        agentHarnessId?: string;
      }) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
    }) => {
      patchCalls += 1;
      const currentEntry = {
        ...(storedEntry ?? params.fallbackEntry),
        ...(patchCalls === 1 && options.patchSessionHarnessId
          ? { agentHarnessId: options.patchSessionHarnessId }
          : {}),
      } as { sessionId: string; updatedAt: number; agentHarnessId?: string };
      const patch = await params.update(currentEntry);
      if (!patch) {
        return storedEntry ?? null;
      }
      storedEntry = params.replaceEntry ? { ...patch } : { ...currentEntry, ...patch };
      return storedEntry;
    },
  );
  const runtime = {
    agent: {
      defaults: { provider: "openai", model: "gpt-5.4" },
      resolveAgentDir: () => "/tmp/agent",
      resolveAgentWorkspaceDir: () => "/tmp/workspace",
      resolveAgentTimeoutMs: () => 60_000,
      runEmbeddedAgent,
      session: {
        resolveStorePath: () => "/tmp/sessions.json",
        getSessionEntry: () => storedEntry,
        patchSessionEntry,
      },
    },
  } as unknown as PluginRuntime;
  return {
    runtime,
    nativeBridge,
    patchSessionEntry,
    runEmbeddedAgent,
    getAttempt: () => attempt,
    getNativeRequest: () => nativeRequest,
    getStoredEntry: () => storedEntry,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Codex realtime voice provider", () => {
  it("advertises only API-key-backed Codex realtime", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { runtime } = createRuntime();
    const provider = buildCodexRealtimeVoiceProvider({ runtime });

    expect(provider.isConfigured({ providerConfig: {}, cfg: {} as never })).toBe(false);
    expect(
      provider.isConfigured({
        providerConfig: {},
        cfg: {
          auth: { profiles: { "openai:default": { provider: "openai", mode: "api_key" } } },
        } as never,
      }),
    ).toBe(true);
    expect(provider.capabilities).toMatchObject({
      handlesAgentTurns: true,
      requiresBoundAgentSession: true,
      supportsToolCalls: false,
      handlesInputAudioBargeIn: true,
    });
    expect(
      provider.resolveConfig?.({
        rawConfig: { model: "gpt-realtime-1.5", version: "v2", voice: "cedar" },
        cfg: {} as never,
      }),
    ).toEqual({ model: "gpt-realtime-1.5", version: "v2", voice: "cedar" });
  });

  it("runs the existing bound session and adapts telephony audio", async () => {
    const harness = createRuntime();
    const provider = buildCodexRealtimeVoiceProvider({ runtime: harness.runtime });
    const onAudio = vi.fn();
    const bridge = provider.createBridge({
      cfg: { agents: { defaults: { model: "openai/gpt-5.4" } } } as never,
      agentId: "main",
      sessionKey: "agent:main:voice",
      senderId: "discord-user-1",
      senderIsOwner: true,
      providerConfig: { voice: "verse" },
      onAudio,
      onClearAudio: vi.fn(),
    });

    await bridge.connect();
    bridge.sendAudio(Buffer.from([0xff]));
    harness.getNativeRequest()?.onAudio(Buffer.alloc(6));

    expect(harness.runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(harness.getAttempt()).toMatchObject({
      sessionId: "session-1",
      sessionKey: "agent:main:voice",
      agentHarnessId: "codex",
      prompt: "",
      provider: "openai",
      model: "gpt-5.4",
      lane: "voice",
      senderId: "discord-user-1",
      senderIsOwner: true,
    });
    expect(harness.getNativeRequest()?.audioFormat).toEqual({
      encoding: "pcm16",
      sampleRateHz: 24_000,
      channels: 1,
    });
    const nativeBridge = harness.nativeBridge as typeof harness.nativeBridge & {
      close: ReturnType<typeof vi.fn>;
      sendAudio: ReturnType<typeof vi.fn>;
    };
    expect(nativeBridge.sendAudio.mock.calls).toHaveLength(1);
    expect(nativeBridge.sendAudio.mock.calls[0]?.[0]).toEqual(expect.any(Buffer));
    expect(nativeBridge.sendAudio.mock.calls[0]?.[0]).toHaveLength(6);
    expect(onAudio).toHaveBeenCalledWith(expect.any(Buffer));
    expect(onAudio.mock.calls[0]?.[0]).toHaveLength(1);

    bridge.close();
    expect(nativeBridge.close.mock.calls).toHaveLength(1);
  });

  it("selects and forwards the realtime v2 Platform key explicitly", async () => {
    vi.stubEnv("OPENAI_API_KEY", "selected-realtime-key");
    const harness = createRuntime();
    const provider = buildCodexRealtimeVoiceProvider({ runtime: harness.runtime });
    const bridge = provider.createBridge({
      cfg: { agents: { defaults: { model: "openai/gpt-5.4" } } } as never,
      agentId: "main",
      sessionKey: "agent:main:voice",
      senderId: "discord-user-1",
      senderIsOwner: true,
      providerConfig: { version: "v2" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await bridge.connect();
    expect(harness.getNativeRequest()?.providerConfig).toMatchObject({
      version: "v2",
      apiKey: "selected-realtime-key",
    });
    bridge.close();
  });

  it("fails realtime v2 before app-server startup when no Platform key can be selected", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const harness = createRuntime();
    const provider = buildCodexRealtimeVoiceProvider({ runtime: harness.runtime });
    const bridge = provider.createBridge({
      cfg: {} as never,
      agentId: "main",
      sessionKey: "agent:main:voice",
      senderId: "discord-user-1",
      senderIsOwner: true,
      providerConfig: { version: "v2" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await expect(bridge.connect()).rejects.toThrow("requires a selected OpenAI Platform API key");
    expect(harness.runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("creates a normal session entry when the routed binding is new", async () => {
    const harness = createRuntime({ missingSession: true });
    const provider = buildCodexRealtimeVoiceProvider({ runtime: harness.runtime });
    const bridge = provider.createBridge({
      cfg: { agents: { defaults: { model: "openai/gpt-5.4" } } } as never,
      agentId: "main",
      sessionKey: "agent:main:new-voice",
      senderId: "discord-user-1",
      senderIsOwner: true,
      providerConfig: {},
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await bridge.connect();
    expect(harness.patchSessionEntry.mock.calls).toHaveLength(1);
    const attempt = harness.getAttempt();
    expect(attempt).toMatchObject({
      sessionId: expect.any(String),
      sessionKey: "agent:main:new-voice",
      agentHarnessId: "codex",
      agentHarnessRuntimeOverride: "codex",
    });
    expect(attempt?.sessionId).toEqual(expect.stringMatching(/\S/u));
    bridge.close();
  });

  it("does not replace a session owned by another harness", async () => {
    const harness = createRuntime({ sessionHarnessId: "openclaw" });
    const provider = buildCodexRealtimeVoiceProvider({ runtime: harness.runtime });
    const bridge = provider.createBridge({
      cfg: { agents: { defaults: { model: "openai/gpt-5.4" } } } as never,
      sessionKey: "agent:main:owned",
      senderId: "discord-user-1",
      senderIsOwner: true,
      providerConfig: {},
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await expect(bridge.connect()).rejects.toThrow(
      "Codex realtime voice cannot replace session agent:main:owned owner openclaw",
    );
    expect(harness.runEmbeddedAgent.mock.calls).toHaveLength(0);
  });

  it("fails closed without a verified owner identity", async () => {
    const harness = createRuntime();
    const provider = buildCodexRealtimeVoiceProvider({ runtime: harness.runtime });
    const bridge = provider.createBridge({
      cfg: {} as never,
      sessionKey: "agent:main:voice",
      senderIsOwner: true,
      providerConfig: {},
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await expect(bridge.connect()).rejects.toThrow(
      "Codex realtime voice requires a verified owner identity on a bound OpenClaw session",
    );
    expect(harness.runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("rechecks session ownership inside the atomic claim", async () => {
    const harness = createRuntime({ patchSessionHarnessId: "openclaw" });
    const provider = buildCodexRealtimeVoiceProvider({ runtime: harness.runtime });
    const bridge = provider.createBridge({
      cfg: {} as never,
      sessionKey: "agent:main:raced",
      senderId: "discord-user-1",
      senderIsOwner: true,
      providerConfig: {},
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await expect(bridge.connect()).rejects.toThrow(
      "Codex realtime voice cannot replace session agent:main:raced owner openclaw",
    );
    expect(harness.runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("rolls back a new session claim when startup fails before the bridge is ready", async () => {
    const harness = createRuntime({
      missingSession: true,
      runFailureBeforeReady: new Error("startup failed"),
    });
    const provider = buildCodexRealtimeVoiceProvider({ runtime: harness.runtime });
    const bridge = provider.createBridge({
      cfg: { agents: { defaults: { model: "openai/gpt-5.4" } } } as never,
      sessionKey: "agent:main:failed-voice",
      senderId: "discord-user-1",
      senderIsOwner: true,
      providerConfig: {},
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await expect(bridge.connect()).rejects.toThrow("startup failed");
    expect(harness.patchSessionEntry).toHaveBeenCalledTimes(2);
    expect(harness.getStoredEntry()).toEqual({ sessionId: "", updatedAt: expect.any(Number) });
  });

  it("does not roll back over a newer session claim", async () => {
    const successor = {
      sessionId: "successor-session",
      updatedAt: Date.now() + 1,
      agentHarnessId: "codex",
    };
    const harness = createRuntime({
      missingSession: true,
      replaceSessionBeforeRunFailure: successor,
      runFailureBeforeReady: new Error("older startup failed"),
    });
    const provider = buildCodexRealtimeVoiceProvider({ runtime: harness.runtime });
    const bridge = provider.createBridge({
      cfg: { agents: { defaults: { model: "openai/gpt-5.4" } } } as never,
      sessionKey: "agent:main:raced-rollback",
      senderId: "discord-user-1",
      senderIsOwner: true,
      providerConfig: {},
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await expect(bridge.connect()).rejects.toThrow("older startup failed");
    expect(harness.getStoredEntry()).toEqual(successor);
  });

  it("rolls back when the native realtime bridge itself fails to connect", async () => {
    const harness = createRuntime({
      missingSession: true,
      nativeConnectFailure: new Error("realtime start failed"),
    });
    const provider = buildCodexRealtimeVoiceProvider({ runtime: harness.runtime });
    const bridge = provider.createBridge({
      cfg: { agents: { defaults: { model: "openai/gpt-5.4" } } } as never,
      sessionKey: "agent:main:native-start-failed",
      senderId: "discord-user-1",
      senderIsOwner: true,
      providerConfig: {},
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await expect(bridge.connect()).rejects.toThrow("realtime start failed");
    expect(harness.getStoredEntry()).toEqual({ sessionId: "", updatedAt: expect.any(Number) });
  });
});
