import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorPrompter, DoctorOptions } from "./doctor-prompter.js";
type CrontabReader = () => Promise<{
    stdout: string;
    stderr?: string;
}>;
export declare function noteLegacyWhatsAppCrontabHealthCheck(params?: {
    platform?: NodeJS.Platform;
    readCrontab?: CrontabReader;
}): Promise<void>;
export declare function maybeRepairLegacyCronStore(params: {
    cfg: OpenClawConfig;
    options: DoctorOptions;
    prompter: Pick<DoctorPrompter, "confirm">;
}): Promise<void>;
export {};
