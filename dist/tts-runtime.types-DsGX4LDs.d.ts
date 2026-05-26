import { i as OpenClawConfig, pt as TalkProviderConfig } from "./types.openclaw-BLF4DJTX.js";
import { _n as TtsAutoMode, gn as ResolvedTtsPersona, vn as TtsConfig, wn as TtsProvider, yn as TtsMode } from "./types.channels-C67UBRPK.js";
import { r as ReplyPayload } from "./reply-payload-BlNiejVc.js";

//#region src/tts/provider-types.d.ts
type SpeechProviderId = string;
type SpeechSynthesisTarget = "audio-file" | "voice-note" | "telephony";
type SpeechProviderConfig = Record<string, unknown>;
type SpeechProviderOverrides = Record<string, unknown>;
type SpeechModelOverridePolicy = {
  enabled: boolean;
  allowText: boolean;
  allowProvider: boolean;
  allowVoice: boolean;
  allowModelId: boolean;
  allowVoiceSettings: boolean;
  allowNormalization: boolean;
  allowSeed: boolean;
};
type TtsDirectiveOverrides = {
  ttsText?: string;
  provider?: SpeechProviderId;
  providerOverrides?: Record<string, SpeechProviderOverrides>;
};
type TtsDirectiveParseResult = {
  cleanedText: string;
  ttsText?: string;
  hasDirective: boolean;
  overrides: TtsDirectiveOverrides;
  warnings: string[];
};
type SpeechProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  providerConfig: SpeechProviderConfig;
  timeoutMs: number;
};
type SpeechSynthesisRequest = {
  text: string;
  cfg: OpenClawConfig;
  providerConfig: SpeechProviderConfig;
  target: SpeechSynthesisTarget;
  providerOverrides?: SpeechProviderOverrides;
  timeoutMs: number;
};
type SpeechSynthesisResult = {
  audioBuffer: Buffer;
  outputFormat: string;
  fileExtension: string;
  voiceCompatible: boolean;
};
type SpeechSynthesisStreamRequest = SpeechSynthesisRequest;
type SpeechSynthesisStreamResult = {
  audioStream: ReadableStream<Uint8Array>;
  outputFormat: string;
  fileExtension: string;
  voiceCompatible: boolean;
  release?: () => Promise<void>;
};
type SpeechTelephonySynthesisRequest = {
  text: string;
  cfg: OpenClawConfig;
  providerConfig: SpeechProviderConfig;
  providerOverrides?: SpeechProviderOverrides;
  timeoutMs: number;
};
type SpeechTelephonySynthesisResult = {
  audioBuffer: Buffer;
  outputFormat: string;
  sampleRate: number;
};
type SpeechProviderPrepareSynthesisContext = {
  text: string;
  cfg: OpenClawConfig;
  providerConfig: SpeechProviderConfig;
  providerOverrides?: SpeechProviderOverrides;
  persona?: ResolvedTtsPersona;
  personaProviderConfig?: SpeechProviderConfig;
  target: SpeechSynthesisTarget;
  timeoutMs: number;
};
type SpeechProviderPreparedSynthesis = {
  text?: string;
  providerConfig?: SpeechProviderConfig;
  providerOverrides?: SpeechProviderOverrides;
};
type SpeechVoiceOption = {
  id: string;
  name?: string;
  category?: string;
  description?: string;
  locale?: string;
  gender?: string;
  personalities?: string[];
};
type SpeechListVoicesRequest = {
  cfg?: OpenClawConfig;
  providerConfig?: SpeechProviderConfig;
  apiKey?: string;
  baseUrl?: string;
};
type SpeechProviderResolveConfigContext = {
  cfg: OpenClawConfig;
  rawConfig: Record<string, unknown>;
  timeoutMs: number;
};
type SpeechDirectiveTokenParseContext = {
  key: string;
  value: string;
  policy: SpeechModelOverridePolicy;
  selectedProvider?: SpeechProviderId;
  providerConfig?: SpeechProviderConfig;
  currentOverrides?: SpeechProviderOverrides;
};
type SpeechDirectiveTokenParseResult = {
  handled: boolean;
  overrides?: SpeechProviderOverrides;
  warnings?: string[];
};
type SpeechProviderResolveTalkConfigContext = {
  cfg: OpenClawConfig;
  baseTtsConfig: Record<string, unknown>;
  talkProviderConfig: TalkProviderConfig;
  timeoutMs: number;
};
type SpeechProviderResolveTalkOverridesContext = {
  talkProviderConfig: TalkProviderConfig;
  params: Record<string, unknown>;
};
//#endregion
//#region src/tts/tts-auto-mode.d.ts
declare const TTS_AUTO_MODES: Set<TtsAutoMode>;
declare function normalizeTtsAutoMode(value: unknown): TtsAutoMode | undefined;
//#endregion
//#region src/tts/tts-config.d.ts
type TtsConfigResolutionContext = {
  agentId?: string;
  channelId?: string;
  accountId?: string;
};
declare function resolveEffectiveTtsConfig(cfg: OpenClawConfig, contextOrAgentId?: string | TtsConfigResolutionContext): TtsConfig;
//#endregion
//#region src/tts/tts-types.d.ts
type ResolvedTtsModelOverrides = SpeechModelOverridePolicy;
type ResolvedTtsConfig = {
  auto: TtsAutoMode;
  mode: TtsMode;
  provider: TtsProvider;
  providerSource: "config" | "default";
  persona?: string;
  personas: Record<string, ResolvedTtsPersona>;
  summaryModel?: string;
  modelOverrides: ResolvedTtsModelOverrides;
  providerConfigs: Record<string, SpeechProviderConfig>;
  prefsPath?: string;
  maxTextLength: number;
  timeoutMs: number;
  timeoutMsSource?: "config" | "default";
  rawConfig?: TtsConfig;
  sourceConfig?: OpenClawConfig;
};
//#endregion
//#region src/plugin-sdk/tts-runtime.types.d.ts
type TtsAttemptReasonCode = "success" | "no_provider_registered" | "not_configured" | "unsupported_for_streaming" | "unsupported_for_telephony" | "timeout" | "provider_error";
type TtsProviderAttempt = {
  provider: string;
  outcome: "success" | "skipped" | "failed";
  reasonCode: TtsAttemptReasonCode;
  persona?: string;
  personaBinding?: "applied" | "missing" | "none";
  latencyMs?: number;
  error?: string;
};
type TtsStatusEntry = {
  timestamp: number;
  success: boolean;
  textLength: number;
  summarized: boolean;
  provider?: string;
  persona?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  latencyMs?: number;
  error?: string;
};
type TtsSpeechTarget = "audio-file" | "voice-note";
type SummarizeResult = {
  summary: string;
  latencyMs: number;
  inputLength: number;
  outputLength: number;
};
type ResolveTtsAutoModeParams = {
  config: ResolvedTtsConfig;
  prefsPath: string;
  sessionAuto?: string;
};
type ResolveExplicitTtsOverridesParams = {
  cfg: OpenClawConfig;
  prefsPath?: string;
  provider?: string;
  modelId?: string;
  voiceId?: string;
  agentId?: string;
  channelId?: string;
  accountId?: string;
};
type TtsRequestParams = {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
  timeoutMs?: number;
  agentId?: string;
  accountId?: string;
};
type TtsTelephonyRequestParams = {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  overrides?: TtsDirectiveOverrides;
};
type ListSpeechVoicesParams = {
  provider: string;
  cfg?: OpenClawConfig;
  config?: ResolvedTtsConfig;
  apiKey?: string;
  baseUrl?: string;
};
type MaybeApplyTtsToPayloadParams = {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  channel?: string;
  kind?: "tool" | "block" | "final";
  inboundAudio?: boolean;
  ttsAuto?: string;
  agentId?: string;
  accountId?: string;
};
type TtsTestFacade = {
  parseTtsDirectives: (...args: unknown[]) => TtsDirectiveParseResult;
  resolveModelOverridePolicy: (...args: unknown[]) => ResolvedTtsModelOverrides;
  supportsNativeVoiceNoteTts: (channel: string | undefined) => boolean;
  supportsTranscodedVoiceNoteTts: (channel: string | undefined) => boolean;
  shouldDeliverTtsAsVoice: (params: {
    channel: string | undefined;
    target: TtsSpeechTarget | undefined;
    voiceCompatible: boolean | undefined;
    fileExtension?: string;
    outputFormat?: string;
  }) => boolean;
  summarizeText: (...args: unknown[]) => Promise<SummarizeResult>;
  getResolvedSpeechProviderConfig: (config: ResolvedTtsConfig, providerId: string, cfg?: OpenClawConfig) => SpeechProviderConfig;
  formatTtsProviderError: (provider: TtsProvider, err: unknown) => string;
  sanitizeTtsErrorForLog: (err: unknown) => string;
};
type TtsResult = {
  success: boolean;
  audioPath?: string;
  error?: string;
  latencyMs?: number;
  provider?: string;
  persona?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  outputFormat?: string;
  voiceCompatible?: boolean;
  audioAsVoice?: boolean;
  target?: TtsSpeechTarget;
};
type TtsSynthesisResult = {
  success: boolean;
  audioBuffer?: Buffer;
  error?: string;
  latencyMs?: number;
  provider?: string;
  providerModel?: string;
  providerVoice?: string;
  persona?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  outputFormat?: string;
  voiceCompatible?: boolean;
  fileExtension?: string;
  target?: TtsSpeechTarget;
};
type TtsStreamResult = {
  success: boolean;
  audioStream?: ReadableStream<Uint8Array>;
  error?: string;
  latencyMs?: number;
  provider?: string;
  persona?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  outputFormat?: string;
  voiceCompatible?: boolean;
  fileExtension?: string;
  target?: TtsSpeechTarget;
  release?: () => Promise<void>;
};
type TtsSynthesisStreamResult = TtsStreamResult;
type TtsTelephonyResult = {
  success: boolean;
  audioBuffer?: Buffer;
  error?: string;
  latencyMs?: number;
  provider?: string;
  providerModel?: string;
  providerVoice?: string;
  persona?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  outputFormat?: string;
  sampleRate?: number;
};
type TextToSpeech = (params: TtsRequestParams) => Promise<TtsResult>;
type TextToSpeechStream = (params: TtsRequestParams) => Promise<TtsStreamResult>;
type TextToSpeechTelephony = (params: TtsTelephonyRequestParams) => Promise<TtsTelephonyResult>;
type ListSpeechVoices = (params: ListSpeechVoicesParams) => Promise<SpeechVoiceOption[]>;
type TtsRuntimeFacade = {
  /** @deprecated Use `testApi`. */_test: TtsTestFacade;
  testApi: TtsTestFacade;
  buildTtsSystemPromptHint: (cfg: OpenClawConfig, agentId?: string) => string | undefined;
  getLastTtsAttempt: () => TtsStatusEntry | undefined;
  getResolvedSpeechProviderConfig: (config: ResolvedTtsConfig, providerId: string, cfg?: OpenClawConfig) => SpeechProviderConfig;
  getTtsMaxLength: (prefsPath: string) => number;
  getTtsPersona: (config: ResolvedTtsConfig, prefsPath: string) => ResolvedTtsPersona | undefined;
  getTtsProvider: (config: ResolvedTtsConfig, prefsPath: string) => TtsProvider;
  isSummarizationEnabled: (prefsPath: string) => boolean;
  isTtsEnabled: (config: ResolvedTtsConfig, prefsPath: string, sessionAuto?: string) => boolean;
  isTtsProviderConfigured: (config: ResolvedTtsConfig, provider: TtsProvider, cfg?: OpenClawConfig) => boolean;
  listSpeechVoices: ListSpeechVoices;
  listTtsPersonas: (config: ResolvedTtsConfig) => ResolvedTtsPersona[];
  maybeApplyTtsToPayload: (params: MaybeApplyTtsToPayloadParams) => Promise<ReplyPayload>;
  resolveExplicitTtsOverrides: (params: ResolveExplicitTtsOverridesParams) => TtsDirectiveOverrides;
  resolveTtsAutoMode: (params: ResolveTtsAutoModeParams) => TtsAutoMode;
  resolveTtsConfig: (cfg: OpenClawConfig, contextOrAgentId?: string | TtsConfigResolutionContext) => ResolvedTtsConfig;
  resolveTtsPrefsPath: (config: ResolvedTtsConfig) => string;
  resolveTtsProviderOrder: (primary: TtsProvider, cfg?: OpenClawConfig) => TtsProvider[];
  setLastTtsAttempt: (entry: TtsStatusEntry | undefined) => void;
  setSummarizationEnabled: (prefsPath: string, enabled: boolean) => void;
  setTtsAutoMode: (prefsPath: string, mode: TtsAutoMode) => void;
  setTtsEnabled: (prefsPath: string, enabled: boolean) => void;
  setTtsMaxLength: (prefsPath: string, maxLength: number) => void;
  setTtsPersona: (prefsPath: string, persona: string | null | undefined) => void;
  setTtsProvider: (prefsPath: string, provider: TtsProvider) => void;
  synthesizeSpeech: (params: TtsRequestParams) => Promise<TtsSynthesisResult>;
  streamSpeech: (params: TtsRequestParams) => Promise<TtsSynthesisStreamResult>;
  textToSpeech: TextToSpeech;
  textToSpeechStream: TextToSpeechStream;
  textToSpeechTelephony: TextToSpeechTelephony;
};
//#endregion
export { SpeechSynthesisRequest as A, SpeechProviderId as C, SpeechProviderResolveConfigContext as D, SpeechProviderPreparedSynthesis as E, SpeechTelephonySynthesisRequest as F, SpeechTelephonySynthesisResult as I, SpeechVoiceOption as L, SpeechSynthesisStreamRequest as M, SpeechSynthesisStreamResult as N, SpeechProviderResolveTalkConfigContext as O, SpeechSynthesisTarget as P, TtsDirectiveOverrides as R, SpeechProviderConfiguredContext as S, SpeechProviderPrepareSynthesisContext as T, SpeechDirectiveTokenParseContext as _, TtsResult as a, SpeechModelOverridePolicy as b, TtsSynthesisResult as c, ResolvedTtsConfig as d, ResolvedTtsModelOverrides as f, normalizeTtsAutoMode as g, TTS_AUTO_MODES as h, TextToSpeechTelephony as i, SpeechSynthesisResult as j, SpeechProviderResolveTalkOverridesContext as k, TtsSynthesisStreamResult as l, resolveEffectiveTtsConfig as m, TextToSpeech as n, TtsRuntimeFacade as o, TtsConfigResolutionContext as p, TextToSpeechStream as r, TtsStreamResult as s, ListSpeechVoices as t, TtsTelephonyResult as u, SpeechDirectiveTokenParseResult as v, SpeechProviderOverrides as w, SpeechProviderConfig as x, SpeechListVoicesRequest as y, TtsDirectiveParseResult as z };