import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
type Formatter = (value: string) => string;
export declare function formatUpdateRestartStatusValue(payload: RestartSentinelPayload | null | undefined, opts?: {
    ok?: Formatter;
    warn?: Formatter;
    muted?: Formatter;
    nowMs?: number;
    formatTimeAgo?: (ageMs: number) => string;
}): string | null;
export declare function formatUpdateRestartActionLines(payload: RestartSentinelPayload | null | undefined): string[];
export {};
