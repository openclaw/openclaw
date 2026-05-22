import type { DoctorOptions } from "./doctor.types.js";
export type DoctorRepairMode = {
    shouldRepair: boolean;
    shouldForce: boolean;
    nonInteractive: boolean;
    canPrompt: boolean;
    updateInProgress: boolean;
};
export declare function resolveDoctorRepairMode(options: DoctorOptions): DoctorRepairMode;
export declare function isDoctorUpdateRepairMode(mode: DoctorRepairMode): boolean;
export declare function shouldAutoApproveDoctorFix(mode: DoctorRepairMode, params?: {
    requiresForce?: boolean;
    blockDuringUpdate?: boolean;
}): boolean;
