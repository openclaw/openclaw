import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare const EMBEDDED_COMPACTION_TIMEOUT_MS = 900000;
export declare function resolveCompactionTimeoutMs(cfg?: OpenClawConfig): number;
export declare function compactWithSafetyTimeout<T>(compact: () => Promise<T>, timeoutMs?: number, opts?: {
    abortSignal?: AbortSignal;
    onCancel?: () => void;
}): Promise<T>;
