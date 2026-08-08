import { randomUUID } from "node:crypto";
import {
  parseModelRef,
  resolveAgentEffectiveModelPrimary,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveProviderAuthProfileApiKey } from "openclaw/plugin-sdk/provider-auth";
import {
  convertPcmToMulaw8k,
  mulawToPcm,
  resamplePcm,
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceBridge,
  type RealtimeVoiceBridgeCreateRequest,
  type RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveRealtimeVersion(providerConfig: Record<string, unknown>): "v1" | "v2" | "v3" {
  const version = normalizeOptionalString(providerConfig.version) ?? "v3";
  if (version === "v1" || version === "v2" || version === "v3") {
    return version;
  }
  throw new Error('Codex realtime version must be "v1", "v2", or "v3"');
}

function hasOpenAIPlatformApiKey(
  cfg: OpenClawConfig | undefined,
  providerConfig?: Record<string, unknown>,
): boolean {
  if (providerConfig?.apiKey) {
    return true;
  }
  if (process.env.OPENAI_API_KEY?.trim()) {
    return true;
  }
  if (cfg?.models?.providers?.openai?.apiKey) {
    return true;
  }
  if (
    Object.values(cfg?.auth?.profiles ?? {}).some(
      (profile) => profile.provider === "openai" && profile.mode === "api_key",
    )
  ) {
    return true;
  }
  return false;
}

async function resolveOpenAIPlatformApiKey(params: {
  request: RealtimeVoiceBridgeCreateRequest;
  agentDir: string;
}): Promise<string> {
  const configured = normalizeResolvedSecretInputString({
    value:
      params.request.providerConfig.apiKey ?? params.request.cfg?.models?.providers?.openai?.apiKey,
    path: "channels.discord.voice.realtime.providers.codex.apiKey",
  });
  if (configured) {
    return configured;
  }
  const profileApiKey = await resolveProviderAuthProfileApiKey({
    provider: "openai",
    cfg: params.request.cfg,
    agentDir: params.agentDir,
    profileTypes: ["api_key"],
    includeExternalCliAuth: false,
  });
  if (profileApiKey) {
    return profileApiKey;
  }
  const envApiKey = process.env.OPENAI_API_KEY?.trim();
  if (envApiKey) {
    return envApiKey;
  }
  throw new Error(
    "Codex realtime requires a selected OpenAI Platform API key from provider config, an OpenAI API-key auth profile, or OPENAI_API_KEY",
  );
}

async function resolveBoundVoiceRun(params: {
  runtime: PluginRuntime;
  request: RealtimeVoiceBridgeCreateRequest;
  abortSignal: AbortSignal;
  isStartupCommitted: () => boolean;
  onBridgeReady: (bridge: RealtimeVoiceBridge) => void;
}) {
  const cfg = params.request.cfg;
  const sessionKey = params.request.sessionKey?.trim();
  const senderId = normalizeOptionalString(params.request.senderId);
  if (!cfg || !sessionKey || !senderId || params.request.senderIsOwner !== true) {
    throw new Error(
      "Codex realtime voice requires a verified owner identity on a bound OpenClaw session",
    );
  }
  const agentId = params.request.agentId?.trim() || "main";
  const storePath = params.runtime.agent.session.resolveStorePath(cfg.session?.store, {
    agentId,
  });
  const sessionEntryBeforeClaim = params.runtime.agent.session.getSessionEntry({
    agentId,
    sessionKey,
    storePath,
    readConsistency: "latest",
  });
  const boundHarnessId = sessionEntryBeforeClaim?.agentHarnessId?.trim();
  if (boundHarnessId && boundHarnessId !== "codex") {
    throw new Error(
      `Codex realtime voice cannot replace session ${sessionKey} owner ${boundHarnessId}`,
    );
  }
  const now = Date.now();
  const sessionEntry =
    (await params.runtime.agent.session.patchSessionEntry({
      agentId,
      sessionKey,
      storePath,
      fallbackEntry: { sessionId: "", updatedAt: now },
      update: (entry) => {
        const currentOwner = entry.agentHarnessId?.trim();
        if (currentOwner && currentOwner !== "codex") {
          throw new Error(
            `Codex realtime voice cannot replace session ${sessionKey} owner ${currentOwner}`,
          );
        }
        return {
          ...(!entry.sessionId?.trim() ? { sessionId: randomUUID() } : {}),
          agentHarnessId: "codex",
          updatedAt: now,
        };
      },
    })) ?? undefined;
  if (!sessionEntry?.sessionId) {
    throw new Error(`Codex realtime voice could not resolve session ${sessionKey}`);
  }

  const configuredModel =
    sessionEntry.providerOverride && sessionEntry.modelOverride
      ? `${sessionEntry.providerOverride}/${sessionEntry.modelOverride}`
      : (resolveAgentEffectiveModelPrimary(cfg, agentId) ??
        `${params.runtime.agent.defaults.provider}/${params.runtime.agent.defaults.model}`);
  const modelRef = parseModelRef(configuredModel, params.runtime.agent.defaults.provider);
  if (!modelRef) {
    throw new Error(`Codex realtime voice could not resolve model ${configuredModel}`);
  }
  const workspaceDir = params.runtime.agent.resolveAgentWorkspaceDir(cfg, agentId);
  const agentDir = params.runtime.agent.resolveAgentDir(cfg, agentId);
  const version = resolveRealtimeVersion(params.request.providerConfig);
  const providerConfig = { ...params.request.providerConfig };
  if (version === "v3") {
    // V3 uses the app-server's selected ChatGPT subscription profile. Do not let
    // an ambient or legacy Platform key silently replace that OAuth identity.
    delete providerConfig.apiKey;
  } else {
    providerConfig.apiKey = await resolveOpenAIPlatformApiKey({
      request: params.request,
      agentDir,
    });
  }
  const realtimeRequest = {
    ...params.request,
    providerConfig,
  };
  const timeoutMs = params.runtime.agent.resolveAgentTimeoutMs({ cfg });
  try {
    return await params.runtime.agent.runEmbeddedAgent({
      sessionId: sessionEntry.sessionId,
      sessionKey,
      sessionTarget: { agentId, sessionId: sessionEntry.sessionId, sessionKey, storePath },
      sandboxSessionKey: sessionKey,
      agentId,
      messageProvider: "voice",
      senderId,
      senderIsOwner: true,
      workspaceDir,
      agentDir,
      config: cfg,
      prompt: "",
      provider: modelRef.provider,
      model: modelRef.model,
      modelSelectionLocked: sessionEntry.modelSelectionLocked === true,
      agentHarnessId: "codex",
      agentHarnessRuntimeOverride: "codex",
      timeoutMs,
      runId: `codex-realtime-voice:${randomUUID()}`,
      lane: "voice",
      abortSignal: params.abortSignal,
      realtimeVoice: {
        request: realtimeRequest,
        onBridgeReady: (bridge) => {
          params.onBridgeReady(bridge);
        },
      },
    });
  } finally {
    if (!params.isStartupCommitted()) {
      await params.runtime.agent.session.patchSessionEntry({
        agentId,
        sessionKey,
        storePath,
        fallbackEntry: { sessionId: "", updatedAt: now },
        replaceEntry: true,
        update: (current) => {
          if (
            current.agentHarnessId !== "codex" ||
            current.sessionId !== sessionEntry.sessionId ||
            current.updatedAt !== sessionEntry.updatedAt
          ) {
            return null;
          }
          return sessionEntryBeforeClaim ?? { sessionId: "", updatedAt: now };
        },
      });
    }
  }
}

class CodexBoundRealtimeVoiceBridge implements RealtimeVoiceBridge {
  readonly handlesInputAudioBargeIn = true;
  readonly supportsToolResultContinuation = false;
  readonly supportsToolResultSuppression = false;
  private readonly abortController = new AbortController();
  private inner?: RealtimeVoiceBridge;
  private run?: Promise<unknown>;
  private closed = false;
  private startupCommitted = false;
  private readonly audioFormat;
  private readonly codexRequest: RealtimeVoiceBridgeCreateRequest;

  constructor(
    private readonly runtime: PluginRuntime,
    private readonly request: RealtimeVoiceBridgeCreateRequest,
  ) {
    this.audioFormat = request.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ;
    this.codexRequest = {
      ...request,
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onAudio: (audio) =>
        request.onAudio(
          this.audioFormat.encoding === "g711_ulaw"
            ? convertPcmToMulaw8k(audio, REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz)
            : audio,
        ),
    };
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error("Codex realtime voice bridge is closed");
    }
    if (this.inner) {
      await this.inner.connect();
      return;
    }
    let resolveBridge!: (bridge: RealtimeVoiceBridge) => void;
    let rejectBridge!: (error: Error) => void;
    const bridgeReady = new Promise<RealtimeVoiceBridge>((resolve, reject) => {
      resolveBridge = resolve;
      rejectBridge = reject;
    });
    this.run = resolveBoundVoiceRun({
      runtime: this.runtime,
      request: this.codexRequest,
      abortSignal: this.abortController.signal,
      isStartupCommitted: () => this.startupCommitted,
      onBridgeReady: resolveBridge,
    }).catch((error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(formatErrorMessage(error));
      rejectBridge(normalized);
      if (!this.closed) {
        this.request.onError?.(normalized);
        this.request.onClose?.("error");
      }
      throw normalized;
    });
    this.run.catch(() => undefined);
    this.inner = await bridgeReady;
    if (this.closed) {
      this.inner.close();
      throw new Error("Codex realtime voice bridge was closed during startup");
    }
    try {
      await this.inner.connect();
      this.startupCommitted = true;
    } catch (error) {
      this.abortController.abort(error);
      await this.run.catch(() => undefined);
      throw error;
    }
  }

  sendAudio(audio: Buffer): void {
    const pcm = this.audioFormat.encoding === "g711_ulaw" ? mulawToPcm(audio) : audio;
    this.requireInner().sendAudio(
      resamplePcm(
        pcm,
        this.audioFormat.sampleRateHz,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz,
      ),
    );
  }

  setMediaTimestamp(ts: number): void {
    this.inner?.setMediaTimestamp(ts);
  }

  sendUserMessage(text: string): void {
    this.requireInner().sendUserMessage?.(text);
  }

  triggerGreeting(instructions?: string): void {
    this.requireInner().triggerGreeting?.(instructions);
  }

  handleBargeIn(): void {
    // Codex Realtime V3 owns VAD, interruption, and response cancellation.
  }

  submitToolResult(): never {
    throw new Error("Codex realtime voice runs bound agent tools natively");
  }

  acknowledgeMark(markName?: string): void {
    this.inner?.acknowledgeMark(markName);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.inner) {
      this.inner.close();
    } else {
      this.abortController.abort(new Error("Codex realtime voice bridge closed"));
    }
  }

  isConnected(): boolean {
    return !this.closed && (this.inner?.isConnected() ?? false);
  }

  private requireInner(): RealtimeVoiceBridge {
    if (!this.inner || this.closed) {
      throw new Error("Codex realtime voice bridge is not connected");
    }
    return this.inner;
  }
}

