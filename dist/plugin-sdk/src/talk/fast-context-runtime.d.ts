import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RealtimeVoiceAgentConsultResult } from "./agent-consult-runtime.js";
type Logger = {
    debug?: (message: string) => void;
};
export type RealtimeVoiceFastContextConfig = {
    enabled: boolean;
    maxResults: number;
    sources: Array<"memory" | "sessions">;
    timeoutMs: number;
    fallbackToConsult: boolean;
};
export type RealtimeVoiceFastContextLabels = {
    audienceLabel: string;
    contextName: string;
};
export type RealtimeVoiceFastContextConsultResult = {
    handled: false;
} | {
    handled: true;
    result: RealtimeVoiceAgentConsultResult;
};
export declare function resolveRealtimeVoiceFastContextConsult(params: {
    cfg: OpenClawConfig;
    agentId: string;
    sessionKey: string;
    config: RealtimeVoiceFastContextConfig;
    args: unknown;
    logger: Logger;
    labels?: Partial<RealtimeVoiceFastContextLabels>;
}): Promise<RealtimeVoiceFastContextConsultResult>;
export {};
