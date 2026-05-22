import type { OpenClawConfig } from "../config/types.js";
import type { TtsConfig, TtsMode } from "../config/types.tts.js";
export { normalizeTtsAutoMode } from "./tts-auto-mode.js";
export type TtsConfigResolutionContext = {
    agentId?: string;
    channelId?: string;
    accountId?: string;
};
export declare function resolveEffectiveTtsConfig(cfg: OpenClawConfig, contextOrAgentId?: string | TtsConfigResolutionContext): TtsConfig;
export declare function resolveConfiguredTtsMode(cfg: OpenClawConfig, contextOrAgentId?: string | TtsConfigResolutionContext): TtsMode;
export declare function shouldAttemptTtsPayload(params: {
    cfg: OpenClawConfig;
    ttsAuto?: string;
    agentId?: string;
    channelId?: string;
    accountId?: string;
}): boolean;
export declare function shouldCleanTtsDirectiveText(params: {
    cfg: OpenClawConfig;
    ttsAuto?: string;
    agentId?: string;
    channelId?: string;
    accountId?: string;
}): boolean;