export function buildCodexRealtimeVoiceProvider(options: {
  runtime: PluginRuntime;
}): RealtimeVoiceProviderPlugin {
  return {
    id: "codex",
    label: "Codex Realtime",
    aliases: ["codex-realtime"],
    defaultModel: "gpt-live-1-codex",
    models: ["gpt-live-1-codex", "gpt-realtime-1.5"],
    autoSelectOrder: 40,
    capabilities: {
      transports: ["provider-websocket"],
      inputAudioFormats: [
        REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      outputAudioFormats: [
        REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      supportsBargeIn: true,
      handlesInputAudioBargeIn: true,
      supportsToolCalls: false,
      handlesAgentTurns: true,
      requiresBoundAgentSession: true,
    },
    resolveConfig: ({ rawConfig }) => ({
      ...(normalizeOptionalString(rawConfig.model)
        ? { model: normalizeOptionalString(rawConfig.model) }
        : {}),
      ...(normalizeOptionalString(rawConfig.voice)
        ? { voice: normalizeOptionalString(rawConfig.voice) }
        : {}),
      ...(normalizeOptionalString(rawConfig.version)
        ? { version: normalizeOptionalString(rawConfig.version) }
        : {}),
      ...(normalizeOptionalString(rawConfig.apiKey)
        ? { apiKey: normalizeOptionalString(rawConfig.apiKey) }
        : {}),
    }),
    isConfigured: ({ cfg, providerConfig }) =>
      // V3 auth belongs to the agent-scoped Codex app-server home and is only
      // resolvable once the bound agent directory is known at connect time.
      resolveRealtimeVersion(providerConfig) === "v3" ||
      hasOpenAIPlatformApiKey(cfg, providerConfig),
    createBridge: (request) => new CodexBoundRealtimeVoiceBridge(options.runtime, request),
  };
}
