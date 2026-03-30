/**
 * Detects obfuscated or encoded commands that could bypass allowlist-based
 * security filters.
 *
 * Addresses: https://github.com/openclaw/openclaw/issues/8592
 */
export type ObfuscationDetection = {
    detected: boolean;
    reasons: string[];
    matchedPatterns: string[];
};
export declare function detectCommandObfuscation(command: string): ObfuscationDetection;
