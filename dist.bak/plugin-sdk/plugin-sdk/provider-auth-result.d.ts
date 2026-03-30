import type { OpenClawConfig } from "../config/config.js";
import type { ProviderAuthResult } from "../plugins/types.js";
export declare function buildOauthProviderAuthResult(params: {
    providerId: string;
    defaultModel: string;
    access: string;
    refresh?: string | null;
    expires?: number | null;
    email?: string | null;
    profilePrefix?: string;
    credentialExtra?: Record<string, unknown>;
    configPatch?: Partial<OpenClawConfig>;
    notes?: string[];
}): ProviderAuthResult;
