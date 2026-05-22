import type { OpenClawConfig } from "../../config/types.openclaw.js";
export type ExternalCliAuthScope = {
    providerIds: string[];
    profileIds: string[];
};
export declare function resolveExternalCliAuthScopeFromConfig(cfg: OpenClawConfig): ExternalCliAuthScope | undefined;
