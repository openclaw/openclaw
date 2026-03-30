import type { OpenClawConfig } from "../../config/config.js";
export type AcpSpawnRuntimeCloseHandle = {
    runtime: {
        close: (params: {
            handle: {
                sessionKey: string;
                backend: string;
                runtimeSessionName: string;
            };
            reason: string;
        }) => Promise<void>;
    };
    handle: {
        sessionKey: string;
        backend: string;
        runtimeSessionName: string;
    };
};
export declare function cleanupFailedAcpSpawn(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    shouldDeleteSession: boolean;
    deleteTranscript: boolean;
    runtimeCloseHandle?: AcpSpawnRuntimeCloseHandle;
}): Promise<void>;
