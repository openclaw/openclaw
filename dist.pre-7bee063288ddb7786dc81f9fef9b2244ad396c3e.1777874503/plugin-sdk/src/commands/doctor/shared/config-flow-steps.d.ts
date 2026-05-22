import type { DoctorConfigPreflightResult } from "../../doctor-config-preflight.js";
import type { DoctorConfigMutationState } from "./config-mutation-state.js";
export declare function applyLegacyCompatibilityStep(params: {
    snapshot: DoctorConfigPreflightResult["snapshot"];
    state: DoctorConfigMutationState;
    shouldRepair: boolean;
    doctorFixCommand: string;
}): {
    state: DoctorConfigMutationState;
    issueLines: string[];
    changeLines: string[];
};
export declare function applyUnknownConfigKeyStep(params: {
    state: DoctorConfigMutationState;
    shouldRepair: boolean;
    doctorFixCommand: string;
}): {
    state: DoctorConfigMutationState;
    removed: string[];
};
