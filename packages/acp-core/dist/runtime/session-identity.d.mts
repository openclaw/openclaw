import { SessionAcpIdentity, SessionAcpMeta } from "../types.mjs";
import { AcpRuntimeHandle, AcpRuntimeStatus } from "./types.mjs";

//#region src/runtime/session-identity.d.ts
declare function resolveSessionIdentityFromMeta(meta: SessionAcpMeta | undefined): SessionAcpIdentity | undefined;
declare function identityHasStableSessionId(identity: SessionAcpIdentity | undefined): boolean;
declare function resolveRuntimeResumeSessionId(identity: SessionAcpIdentity | undefined): string | undefined;
declare function isSessionIdentityPending(identity: SessionAcpIdentity | undefined): boolean;
declare function identityEquals(left: SessionAcpIdentity | undefined, right: SessionAcpIdentity | undefined): boolean;
declare function mergeSessionIdentity(params: {
  current: SessionAcpIdentity | undefined;
  incoming: SessionAcpIdentity | undefined;
  now: number;
}): SessionAcpIdentity | undefined;
declare function createIdentityFromEnsure(params: {
  handle: AcpRuntimeHandle;
  now: number;
}): SessionAcpIdentity | undefined;
declare function createIdentityFromHandleEvent(params: {
  handle: AcpRuntimeHandle;
  now: number;
}): SessionAcpIdentity | undefined;
declare function createIdentityFromStatus(params: {
  status: AcpRuntimeStatus | undefined;
  now: number;
}): SessionAcpIdentity | undefined;
declare function resolveRuntimeHandleIdentifiersFromIdentity(identity: SessionAcpIdentity | undefined): {
  backendSessionId?: string;
  agentSessionId?: string;
};
//#endregion
export { createIdentityFromEnsure, createIdentityFromHandleEvent, createIdentityFromStatus, identityEquals, identityHasStableSessionId, isSessionIdentityPending, mergeSessionIdentity, resolveRuntimeHandleIdentifiersFromIdentity, resolveRuntimeResumeSessionId, resolveSessionIdentityFromMeta };