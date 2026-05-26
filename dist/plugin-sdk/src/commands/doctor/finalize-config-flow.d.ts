import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function finalizeDoctorConfigFlow(params: {
    cfg: OpenClawConfig;
    candidate: OpenClawConfig;
    pendingChanges: boolean;
    shouldRepair: boolean;
    fixHints: string[];
    confirm: (p: {
        message: string;
        initialValue: boolean;
    }) => Promise<boolean>;
    note: (message: string, title?: string) => void;
}): Promise<{
    cfg: OpenClawConfig;
    shouldWriteConfig: boolean;
}>;
