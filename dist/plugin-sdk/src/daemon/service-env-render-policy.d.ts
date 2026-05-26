import type { MutableServiceEnvPlan } from "./service-env-plan.js";
export declare function applyManagedServiceEnvRenderPolicy(params: {
    plan: MutableServiceEnvPlan;
    managedServiceEnvKeys: string | undefined;
    serviceEnvironment: Record<string, string | undefined>;
    platform: NodeJS.Platform;
}): void;
