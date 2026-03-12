import type { SessionAcpIdentity, SessionAcpMeta } from "../../config/sessions/types.js";
export declare const ACP_SESSION_IDENTITY_RENDERER_VERSION = "v1";
export type AcpSessionIdentifierRenderMode = "status" | "thread";
export declare function resolveAcpSessionIdentifierLines(params: {
    sessionKey: string;
    meta?: SessionAcpMeta;
}): string[];
export declare function resolveAcpSessionIdentifierLinesFromIdentity(params: {
    backend: string;
    identity?: SessionAcpIdentity;
    mode?: AcpSessionIdentifierRenderMode;
}): string[];
export declare function resolveAcpSessionCwd(meta?: SessionAcpMeta): string | undefined;
export declare function resolveAcpThreadSessionDetailLines(params: {
    sessionKey: string;
    meta?: SessionAcpMeta;
}): string[];
