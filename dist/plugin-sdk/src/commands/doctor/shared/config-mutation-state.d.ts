import type { OpenClawConfig } from "../../../config/types.openclaw.js";
export type DoctorConfigMutationState = {
    cfg: OpenClawConfig;
    candidate: OpenClawConfig;
    pendingChanges: boolean;
    fixHints: string[];
};
export type DoctorConfigMutationResult = {
    config: OpenClawConfig;
    changes: string[];
};
export declare function applyDoctorConfigMutation(params: {
    state: DoctorConfigMutationState;
    mutation: DoctorConfigMutationResult;
    shouldRepair: boolean;
    fixHint?: string;
}): DoctorConfigMutationState;
