export declare function formatThreadBindingDurationLabel(durationMs: number): string;
export declare function resolveThreadBindingThreadName(params: {
    agentId?: string;
    label?: string;
}): string;
export declare function resolveThreadBindingIntroText(params: {
    agentId?: string;
    label?: string;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
    sessionCwd?: string;
    sessionDetails?: string[];
}): string;
export declare function resolveThreadBindingFarewellText(params: {
    reason?: string;
    farewellText?: string;
    idleTimeoutMs: number;
    maxAgeMs: number;
}): string;
