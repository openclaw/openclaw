import type { GatewayServiceEnvironmentValueSource } from "./service-types.js";
export type ServiceEnvSource = "state-dotenv" | "config-env" | "config-secretref-env" | "exec-passenv" | "auth-profile-env" | "existing-preserved" | "service-generated";
export type ServiceEnvPlanEntry = {
    rawKey: string;
    normalizedKey: string;
    value: string;
    source: ServiceEnvSource;
};
export type MutableServiceEnvPlan = {
    environment: Record<string, string | undefined>;
    environmentValueSources: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
    entriesByNormalizedKey: Map<string, ServiceEnvPlanEntry>;
};
export declare function createMutableServiceEnvPlan(): MutableServiceEnvPlan;
export declare function normalizeServiceEnvPlanKey(rawKey: string): string | undefined;
export declare function addServiceEnvPlanEntries(plan: MutableServiceEnvPlan, entries: Record<string, string | undefined>, options: {
    source: ServiceEnvSource;
    includeRawKeys?: boolean;
    valueSource?: GatewayServiceEnvironmentValueSource | ((params: {
        rawKey: string;
        normalizedKey: string;
    }) => GatewayServiceEnvironmentValueSource | undefined);
}): void;
export declare function compactServiceEnvPlanValueSources(plan: MutableServiceEnvPlan): void;
