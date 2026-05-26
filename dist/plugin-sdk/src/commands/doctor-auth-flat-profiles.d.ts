import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
export type LegacyFlatAuthProfileRepairResult = {
    detected: string[];
    changes: string[];
    warnings: string[];
};
export declare function maybeRepairLegacyFlatAuthProfileStores(params: {
    cfg: OpenClawConfig;
    prompter: DoctorPrompter;
    now?: () => number;
}): Promise<LegacyFlatAuthProfileRepairResult>;
