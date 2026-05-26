import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function expectGeneratedTokenPersistedToGatewayAuth(params: {
    generatedToken?: string;
    authToken?: string;
    persistedConfig?: OpenClawConfig;
}): void;
