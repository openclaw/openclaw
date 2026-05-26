import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { r as RunEmbeddedPiAgentParams } from "./params-C8lj3xSa.js";
import { o as PluginRuntimeCore, s as RuntimeLogger } from "./types-core-DxqEkbXr.js";
import { Br as RealtimeVoiceBridgeEvent, Fr as RealtimeVoiceAudioFormat, Gr as RealtimeVoiceProviderConfig, Ir as RealtimeVoiceBargeInOptions, Lr as RealtimeVoiceBridge, Qr as RealtimeVoiceToolResultOptions, Ur as RealtimeVoiceCloseReason, Wn as RealtimeVoiceProviderPlugin, Xr as RealtimeVoiceTool, Yr as RealtimeVoiceRole, Zr as RealtimeVoiceToolCallEvent, qr as RealtimeVoiceProviderId } from "./types-Vx7Jq4_-2.js";
import { Dt as TalkEventInput, Et as TalkEventContext, Ot as TalkEventSequencer, Tt as TalkEvent, r as DiagnosticEventInput } from "./diagnostic-events-C_Kyi8bL.js";
import { randomUUID } from "node:crypto";

//#region src/talk/diagnostics.d.ts
type TalkDiagnosticEventInput = Extract<DiagnosticEventInput, {
  type: "talk.event";
}>;
declare function createTalkDiagnosticEvent(event: TalkEvent): TalkDiagnosticEventInput;
declare function recordTalkDiagnosticEvent(event: TalkEvent): void;
//#endregion
//#region src/talk/logging.d.ts
type TalkLogLevel = "info" | "warn";
type TalkLogRecord = {
  level: TalkLogLevel;
  message: string;
  attributes: Record<string, string | number | boolean>;
};
declare function createTalkLogRecord(event: TalkEvent): TalkLogRecord | undefined;
declare function recordTalkLogEvent(event: TalkEvent): void;
//#endregion
//#region src/talk/observability.d.ts
declare function recordTalkObservabilityEvent(event: TalkEvent): void;
//#endregion
//#region src/talk/talk-session-controller.d.ts
type TalkTurnFailureReason = "no_active_turn" | "stale_turn";
type TalkTurnSuccess = {
  event: TalkEvent;
  ok: true;
  turnId: string;
};
type TalkTurnFailure = {
  ok: false;
  reason: TalkTurnFailureReason;
};
type TalkTurnResult = TalkTurnSuccess | TalkTurnFailure;
type TalkEnsureTurnResult = {
  event?: TalkEvent;
  turnId: string;
};
type TalkSessionController = {
  readonly activeTurnId: string | undefined;
  readonly context: TalkEventContext;
  readonly outputAudioActive: boolean;
  readonly recentEvents: readonly TalkEvent[];
  clearActiveTurn(): void;
  emit<TPayload>(input: TalkEventInput<TPayload>): TalkEvent<TPayload>;
  ensureTurn(params?: {
    payload?: unknown;
    turnId?: string;
  }): TalkEnsureTurnResult;
  startTurn(params?: {
    payload?: unknown;
    turnId?: string;
  }): TalkEnsureTurnResult;
  endTurn(params?: {
    payload?: unknown;
    turnId?: string;
  }): TalkTurnResult;
  cancelTurn(params?: {
    payload?: unknown;
    turnId?: string;
  }): TalkTurnResult;
  finishOutputAudio(params?: {
    payload?: unknown;
    turnId?: string;
  }): TalkEvent | undefined;
  startOutputAudio(params?: {
    payload?: unknown;
    turnId?: string;
  }): TalkEnsureTurnResult;
};
type TalkSessionControllerParams = TalkEventContext & {
  maxRecentEvents?: number;
  turnIdPrefix?: string;
};
type TalkSessionControllerOptions = {
  now?: () => Date | string;
  onEvent?: (event: TalkEvent) => void;
  sequencer?: TalkEventSequencer;
};
declare function createTalkSessionController(params: TalkSessionControllerParams, options?: TalkSessionControllerOptions): TalkSessionController;
declare function normalizeTalkTransport(value: string | undefined): string | undefined;
//#endregion
//#region src/talk/agent-consult-tool.d.ts
declare const REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME = "openclaw_agent_consult";
declare const REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES: readonly ["safe-read-only", "owner", "none"];
type RealtimeVoiceAgentConsultToolPolicy = (typeof REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES)[number];
type RealtimeVoiceAgentConsultArgs = {
  question: string;
  context?: string;
  responseStyle?: string;
};
type RealtimeVoiceAgentConsultTranscriptEntry = {
  role: "user" | "assistant";
  text: string;
};
declare const REALTIME_VOICE_AGENT_CONSULT_TOOL: RealtimeVoiceTool;
declare function buildRealtimeVoiceAgentConsultWorkingResponse(audienceLabel?: string): Record<string, unknown>;
declare function isRealtimeVoiceAgentConsultToolPolicy(value: unknown): value is RealtimeVoiceAgentConsultToolPolicy;
declare function resolveRealtimeVoiceAgentConsultToolPolicy(value: unknown, fallback: RealtimeVoiceAgentConsultToolPolicy): RealtimeVoiceAgentConsultToolPolicy;
declare function resolveRealtimeVoiceAgentConsultTools(policy: RealtimeVoiceAgentConsultToolPolicy, customTools?: RealtimeVoiceTool[]): RealtimeVoiceTool[];
declare function resolveRealtimeVoiceAgentConsultToolsAllow(policy: RealtimeVoiceAgentConsultToolPolicy): string[] | undefined;
declare function buildRealtimeVoiceAgentConsultPolicyInstructions(config: {
  toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
  consultPolicy?: "auto" | "substantive" | "always";
}): string | undefined;
declare function parseRealtimeVoiceAgentConsultArgs(args: unknown): RealtimeVoiceAgentConsultArgs;
declare function buildRealtimeVoiceAgentConsultChatMessage(args: unknown): string;
declare function buildRealtimeVoiceAgentConsultPrompt(params: {
  args: unknown;
  transcript: RealtimeVoiceAgentConsultTranscriptEntry[];
  surface: string;
  userLabel: string;
  assistantLabel?: string;
  questionSourceLabel?: string;
}): string;
declare function collectRealtimeVoiceAgentConsultVisibleText(payloads: Array<{
  text?: unknown;
  isError?: boolean;
  isReasoning?: boolean;
}>): string | null;
//#endregion
//#region src/talk/agent-consult-runtime.d.ts
type RealtimeVoiceAgentConsultRuntime = PluginRuntimeCore["agent"];
type RealtimeVoiceAgentConsultResult = {
  text: string;
};
type RealtimeVoiceAgentConsultContextMode = "isolated" | "fork";
declare function consultRealtimeVoiceAgent(params: {
  cfg: OpenClawConfig;
  agentRuntime: RealtimeVoiceAgentConsultRuntime;
  logger: Pick<RuntimeLogger, "warn">;
  sessionKey: string;
  messageProvider: string;
  lane: string;
  runIdPrefix: string;
  args: unknown;
  transcript: RealtimeVoiceAgentConsultTranscriptEntry[];
  surface: string;
  userLabel: string;
  assistantLabel?: string;
  questionSourceLabel?: string;
  agentId?: string;
  spawnedBy?: string | null;
  contextMode?: RealtimeVoiceAgentConsultContextMode;
  provider?: RunEmbeddedPiAgentParams["provider"];
  model?: RunEmbeddedPiAgentParams["model"];
  thinkLevel?: RunEmbeddedPiAgentParams["thinkLevel"];
  fastMode?: RunEmbeddedPiAgentParams["fastMode"];
  timeoutMs?: number;
  toolsAllow?: string[];
  extraSystemPrompt?: string;
  fallbackText?: string;
}): Promise<RealtimeVoiceAgentConsultResult>;
//#endregion
//#region src/talk/agent-talkback-runtime.d.ts
type RealtimeVoiceAgentTalkbackResult = {
  text: string;
};
type RealtimeVoiceAgentTalkbackQueue = {
  close(): void;
  enqueue(question: string, metadata?: unknown): void;
};
type RealtimeVoiceAgentTalkbackQueueParams = {
  debounceMs: number;
  isStopped: () => boolean;
  logger: Pick<RuntimeLogger, "info" | "warn">;
  logPrefix: string;
  responseStyle: string;
  fallbackText: string;
  consult: (args: {
    question: string;
    metadata?: unknown;
    responseStyle: string;
    signal: AbortSignal;
  }) => Promise<RealtimeVoiceAgentTalkbackResult>;
  deliver: (text: string) => void;
};
declare function createRealtimeVoiceAgentTalkbackQueue(params: RealtimeVoiceAgentTalkbackQueueParams): RealtimeVoiceAgentTalkbackQueue;
//#endregion
//#region src/talk/fast-context-runtime.d.ts
type Logger = {
  debug?: (message: string) => void;
};
type RealtimeVoiceFastContextConfig = {
  enabled: boolean;
  maxResults: number;
  sources: Array<"memory" | "sessions">;
  timeoutMs: number;
  fallbackToConsult: boolean;
};
type RealtimeVoiceFastContextLabels = {
  audienceLabel: string;
  contextName: string;
};
type RealtimeVoiceFastContextConsultResult = {
  handled: false;
} | {
  handled: true;
  result: RealtimeVoiceAgentConsultResult;
};
declare function resolveRealtimeVoiceFastContextConsult(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  config: RealtimeVoiceFastContextConfig;
  args: unknown;
  logger: Logger;
  labels?: Partial<RealtimeVoiceFastContextLabels>;
}): Promise<RealtimeVoiceFastContextConsultResult>;
//#endregion
//#region src/talk/provider-registry.d.ts
declare function normalizeRealtimeVoiceProviderId(providerId: string | undefined): RealtimeVoiceProviderId | undefined;
declare function listRealtimeVoiceProviders(cfg?: OpenClawConfig): RealtimeVoiceProviderPlugin[];
declare function getRealtimeVoiceProvider(providerId: string | undefined, cfg?: OpenClawConfig): RealtimeVoiceProviderPlugin | undefined;
declare function canonicalizeRealtimeVoiceProviderId(providerId: string | undefined, cfg?: OpenClawConfig): RealtimeVoiceProviderId | undefined;
//#endregion
//#region src/talk/provider-resolver.d.ts
type ResolvedRealtimeVoiceProvider = {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
};
type ResolveConfiguredRealtimeVoiceProviderParams = {
  configuredProviderId?: string;
  providerConfigs?: Record<string, Record<string, unknown> | undefined>;
  providerConfigOverrides?: Record<string, unknown>;
  cfg?: OpenClawConfig;
  cfgForResolve?: OpenClawConfig;
  providers?: RealtimeVoiceProviderPlugin[];
  defaultModel?: string;
  noRegisteredProviderMessage?: string;
};
declare function resolveConfiguredRealtimeVoiceProvider(params: ResolveConfiguredRealtimeVoiceProviderParams): ResolvedRealtimeVoiceProvider;
//#endregion
//#region src/talk/session-runtime.d.ts
type RealtimeVoiceAudioSink = {
  isOpen?: () => boolean;
  sendAudio: (audio: Buffer) => void;
  clearAudio?: () => void;
  sendMark?: (markName: string) => void;
};
type RealtimeVoiceMarkStrategy = "transport" | "ack-immediately" | "ignore";
type RealtimeVoiceBridgeSession = {
  bridge: RealtimeVoiceBridge;
  acknowledgeMark(): void;
  close(): void;
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  sendUserMessage(text: string): void;
  handleBargeIn(options?: RealtimeVoiceBargeInOptions): void;
  setMediaTimestamp(ts: number): void;
  submitToolResult(callId: string, result: unknown, options?: RealtimeVoiceToolResultOptions): void;
  triggerGreeting(instructions?: string): void;
};
type RealtimeVoiceBridgeSessionParams = {
  provider: RealtimeVoiceProviderPlugin;
  cfg?: OpenClawConfig;
  providerConfig: RealtimeVoiceProviderConfig;
  audioFormat?: RealtimeVoiceAudioFormat;
  audioSink: RealtimeVoiceAudioSink;
  instructions?: string;
  initialGreetingInstructions?: string;
  autoRespondToAudio?: boolean;
  interruptResponseOnInputAudio?: boolean;
  markStrategy?: RealtimeVoiceMarkStrategy;
  triggerGreetingOnReady?: boolean;
  tools?: RealtimeVoiceTool[];
  onTranscript?: (role: RealtimeVoiceRole, text: string, isFinal: boolean) => void;
  onEvent?: (event: RealtimeVoiceBridgeEvent) => void;
  onToolCall?: (event: RealtimeVoiceToolCallEvent, session: RealtimeVoiceBridgeSession) => void;
  onReady?: (session: RealtimeVoiceBridgeSession) => void;
  onError?: (error: Error) => void;
  onClose?: (reason: RealtimeVoiceCloseReason) => void;
};
declare function createRealtimeVoiceBridgeSession(params: RealtimeVoiceBridgeSessionParams): RealtimeVoiceBridgeSession;
//#endregion
//#region src/talk/session-log-runtime.d.ts
type RealtimeVoiceTranscriptEntry = {
  at: string;
  role: RealtimeVoiceRole;
  text: string;
};
type RealtimeVoiceTranscriptHealth = {
  realtimeTranscriptLines: number;
  lastRealtimeTranscriptAt?: string;
  lastRealtimeTranscriptRole?: RealtimeVoiceRole;
  lastRealtimeTranscriptText?: string;
  recentRealtimeTranscript: RealtimeVoiceTranscriptEntry[];
};
type RealtimeVoiceBridgeEventLogEntry = RealtimeVoiceBridgeEvent & {
  at: string;
};
type RealtimeVoiceBridgeEventHealth = {
  lastRealtimeEventAt?: string;
  lastRealtimeEventType?: string;
  lastRealtimeEventDetail?: string;
  recentRealtimeEvents: RealtimeVoiceBridgeEventLogEntry[];
};
declare function recordRealtimeVoiceTranscript(transcript: RealtimeVoiceTranscriptEntry[], role: RealtimeVoiceRole, text: string, maxEntries?: number): RealtimeVoiceTranscriptEntry;
declare function getRealtimeVoiceTranscriptHealth(transcript: RealtimeVoiceTranscriptEntry[]): RealtimeVoiceTranscriptHealth;
declare function recordRealtimeVoiceBridgeEvent(events: RealtimeVoiceBridgeEventLogEntry[], event: RealtimeVoiceBridgeEvent, maxEntries?: number): void;
declare function getRealtimeVoiceBridgeEventHealth(events: RealtimeVoiceBridgeEventLogEntry[]): RealtimeVoiceBridgeEventHealth;
declare function isLikelyRealtimeVoiceAssistantEchoTranscript(params: {
  transcript: RealtimeVoiceTranscriptEntry[];
  text: string;
  lookbackMs: number;
  nowMs?: number;
}): boolean;
declare function extendRealtimeVoiceOutputEchoSuppression(params: {
  audio: Buffer;
  bytesPerMs: number;
  tailMs: number;
  nowMs: number;
  lastOutputPlayableUntilMs: number;
  suppressInputUntilMs: number;
}): {
  lastOutputPlayableUntilMs: number;
  suppressInputUntilMs: number;
  durationMs: number;
};
//#endregion
//#region src/talk/audio-codec.d.ts
declare function resamplePcm(input: Buffer, inputSampleRate: number, outputSampleRate: number): Buffer;
declare function resamplePcmTo8k(input: Buffer, inputSampleRate: number): Buffer;
declare function pcmToMulaw(pcm: Buffer): Buffer;
declare function mulawToPcm(mulaw: Buffer): Buffer;
declare function convertPcmToMulaw8k(pcm: Buffer, inputSampleRate: number): Buffer;
//#endregion
export { resolveRealtimeVoiceAgentConsultTools as $, RealtimeVoiceFastContextLabels as A, REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME as B, resolveConfiguredRealtimeVoiceProvider as C, normalizeRealtimeVoiceProviderId as D, listRealtimeVoiceProviders as E, createRealtimeVoiceAgentTalkbackQueue as F, buildRealtimeVoiceAgentConsultChatMessage as G, RealtimeVoiceAgentConsultArgs as H, RealtimeVoiceAgentConsultResult as I, buildRealtimeVoiceAgentConsultWorkingResponse as J, buildRealtimeVoiceAgentConsultPolicyInstructions as K, RealtimeVoiceAgentConsultRuntime as L, RealtimeVoiceAgentTalkbackQueue as M, RealtimeVoiceAgentTalkbackQueueParams as N, RealtimeVoiceFastContextConfig as O, RealtimeVoiceAgentTalkbackResult as P, resolveRealtimeVoiceAgentConsultToolPolicy as Q, consultRealtimeVoiceAgent as R, ResolvedRealtimeVoiceProvider as S, getRealtimeVoiceProvider as T, RealtimeVoiceAgentConsultToolPolicy as U, REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES as V, RealtimeVoiceAgentConsultTranscriptEntry as W, isRealtimeVoiceAgentConsultToolPolicy as X, collectRealtimeVoiceAgentConsultVisibleText as Y, parseRealtimeVoiceAgentConsultArgs as Z, RealtimeVoiceBridgeSession as _, resamplePcmTo8k as a, TalkTurnFailure as at, createRealtimeVoiceBridgeSession as b, RealtimeVoiceTranscriptEntry as c, TalkTurnSuccess as ct, getRealtimeVoiceBridgeEventHealth as d, recordTalkObservabilityEvent as dt, resolveRealtimeVoiceAgentConsultToolsAllow as et, getRealtimeVoiceTranscriptHealth as f, createTalkLogRecord as ft, RealtimeVoiceAudioSink as g, recordRealtimeVoiceTranscript as h, recordTalkDiagnosticEvent as ht, resamplePcm as i, TalkSessionControllerParams as it, resolveRealtimeVoiceFastContextConsult as j, RealtimeVoiceFastContextConsultResult as k, RealtimeVoiceTranscriptHealth as l, createTalkSessionController as lt, recordRealtimeVoiceBridgeEvent as m, createTalkDiagnosticEvent as mt, mulawToPcm as n, TalkSessionController as nt, RealtimeVoiceBridgeEventHealth as o, TalkTurnFailureReason as ot, isLikelyRealtimeVoiceAssistantEchoTranscript as p, recordTalkLogEvent as pt, buildRealtimeVoiceAgentConsultPrompt as q, pcmToMulaw as r, TalkSessionControllerOptions as rt, RealtimeVoiceBridgeEventLogEntry as s, TalkTurnResult as st, convertPcmToMulaw8k as t, TalkEnsureTurnResult as tt, extendRealtimeVoiceOutputEchoSuppression as u, normalizeTalkTransport as ut, RealtimeVoiceBridgeSessionParams as v, canonicalizeRealtimeVoiceProviderId as w, ResolveConfiguredRealtimeVoiceProviderParams as x, RealtimeVoiceMarkStrategy as y, REALTIME_VOICE_AGENT_CONSULT_TOOL as z };