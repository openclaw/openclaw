import type { OpenClawConfig } from "./types.openclaw.js";
export type OwnerDisplaySecretRuntimeState = {
    pendingByPath: Map<string, string>;
};
export declare function retainGeneratedOwnerDisplaySecret(params: {
    config: OpenClawConfig;
    configPath: string;
    generatedSecret?: string;
    state: OwnerDisplaySecretRuntimeState;
}): OpenClawConfig;
