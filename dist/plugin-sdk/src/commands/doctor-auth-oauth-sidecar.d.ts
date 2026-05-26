import { type LegacyOAuthRef } from "../agents/auth-profiles/legacy-oauth-sidecar.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
export type LegacyOAuthSidecarRepairResult = {
    detected: string[];
    changes: string[];
    warnings: string[];
};
export declare function maybeRepairLegacyOAuthSidecarProfiles(params: {
    cfg: OpenClawConfig;
    prompter: Pick<DoctorPrompter, "confirmAutoFix">;
    now?: () => number;
    emitNotes?: boolean;
    env?: NodeJS.ProcessEnv;
}): Promise<LegacyOAuthSidecarRepairResult>;
export declare const testing: {
    buildLegacyOAuthSecretAad: (params: {
        ref: LegacyOAuthRef;
        profileId: string;
        provider: string;
    }) => Buffer;
    buildLegacyOAuthSecretKey: (seed: string) => Buffer;
};
export { testing as __testing };
