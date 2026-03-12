import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { TtsAutoMode, TtsMode, TtsProvider, TtsModelOverrideConfig } from "../config/types.tts.js";
import { isValidOpenAIModel, isValidOpenAIVoice, isValidVoiceId, parseTtsDirectives, summarizeText } from "./tts-core.js";
export { OPENAI_TTS_MODELS, OPENAI_TTS_VOICES } from "./tts-core.js";
export type ResolvedTtsConfig = {
    auto: TtsAutoMode;
    mode: TtsMode;
    provider: TtsProvider;
    providerSource: "config" | "default";
    summaryModel?: string;
    modelOverrides: ResolvedTtsModelOverrides;
    elevenlabs: {
        apiKey?: string;
        baseUrl: string;
        voiceId: string;
        modelId: string;
        seed?: number;
        applyTextNormalization?: "auto" | "on" | "off";
        languageCode?: string;
        voiceSettings: {
            stability: number;
            similarityBoost: number;
            style: number;
            useSpeakerBoost: boolean;
            speed: number;
        };
    };
    openai: {
        apiKey?: string;
        model: string;
        voice: string;
    };
    edge: {
        enabled: boolean;
        voice: string;
        lang: string;
        outputFormat: string;
        outputFormatConfigured: boolean;
        pitch?: string;
        rate?: string;
        volume?: string;
        saveSubtitles: boolean;
        proxy?: string;
        timeoutMs?: number;
    };
    prefsPath?: string;
    maxTextLength: number;
    timeoutMs: number;
};
export type ResolvedTtsModelOverrides = {
    enabled: boolean;
    allowText: boolean;
    allowProvider: boolean;
    allowVoice: boolean;
    allowModelId: boolean;
    allowVoiceSettings: boolean;
    allowNormalization: boolean;
    allowSeed: boolean;
};
export type TtsDirectiveOverrides = {
    ttsText?: string;
    provider?: TtsProvider;
    openai?: {
        voice?: string;
        model?: string;
    };
    elevenlabs?: {
        voiceId?: string;
        modelId?: string;
        seed?: number;
        applyTextNormalization?: "auto" | "on" | "off";
        languageCode?: string;
        voiceSettings?: Partial<ResolvedTtsConfig["elevenlabs"]["voiceSettings"]>;
    };
};
export type TtsDirectiveParseResult = {
    cleanedText: string;
    ttsText?: string;
    hasDirective: boolean;
    overrides: TtsDirectiveOverrides;
    warnings: string[];
};
export type TtsResult = {
    success: boolean;
    audioPath?: string;
    error?: string;
    latencyMs?: number;
    provider?: string;
    outputFormat?: string;
    voiceCompatible?: boolean;
};
export type TtsTelephonyResult = {
    success: boolean;
    audioBuffer?: Buffer;
    error?: string;
    latencyMs?: number;
    provider?: string;
    outputFormat?: string;
    sampleRate?: number;
};
type TtsStatusEntry = {
    timestamp: number;
    success: boolean;
    textLength: number;
    summarized: boolean;
    provider?: string;
    latencyMs?: number;
    error?: string;
};
export declare function normalizeTtsAutoMode(value: unknown): TtsAutoMode | undefined;
declare function resolveModelOverridePolicy(overrides: TtsModelOverrideConfig | undefined): ResolvedTtsModelOverrides;
export declare function resolveTtsConfig(cfg: OpenClawConfig): ResolvedTtsConfig;
export declare function resolveTtsPrefsPath(config: ResolvedTtsConfig): string;
export declare function resolveTtsAutoMode(params: {
    config: ResolvedTtsConfig;
    prefsPath: string;
    sessionAuto?: string;
}): TtsAutoMode;
export declare function buildTtsSystemPromptHint(cfg: OpenClawConfig): string | undefined;
export declare function isTtsEnabled(config: ResolvedTtsConfig, prefsPath: string, sessionAuto?: string): boolean;
export declare function setTtsAutoMode(prefsPath: string, mode: TtsAutoMode): void;
export declare function setTtsEnabled(prefsPath: string, enabled: boolean): void;
export declare function getTtsProvider(config: ResolvedTtsConfig, prefsPath: string): TtsProvider;
export declare function setTtsProvider(prefsPath: string, provider: TtsProvider): void;
export declare function getTtsMaxLength(prefsPath: string): number;
export declare function setTtsMaxLength(prefsPath: string, maxLength: number): void;
export declare function isSummarizationEnabled(prefsPath: string): boolean;
export declare function setSummarizationEnabled(prefsPath: string, enabled: boolean): void;
export declare function getLastTtsAttempt(): TtsStatusEntry | undefined;
export declare function setLastTtsAttempt(entry: TtsStatusEntry | undefined): void;
declare function resolveOutputFormat(channelId?: string | null): {
    openai: "opus";
    elevenlabs: string;
    extension: string;
    voiceCompatible: boolean;
} | {
    openai: "mp3";
    elevenlabs: string;
    extension: string;
    voiceCompatible: boolean;
};
declare function resolveEdgeOutputFormat(config: ResolvedTtsConfig): string;
export declare function resolveTtsApiKey(config: ResolvedTtsConfig, provider: TtsProvider): string | undefined;
export declare const TTS_PROVIDERS: readonly ["openai", "elevenlabs", "edge"];
export declare function resolveTtsProviderOrder(primary: TtsProvider): TtsProvider[];
export declare function isTtsProviderConfigured(config: ResolvedTtsConfig, provider: TtsProvider): boolean;
export declare function textToSpeech(params: {
    text: string;
    cfg: OpenClawConfig;
    prefsPath?: string;
    channel?: string;
    overrides?: TtsDirectiveOverrides;
}): Promise<TtsResult>;
export declare function textToSpeechTelephony(params: {
    text: string;
    cfg: OpenClawConfig;
    prefsPath?: string;
}): Promise<TtsTelephonyResult>;
export declare function maybeApplyTtsToPayload(params: {
    payload: ReplyPayload;
    cfg: OpenClawConfig;
    channel?: string;
    kind?: "tool" | "block" | "final";
    inboundAudio?: boolean;
    ttsAuto?: string;
}): Promise<ReplyPayload>;
export declare const _test: {
    isValidVoiceId: typeof isValidVoiceId;
    isValidOpenAIVoice: typeof isValidOpenAIVoice;
    isValidOpenAIModel: typeof isValidOpenAIModel;
    OPENAI_TTS_MODELS: readonly ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"];
    OPENAI_TTS_VOICES: readonly ["alloy", "ash", "ballad", "cedar", "coral", "echo", "fable", "juniper", "marin", "onyx", "nova", "sage", "shimmer", "verse"];
    parseTtsDirectives: typeof parseTtsDirectives;
    resolveModelOverridePolicy: typeof resolveModelOverridePolicy;
    summarizeText: typeof summarizeText;
    resolveOutputFormat: typeof resolveOutputFormat;
    resolveEdgeOutputFormat: typeof resolveEdgeOutputFormat;
};
