import { type RestartSentinelPayload } from "./restart-sentinel.js";
import { type UpdateRestartSentinelMeta } from "./update-restart-sentinel-payload.js";
import type { UpdateRunResult } from "./update-runner.js";
export declare const CONTROL_PLANE_UPDATE_SENTINEL_META_ENV = "OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META";
export declare const CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON = "managed-service-handoff-started";
export declare const CONTROL_PLANE_UPDATE_RESTART_HEALTH_PENDING_REASON = "restart-health-pending";
export type ControlPlaneUpdateSentinelMetaFile = {
    version: 1;
    meta: UpdateRestartSentinelMeta;
};
export declare function buildControlPlaneUpdateRestartHealthPendingResult(result: UpdateRunResult): UpdateRunResult;
export declare function isPendingControlPlaneUpdateRestartSentinel(payload: RestartSentinelPayload): boolean;
export declare function readControlPlaneUpdateSentinelMeta(env?: NodeJS.ProcessEnv): Promise<UpdateRestartSentinelMeta | null>;
export declare function writeControlPlaneUpdateRestartSentinel(params: {
    result: UpdateRunResult;
    meta: UpdateRestartSentinelMeta;
}): Promise<string>;
export declare function markControlPlaneUpdateRestartSentinelFailure(reason: string): Promise<RestartSentinelPayload | null>;
