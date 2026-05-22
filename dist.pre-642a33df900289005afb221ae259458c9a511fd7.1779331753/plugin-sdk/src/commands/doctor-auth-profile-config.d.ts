import type { OpenClawConfig } from "../config/types.openclaw.js";
export type AuthProfileConfigProtectionResult = {
    config: OpenClawConfig;
    repairs: string[];
    warnings: string[];
};
export declare function protectActiveAuthProfileConfig(params: {
    before: OpenClawConfig;
    after: OpenClawConfig;
}): AuthProfileConfigProtectionResult;
