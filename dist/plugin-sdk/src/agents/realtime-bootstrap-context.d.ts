import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare const REALTIME_BOOTSTRAP_CONTEXT_FILE_NAMES: readonly ["IDENTITY.md", "USER.md", "SOUL.md"];
export type RealtimeBootstrapContextFileName = (typeof REALTIME_BOOTSTRAP_CONTEXT_FILE_NAMES)[number];
export declare function resolveRealtimeBootstrapContextInstructions(params: {
    agentId: string;
    config: OpenClawConfig;
    files?: readonly RealtimeBootstrapContextFileName[];
    sessionKey?: string;
    warn?: (message: string) => void;
}): Promise<string | undefined>;
