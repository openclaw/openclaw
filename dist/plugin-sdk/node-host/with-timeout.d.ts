export declare function withTimeout<T>(work: (signal: AbortSignal | undefined) => Promise<T>, timeoutMs?: number, label?: string): Promise<T>;
