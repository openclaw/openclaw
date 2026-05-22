import { type ResolverContext, type SecretDefaults } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
export declare const secretTargetRegistryEntries: import("openclaw/plugin-sdk/channel-secret-basic-runtime").SecretTargetRegistryEntry[];
export declare function collectRuntimeConfigAssignments(params: {
    config: {
        channels?: Record<string, unknown>;
    };
    defaults?: SecretDefaults;
    context: ResolverContext;
}): void;
export declare const channelSecrets: {
    secretTargetRegistryEntries: import("openclaw/plugin-sdk/channel-secret-basic-runtime").SecretTargetRegistryEntry[];
    collectRuntimeConfigAssignments: typeof collectRuntimeConfigAssignments;
};
