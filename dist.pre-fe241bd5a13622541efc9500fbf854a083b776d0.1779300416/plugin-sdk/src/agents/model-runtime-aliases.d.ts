import type { OpenClawConfig } from "../config/types.openclaw.js";
type LegacyRuntimeModelProviderAlias = {
    /** Legacy provider id that encoded the runtime in the model ref. */
    legacyProvider: string;
    /** Canonical provider id that should own model selection. */
    provider: string;
    /** Runtime/backend id selected for the migrated ref. */
    runtime: string;
    /** True when the runtime is a CLI backend rather than an embedded harness. */
    cli: boolean;
    /** True when doctor must write a runtime policy even if the target runtime is the default. */
    requiresRuntimePolicy: boolean;
};
export declare function legacyRuntimeModelAliasRequiresRuntimePolicy(provider: string): boolean;
export declare function listLegacyRuntimeModelProviderAliases(): readonly LegacyRuntimeModelProviderAlias[];
/** True for CLI runtime provider ids such as `claude-cli` and `google-gemini-cli`. */
export declare function isCliRuntimeProvider(provider: string): boolean;
export declare function migrateLegacyRuntimeModelRef(raw: string): {
    ref: string;
    legacyProvider: string;
    provider: string;
    model: string;
    runtime: string;
    cli: boolean;
} | null;
/** Shared setup/default pickers hide all legacy runtime provider ids. */
export declare function isLegacyRuntimeModelProvider(provider: string): boolean;
export declare function isCliRuntimeAlias(runtime: string | undefined): boolean;
export declare function areRuntimeModelRefsEquivalent(left: string, right: string): boolean;
export declare function resolveCliRuntimeExecutionProvider(params: {
    provider: string;
    cfg?: OpenClawConfig;
    agentId?: string;
    modelId?: string;
    authProfileId?: string;
}): string | undefined;
export {};
