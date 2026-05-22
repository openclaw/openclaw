import { type ResolverContext, type SecretDefaults, type SecretTargetRegistryEntry } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
export declare const secretTargetRegistryEntries: SecretTargetRegistryEntry[];
export declare function collectRuntimeConfigAssignments(params: {
    config: {
        channels?: Record<string, unknown>;
    };
    defaults?: SecretDefaults;
    context: ResolverContext;
}): void;
