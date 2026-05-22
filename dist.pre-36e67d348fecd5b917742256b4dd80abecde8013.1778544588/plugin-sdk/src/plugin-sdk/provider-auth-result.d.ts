import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthResult } from "../plugins/types.js";
/** Build the standard auth result payload for OAuth-style provider login flows. */
export declare function buildOauthProviderAuthResult(params: {
    providerId: string;
    defaultModel: string;
    access: string;
    refresh?: string | null;
    expires?: number | null;
    email?: string | null;
    displayName?: string | null;
    profileName?: string | null;
    profilePrefix?: string;
    credentialExtra?: Record<string, unknown>;
    configPatch?: Partial<OpenClawConfig>;
    notes?: string[];
}): ProviderAuthResult;
