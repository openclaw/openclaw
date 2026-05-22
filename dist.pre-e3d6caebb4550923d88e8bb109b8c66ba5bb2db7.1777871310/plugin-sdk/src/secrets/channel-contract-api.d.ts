import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ResolverContext, SecretDefaults } from "./runtime-shared.js";
import type { SecretTargetRegistryEntry } from "./target-registry-types.js";
type UnsupportedSecretRefConfigCandidate = {
    path: string;
    value: unknown;
};
type BundledChannelContractApi = {
    collectRuntimeConfigAssignments?: (params: {
        config: OpenClawConfig;
        defaults: SecretDefaults | undefined;
        context: ResolverContext;
    }) => void;
    secretTargetRegistryEntries?: readonly SecretTargetRegistryEntry[];
    unsupportedSecretRefSurfacePatterns?: readonly string[];
    collectUnsupportedSecretRefConfigCandidates?: (raw: Record<string, unknown>) => UnsupportedSecretRefConfigCandidate[];
};
export type BundledChannelSecretContractApi = Pick<BundledChannelContractApi, "collectRuntimeConfigAssignments" | "secretTargetRegistryEntries">;
export declare function loadBundledChannelSecretContractApi(channelId: string): BundledChannelSecretContractApi | undefined;
export type BundledChannelSecurityContractApi = Pick<BundledChannelContractApi, "unsupportedSecretRefSurfacePatterns" | "collectUnsupportedSecretRefConfigCandidates">;
export declare function loadBundledChannelSecurityContractApi(channelId: string): BundledChannelSecurityContractApi | undefined;
export {};
