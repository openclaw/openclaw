import type { OpenClawConfig } from "../config/types.js";
import type { TtsAutoMode, TtsProvider } from "../config/types.tts.js";
type TtsStatusSnapshot = {
    autoMode: TtsAutoMode;
    provider: TtsProvider;
    displayName?: string;
    model?: string;
    voice?: string;
    persona?: string;
    baseUrl?: string;
    customBaseUrl?: boolean;
    maxLength: number;
    summarize: boolean;
};
export declare function resolveStatusTtsSnapshot(params: {
    cfg: OpenClawConfig;
    sessionAuto?: string;
    agentId?: string;
    channelId?: string;
    accountId?: string;
}): TtsStatusSnapshot | null;
export {};
