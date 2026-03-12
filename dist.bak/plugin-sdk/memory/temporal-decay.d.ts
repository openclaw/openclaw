export type TemporalDecayConfig = {
    enabled: boolean;
    halfLifeDays: number;
};
export declare const DEFAULT_TEMPORAL_DECAY_CONFIG: TemporalDecayConfig;
export declare function toDecayLambda(halfLifeDays: number): number;
export declare function calculateTemporalDecayMultiplier(params: {
    ageInDays: number;
    halfLifeDays: number;
}): number;
export declare function applyTemporalDecayToScore(params: {
    score: number;
    ageInDays: number;
    halfLifeDays: number;
}): number;
export declare function applyTemporalDecayToHybridResults<T extends {
    path: string;
    score: number;
    source: string;
}>(params: {
    results: T[];
    temporalDecay?: Partial<TemporalDecayConfig>;
    workspaceDir?: string;
    nowMs?: number;
}): Promise<T[]>;
