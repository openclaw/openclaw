import type { OpenClawConfig } from "../config/config.js";
import type { ResolvedTtsConfig, ResolvedTtsModelOverrides, TtsDirectiveParseResult } from "./tts.js";
export declare function isValidVoiceId(voiceId: string): boolean;
export declare function parseTtsDirectives(text: string, policy: ResolvedTtsModelOverrides): TtsDirectiveParseResult;
export declare const OPENAI_TTS_MODELS: readonly ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"];
export declare const OPENAI_TTS_VOICES: readonly ["alloy", "ash", "ballad", "cedar", "coral", "echo", "fable", "juniper", "marin", "onyx", "nova", "sage", "shimmer", "verse"];
type OpenAiTtsVoice = (typeof OPENAI_TTS_VOICES)[number];
export declare function isValidOpenAIModel(model: string): boolean;
export declare function isValidOpenAIVoice(voice: string): voice is OpenAiTtsVoice;
type SummarizeResult = {
    summary: string;
    latencyMs: number;
    inputLength: number;
    outputLength: number;
};
export declare function summarizeText(params: {
    text: string;
    targetLength: number;
    cfg: OpenClawConfig;
    config: ResolvedTtsConfig;
    timeoutMs: number;
}): Promise<SummarizeResult>;
export declare function scheduleCleanup(tempDir: string, delayMs?: number): void;
export declare function elevenLabsTTS(params: {
    text: string;
    apiKey: string;
    baseUrl: string;
    voiceId: string;
    modelId: string;
    outputFormat: string;
    seed?: number;
    applyTextNormalization?: "auto" | "on" | "off";
    languageCode?: string;
    voiceSettings: ResolvedTtsConfig["elevenlabs"]["voiceSettings"];
    timeoutMs: number;
}): Promise<Buffer>;
export declare function openaiTTS(params: {
    text: string;
    apiKey: string;
    model: string;
    voice: string;
    responseFormat: "mp3" | "opus" | "pcm";
    timeoutMs: number;
}): Promise<Buffer>;
export declare function inferEdgeExtension(outputFormat: string): string;
export declare function edgeTTS(params: {
    text: string;
    outputPath: string;
    config: ResolvedTtsConfig["edge"];
    timeoutMs: number;
}): Promise<void>;
export {};
