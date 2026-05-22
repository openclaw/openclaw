import type { OpenClawConfig } from "./types.openclaw.js";
export type OwnerDisplaySecretPersistState = {
    pendingByPath: Map<string, string>;
    persistInFlight: Set<string>;
    persistWarned: Set<string>;
};
export declare function persistGeneratedOwnerDisplaySecret(params: {
    config: OpenClawConfig;
    configPath: string;
    generatedSecret?: string;
    logger: Pick<typeof console, "warn">;
    state: OwnerDisplaySecretPersistState;
    persistConfig: (config: OpenClawConfig, options: {
        expectedConfigPath: string;
    }) => Promise<unknown>;
}): OpenClawConfig;
