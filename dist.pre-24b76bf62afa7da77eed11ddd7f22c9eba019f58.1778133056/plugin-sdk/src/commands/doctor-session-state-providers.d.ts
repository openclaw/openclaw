import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorSessionRouteStateOwner } from "../plugins/doctor-session-route-state-owner-types.js";
import { note } from "../terminal/note.js";
type DoctorPrompterLike = {
    confirmRuntimeRepair: (params: {
        message: string;
        initialValue?: boolean;
        requiresInteractiveConfirmation?: boolean;
    }) => Promise<boolean>;
    note?: typeof note;
};
export declare function resolveConfiguredDoctorSessionStateRoute(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    env?: NodeJS.ProcessEnv;
}): DoctorSessionRouteState;
export type DoctorSessionRouteState = {
    defaultProvider: string;
    configuredModelRefs: string[];
    runtime?: string;
};
export type DoctorSessionRouteStateRepair = {
    key: string;
    ownerId: string;
    ownerLabel: string;
    reasons: string[];
    cliSessionKeys: string[];
};
export type DoctorSessionRouteStateManualReview = {
    key: string;
    ownerLabel: string;
    message: string;
};
export type DoctorSessionRouteStateScan = {
    repairs: DoctorSessionRouteStateRepair[];
    manualReview: DoctorSessionRouteStateManualReview[];
};
export declare function scanSessionRouteStateOwners(params: {
    owners: readonly DoctorSessionRouteStateOwner[];
    store: Record<string, Record<string, unknown>>;
    routes: Record<string, DoctorSessionRouteState>;
}): DoctorSessionRouteStateScan;
export declare function applySessionRouteStateRepair(params: {
    entry: Record<string, unknown>;
    repair: DoctorSessionRouteStateRepair;
    now: number;
}): boolean;
export declare function runPluginSessionStateDoctorRepairs(params: {
    cfg: OpenClawConfig;
    store: Record<string, SessionEntry>;
    absoluteStorePath: string;
    prompter: DoctorPrompterLike;
    env?: NodeJS.ProcessEnv;
    warnings: string[];
    changes: string[];
}): Promise<void>;
export {};
