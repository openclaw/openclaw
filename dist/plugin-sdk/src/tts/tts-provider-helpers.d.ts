export declare function requireInRange(value: number, min: number, max: number, label: string): void;
export declare function normalizeLanguageCode(code?: string): string | undefined;
export declare function normalizeApplyTextNormalization(mode?: string): "auto" | "on" | "off" | undefined;
export declare function normalizeSeed(seed?: number): number | undefined;
export declare function scheduleCleanup(tempDir: string, delayMs?: number): void;
