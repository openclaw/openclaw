import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { o as resolveThreadBindingThreadName } from "./thread-binding-lifecycle-BzpPZ9dy.js";

//#region extensions/discord/src/monitor/thread-bindings.types.d.ts
type ThreadBindingTargetKind = "subagent" | "acp";
type ThreadBindingRecord = {
  accountId: string;
  channelId: string;
  threadId: string;
  targetKind: ThreadBindingTargetKind;
  targetSessionKey: string;
  agentId: string;
  label?: string;
  webhookId?: string;
  webhookToken?: string;
  boundBy: string;
  boundAt: number;
  lastActivityAt: number; /** Inactivity timeout window in milliseconds (0 disables inactivity auto-unfocus). */
  idleTimeoutMs?: number; /** Hard max-age window in milliseconds from bind time (0 disables hard cap). */
  maxAgeMs?: number;
  metadata?: Record<string, unknown>;
};
type ThreadBindingManager = {
  accountId: string;
  getIdleTimeoutMs: () => number;
  getMaxAgeMs: () => number;
  getByThreadId: (threadId: string) => ThreadBindingRecord | undefined;
  getBySessionKey: (targetSessionKey: string) => ThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => ThreadBindingRecord[];
  listBindings: () => ThreadBindingRecord[];
  touchThread: (params: {
    threadId: string;
    at?: number;
    persist?: boolean;
  }) => ThreadBindingRecord | null;
  bindTarget: (params: {
    threadId?: string | number;
    channelId?: string;
    createThread?: boolean;
    threadName?: string;
    targetKind: ThreadBindingTargetKind;
    targetSessionKey: string;
    agentId?: string;
    label?: string;
    boundBy?: string;
    introText?: string;
    webhookId?: string;
    webhookToken?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<ThreadBindingRecord | null>;
  unbindThread: (params: {
    threadId: string;
    reason?: string;
    sendFarewell?: boolean;
    farewellText?: string;
  }) => ThreadBindingRecord | null;
  unbindBySessionKey: (params: {
    targetSessionKey: string;
    targetKind?: ThreadBindingTargetKind;
    reason?: string;
    sendFarewell?: boolean;
    farewellText?: string;
  }) => ThreadBindingRecord[];
  stop: () => void;
};
//#endregion
//#region extensions/discord/src/monitor/thread-bindings.state.d.ts
declare function resolveThreadBindingsPath(): string;
declare function resolveThreadBindingIdleTimeoutMs(params: {
  record: Pick<ThreadBindingRecord, "idleTimeoutMs">;
  defaultIdleTimeoutMs: number;
}): number;
declare function resolveThreadBindingMaxAgeMs(params: {
  record: Pick<ThreadBindingRecord, "maxAgeMs">;
  defaultMaxAgeMs: number;
}): number;
declare function resolveThreadBindingInactivityExpiresAt(params: {
  record: Pick<ThreadBindingRecord, "lastActivityAt" | "idleTimeoutMs">;
  defaultIdleTimeoutMs: number;
}): number | undefined;
declare function resolveThreadBindingMaxAgeExpiresAt(params: {
  record: Pick<ThreadBindingRecord, "boundAt" | "maxAgeMs">;
  defaultMaxAgeMs: number;
}): number | undefined;
declare function isRecentlyUnboundThreadWebhookMessage(params: {
  accountId?: string;
  threadId: string;
  webhookId?: string | null;
}): boolean;
declare function resetThreadBindingsForTests(): void;
//#endregion
//#region extensions/discord/src/monitor/thread-bindings.manager.d.ts
declare function createThreadBindingManager(params: {
  accountId?: string;
  token?: string;
  cfg: OpenClawConfig;
  persist?: boolean;
  enableSweeper?: boolean;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
}): ThreadBindingManager;
declare function createNoopThreadBindingManager(accountId?: string): ThreadBindingManager;
declare function getThreadBindingManager(accountId?: string): ThreadBindingManager | null;
declare const testing: {
  resolveThreadBindingsPath: typeof resolveThreadBindingsPath;
  resolveThreadBindingThreadName: typeof resolveThreadBindingThreadName;
  resetThreadBindingsForTests: typeof resetThreadBindingsForTests;
  runThreadBindingSweepForAccount: (accountId?: string) => Promise<void>;
};
//#endregion
export { isRecentlyUnboundThreadWebhookMessage as a, resolveThreadBindingMaxAgeExpiresAt as c, ThreadBindingRecord as d, ThreadBindingTargetKind as f, testing as i, resolveThreadBindingMaxAgeMs as l, createThreadBindingManager as n, resolveThreadBindingIdleTimeoutMs as o, getThreadBindingManager as r, resolveThreadBindingInactivityExpiresAt as s, createNoopThreadBindingManager as t, ThreadBindingManager as u };