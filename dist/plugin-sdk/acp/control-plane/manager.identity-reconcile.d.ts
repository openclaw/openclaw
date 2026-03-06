import type { OpenClawConfig } from "../../config/config.js";
import type { AcpRuntime, AcpRuntimeHandle, AcpRuntimeStatus } from "../runtime/types.js";
import type { SessionAcpMeta, SessionEntry } from "./manager.types.js";
export declare function reconcileManagerRuntimeSessionIdentifiers(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
    meta: SessionAcpMeta;
    runtimeStatus?: AcpRuntimeStatus;
    failOnStatusError: boolean;
    setCachedHandle: (sessionKey: string, handle: AcpRuntimeHandle) => void;
    writeSessionMeta: (params: {
        cfg: OpenClawConfig;
        sessionKey: string;
        mutate: (current: SessionAcpMeta | undefined, entry: SessionEntry | undefined) => SessionAcpMeta | null | undefined;
        failOnError?: boolean;
    }) => Promise<SessionEntry | null>;
}): Promise<{
    handle: AcpRuntimeHandle;
    meta: SessionAcpMeta;
    runtimeStatus?: AcpRuntimeStatus;
}>;
