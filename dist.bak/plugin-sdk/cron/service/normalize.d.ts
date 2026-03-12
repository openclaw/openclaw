import type { CronPayload } from "../types.js";
export declare function normalizeRequiredName(raw: unknown): string;
export declare function normalizeOptionalText(raw: unknown): string | undefined;
export declare function normalizeOptionalAgentId(raw: unknown): string | undefined;
export declare function normalizeOptionalSessionKey(raw: unknown): string | undefined;
export declare function inferLegacyName(job: {
    schedule?: {
        kind?: unknown;
        everyMs?: unknown;
        expr?: unknown;
    };
    payload?: {
        kind?: unknown;
        text?: unknown;
        message?: unknown;
    };
}): string;
export declare function normalizePayloadToSystemText(payload: CronPayload): string;
