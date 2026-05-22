import type { OpenClawConfig } from "../config/types.openclaw.js";
type LegacyRuntimeModelProviderAlias = {
    /** Legacy provider id that encoded the runtime in the model ref. */
    legacyProvider: string;
    /** Canonical provider id that should own model selection. */
    provider: string;
    /** Runtime/backend id that preserves the old execution behavior. */
    runtime: string;
    /** True when the runtime is a CLI backend rather than an embedded harness. */
    cli: boolean;
};
export declare function listLegacyRuntimeModelProviderAliases(): readonly LegacyRuntimeModelProviderAlias[];
export declare function migrateLegacyRuntimeModelRef(raw: string): {
    ref: string;
    legacyProvider: string;
    provider: string;
    model: string;
    runtime: string;
    cli: boolean;
} | null;
export declare function isLegacyRuntimeModelProvider(provider: string): boolean;
export declare function isCliRuntimeAlias(runtime: string | undefined): boolean;
export declare function resolveCliRuntimeExecutionProvider(params: {
    provider: string;
    cfg?: OpenClawConfig;
    agentId?: string;
    runtimeOverride?: string;
}): string | undefined;
export {};
