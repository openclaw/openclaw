import type { OpenClawConfig } from "../../../config/types.openclaw.js";
export declare function collectVisibleReplyToolPolicyWarnings(cfg: OpenClawConfig): string[];
export declare function collectDoctorPreviewWarnings(params: {
    cfg: OpenClawConfig;
    doctorFixCommand: string;
    env?: NodeJS.ProcessEnv;
}): Promise<string[]>;
