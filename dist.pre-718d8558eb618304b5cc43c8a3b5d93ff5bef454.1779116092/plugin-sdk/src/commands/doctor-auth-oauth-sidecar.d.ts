import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
declare const LEGACY_OAUTH_REF_SOURCE = "openclaw-credentials";
declare const LEGACY_OAUTH_REF_PROVIDER = "openai-codex";
type LegacyOAuthRef = {
    source: typeof LEGACY_OAUTH_REF_SOURCE;
    provider: typeof LEGACY_OAUTH_REF_PROVIDER;
    id: string;
};
export type LegacyOAuthSidecarRepairResult = {
    detected: string[];
    changes: string[];
    warnings: string[];
};
declare function buildLegacyOAuthSecretAad(params: {
    ref: LegacyOAuthRef;
    profileId: string;
    provider: string;
}): Buffer;
declare function buildLegacyOAuthSecretKey(seed: string): Buffer;
export declare function maybeRepairLegacyOAuthSidecarProfiles(params: {
    cfg: OpenClawConfig;
    prompter: Pick<DoctorPrompter, "confirmAutoFix">;
    now?: () => number;
    emitNotes?: boolean;
    env?: NodeJS.ProcessEnv;
}): Promise<LegacyOAuthSidecarRepairResult>;
export declare const __testing: {
    buildLegacyOAuthSecretAad: typeof buildLegacyOAuthSecretAad;
    buildLegacyOAuthSecretKey: typeof buildLegacyOAuthSecretKey;
};
export {};
