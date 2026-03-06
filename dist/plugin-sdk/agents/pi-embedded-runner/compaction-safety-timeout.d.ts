export declare const EMBEDDED_COMPACTION_TIMEOUT_MS = 300000;
export declare function compactWithSafetyTimeout<T>(compact: () => Promise<T>, timeoutMs?: number): Promise<T>;
