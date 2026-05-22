import { type AcpSessionStoreEntry } from "openclaw/plugin-sdk/acp-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export { setThreadBindingIdleTimeoutBySessionKey, setThreadBindingMaxAgeBySessionKey, } from "./thread-bindings.session-updates.js";
import type { ThreadBindingRecord, ThreadBindingTargetKind } from "./thread-bindings.types.js";
export type AcpThreadBindingReconciliationResult = {
    checked: number;
    removed: number;
    staleSessionKeys: string[];
};
export type AcpThreadBindingHealthStatus = "healthy" | "stale" | "uncertain";
export type AcpThreadBindingHealthProbe = (params: {
    cfg: OpenClawConfig;
    accountId: string;
    sessionKey: string;
    binding: ThreadBindingRecord;
    session: AcpSessionStoreEntry;
}) => Promise<{
    status: AcpThreadBindingHealthStatus;
    reason?: string;
}>;
export declare function listThreadBindingsForAccount(accountId?: string): ThreadBindingRecord[];
export declare function listThreadBindingsBySessionKey(params: {
    targetSessionKey: string;
    accountId?: string;
    targetKind?: ThreadBindingTargetKind;
}): ThreadBindingRecord[];
export declare function autoBindSpawnedDiscordSubagent(params: {
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
export declare function unbindThreadBindingsBySessionKey(params: {
    targetSessionKey: string;
    accountId?: string;
    targetKind?: ThreadBindingTargetKind;
    reason?: string;
    sendFarewell?: boolean;
    farewellText?: string;
}): ThreadBindingRecord[];
export declare function reconcileAcpThreadBindingsOnStartup(params: {
    cfg: OpenClawConfig;
    accountId?: string;
    sendFarewell?: boolean;
    healthProbe?: AcpThreadBindingHealthProbe;
}): Promise<AcpThreadBindingReconciliationResult>;
