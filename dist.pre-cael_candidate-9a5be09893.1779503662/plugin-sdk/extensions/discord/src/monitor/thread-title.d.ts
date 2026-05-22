import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export declare function generateThreadTitle(params: {
    cfg: OpenClawConfig;
    agentId: string;
    messageText: string;
    modelRef?: string;
    channelName?: string;
    channelDescription?: string;
    timeoutMs?: number;
}): Promise<string | null>;
export declare function normalizeGeneratedThreadTitle(raw: string): string;
