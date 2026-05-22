import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
export declare function noteLegacyCodexProviderOverride(cfg: OpenClawConfig): void;
export declare function resolveUnusableProfileHint(params: {
    kind: "cooldown" | "disabled";
    reason?: string;
}): string;
export declare function formatOAuthRefreshFailureDoctorLine(params: {
    profileId: string;
    provider: string;
    message: string;
}): string | null;
export declare function noteAuthProfileHealth(params: {
    cfg: OpenClawConfig;
    prompter: DoctorPrompter;
    allowKeychainPrompt: boolean;
}): Promise<void>;
