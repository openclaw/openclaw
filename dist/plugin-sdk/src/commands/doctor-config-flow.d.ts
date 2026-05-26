import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";
export declare function loadAndMaybeMigrateDoctorConfig(params: {
    options: DoctorOptions;
    confirm: (p: {
        message: string;
        initialValue: boolean;
    }) => Promise<boolean>;
    runtime?: RuntimeEnv;
    prompter?: DoctorPrompter;
}): Promise<{
    cfg: OpenClawConfig;
    path: string;
    shouldWriteConfig: boolean;
    sourceConfigValid: boolean;
    sourceLastTouchedVersion?: string | undefined;
    skipPluginValidationOnWrite?: boolean | undefined;
}>;
