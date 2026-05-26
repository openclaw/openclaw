import type { SessionStatus } from "./status.types.js";
export { shortenText } from "./text-format.js";
export declare const formatKTokens: (value: number) => string;
export declare const formatDuration: (ms: number | null | undefined) => string;
export declare const formatTokensCompact: (sess: Pick<SessionStatus, "inputTokens" | "totalTokens" | "contextTokens" | "percentUsed" | "cacheRead" | "cacheWrite">) => string;
export declare const formatPromptCacheCompact: (sess: Pick<SessionStatus, "inputTokens" | "totalTokens" | "cacheRead" | "cacheWrite">) => string;
export declare const formatDaemonRuntimeShort: (runtime?: {
    status?: string;
    pid?: number;
    state?: string;
    detail?: string;
    missingUnit?: boolean;
}) => string | null;
