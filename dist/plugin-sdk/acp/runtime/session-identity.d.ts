import type { SessionAcpIdentity, SessionAcpMeta } from "../../config/sessions/types.js";
import type { AcpRuntimeHandle, AcpRuntimeStatus } from "./types.js";
export declare function resolveSessionIdentityFromMeta(meta: SessionAcpMeta | undefined): SessionAcpIdentity | undefined;
export declare function identityHasStableSessionId(identity: SessionAcpIdentity | undefined): boolean;
export declare function isSessionIdentityPending(identity: SessionAcpIdentity | undefined): boolean;
export declare function identityEquals(left: SessionAcpIdentity | undefined, right: SessionAcpIdentity | undefined): boolean;
export declare function mergeSessionIdentity(params: {
    current: SessionAcpIdentity | undefined;
    incoming: SessionAcpIdentity | undefined;
    now: number;
}): SessionAcpIdentity | undefined;
export declare function createIdentityFromEnsure(params: {
    handle: AcpRuntimeHandle;
    now: number;
}): SessionAcpIdentity | undefined;
export declare function createIdentityFromStatus(params: {
    status: AcpRuntimeStatus | undefined;
    now: number;
}): SessionAcpIdentity | undefined;
export declare function resolveRuntimeHandleIdentifiersFromIdentity(identity: SessionAcpIdentity | undefined): {
    backendSessionId?: string;
    agentSessionId?: string;
};
