import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { t as AcpSessionStoreEntry } from "./session-meta-DS_CKwIP.js";
import { d as ThreadBindingRecord, f as ThreadBindingTargetKind } from "./thread-bindings.manager-BHR-9Y46.js";
//#region extensions/discord/src/monitor/thread-bindings.persona.d.ts
declare function resolveThreadBindingPersona(params: {
  label?: string;
  agentId?: string;
}): string;
declare function resolveThreadBindingPersonaFromRecord(record: ThreadBindingRecord): string;
//#endregion
//#region extensions/discord/src/monitor/thread-bindings.config.d.ts
declare function resolveDiscordThreadBindingIdleTimeoutMs(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): number;
declare function resolveDiscordThreadBindingMaxAgeMs(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): number;
//#endregion
//#region extensions/discord/src/monitor/thread-bindings.session-updates.d.ts
declare function setThreadBindingIdleTimeoutBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  idleTimeoutMs: number;
}): ThreadBindingRecord[];
declare function setThreadBindingMaxAgeBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  maxAgeMs: number;
}): ThreadBindingRecord[];
//#endregion
//#region extensions/discord/src/monitor/thread-bindings.lifecycle.d.ts
type AcpThreadBindingReconciliationResult = {
  checked: number;
  removed: number;
  staleSessionKeys: string[];
};
type AcpThreadBindingHealthStatus = "healthy" | "stale" | "uncertain";
type AcpThreadBindingHealthProbe = (params: {
  cfg: OpenClawConfig;
  accountId: string;
  sessionKey: string;
  binding: ThreadBindingRecord;
  session: AcpSessionStoreEntry;
}) => Promise<{
  status: AcpThreadBindingHealthStatus;
  reason?: string;
}>;
declare function listThreadBindingsForAccount(accountId?: string): ThreadBindingRecord[];
declare function listThreadBindingsBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
}): ThreadBindingRecord[];
declare function autoBindSpawnedDiscordSubagent(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  channel?: string;
  to?: string;
  threadId?: string | number;
  childSessionKey: string;
  agentId: string;
  label?: string;
  boundBy?: string;
}): Promise<ThreadBindingRecord | null>;
declare function unbindThreadBindingsBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
  reason?: string;
  sendFarewell?: boolean;
  farewellText?: string;
}): ThreadBindingRecord[];
declare function reconcileAcpThreadBindingsOnStartup(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  sendFarewell?: boolean;
  healthProbe?: AcpThreadBindingHealthProbe;
}): Promise<AcpThreadBindingReconciliationResult>;
//#endregion
export { reconcileAcpThreadBindingsOnStartup as a, setThreadBindingMaxAgeBySessionKey as c, resolveThreadBindingPersona as d, resolveThreadBindingPersonaFromRecord as f, listThreadBindingsForAccount as i, resolveDiscordThreadBindingIdleTimeoutMs as l, autoBindSpawnedDiscordSubagent as n, unbindThreadBindingsBySessionKey as o, listThreadBindingsBySessionKey as r, setThreadBindingIdleTimeoutBySessionKey as s, AcpThreadBindingReconciliationResult as t, resolveDiscordThreadBindingMaxAgeMs as u };