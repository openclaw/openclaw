import { SessionAcpIdentity, SessionAcpMeta } from "../types.mjs";

//#region src/runtime/session-identifiers.d.ts
declare const ACP_SESSION_IDENTITY_RENDERER_VERSION = "v1";
type AcpSessionIdentifierRenderMode = "status" | "thread";
declare function resolveAcpSessionIdentifierLines(params: {
  sessionKey: string;
  meta?: SessionAcpMeta;
}): string[];
declare function resolveAcpSessionIdentifierLinesFromIdentity(params: {
  backend: string;
  identity?: SessionAcpIdentity;
  mode?: AcpSessionIdentifierRenderMode;
}): string[];
declare function resolveAcpSessionCwd(meta?: SessionAcpMeta): string | undefined;
declare function resolveAcpThreadSessionDetailLines(params: {
  sessionKey: string;
  meta?: SessionAcpMeta;
}): string[];
//#endregion
export { ACP_SESSION_IDENTITY_RENDERER_VERSION, AcpSessionIdentifierRenderMode, resolveAcpSessionCwd, resolveAcpSessionIdentifierLines, resolveAcpSessionIdentifierLinesFromIdentity, resolveAcpThreadSessionDetailLines };