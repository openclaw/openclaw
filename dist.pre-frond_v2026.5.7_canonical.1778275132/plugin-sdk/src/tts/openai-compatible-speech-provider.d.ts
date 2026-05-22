import type { SpeechProviderPlugin } from "../plugins/types.js";
type OpenAiCompatibleSpeechProviderBaseConfig = {
    apiKey?: string;
    baseUrl?: string;
    model: string;
    voice: string;
    speed?: number;
    responseFormat?: string;
};
export type OpenAiCompatibleSpeechProviderConfig<ExtraConfig extends Record<string, unknown> = Record<string, never>> = OpenAiCompatibleSpeechProviderBaseConfig & ExtraConfig;
export type OpenAiCompatibleSpeechProviderBaseUrlPolicy = {
    kind: "trim-trailing-slash";
} | {
    kind: "canonical";
    aliases?: readonly string[];
    allowCustom?: boolean;
};
export type OpenAiCompatibleSpeechProviderExtraJsonBodyField<ExtraConfig extends Record<string, unknown>> = {
    configKey: Extract<keyof ExtraConfig, string>;
    requestKey?: string;
};
export type OpenAiCompatibleSpeechProviderOptions<ExtraConfig extends Record<string, unknown> = Record<string, never>> = {
    id: string;
    label: string;
    autoSelectOrder: number;
    models: readonly string[];
    voices: readonly string[];
    defaultModel: string;
    defaultVoice: string;
    defaultBaseUrl: string;
    envKey: string;
    responseFormats: readonly string[];
    defaultResponseFormat: string;
    voiceCompatibleResponseFormats: readonly string[];
    baseUrlPolicy?: OpenAiCompatibleSpeechProviderBaseUrlPolicy;
    normalizeModel?: (value: string | undefined, fallback: string) => string;
    configKey?: string;
    extraHeaders?: Record<string, string>;
    readExtraConfig?: (raw: Record<string, unknown> | undefined) => ExtraConfig;
    extraJsonBodyFields?: readonly OpenAiCompatibleSpeechProviderExtraJsonBodyField<ExtraConfig>[];
    apiErrorLabel?: string;
    missingApiKeyError?: string;
};
export declare function createOpenAiCompatibleSpeechProvider<ExtraConfig extends Record<string, unknown> = Record<string, never>>(options: OpenAiCompatibleSpeechProviderOptions<ExtraConfig>): SpeechProviderPlugin;
export {};
