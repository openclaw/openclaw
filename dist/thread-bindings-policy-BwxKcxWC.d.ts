import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { t as ThreadBindingLifecycleRecord } from "./thread-binding-lifecycle-BzpPZ9dy.js";

//#region src/channels/thread-binding-id.d.ts
declare function resolveThreadBindingConversationIdFromBindingId(params: {
  accountId: string;
  bindingId?: string;
}): string | undefined;
//#endregion
//#region src/channels/thread-bindings-policy.d.ts
type ThreadBindingSpawnKind = "subagent" | "acp";
type ThreadBindingSpawnPolicy = {
  channel: string;
  accountId: string;
  enabled: boolean;
  spawnEnabled: boolean;
  defaultSpawnContext: ThreadBindingSpawnContext;
};
type ThreadBindingSpawnContext = "isolated" | "fork";
declare function resolveThreadBindingIdleTimeoutMs(params: {
  channelIdleHoursRaw: unknown;
  sessionIdleHoursRaw: unknown;
}): number;
declare function resolveThreadBindingMaxAgeMs(params: {
  channelMaxAgeHoursRaw: unknown;
  sessionMaxAgeHoursRaw: unknown;
}): number;
declare function resolveThreadBindingEffectiveExpiresAt(params: {
  record: ThreadBindingLifecycleRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
}): number | undefined;
declare function resolveThreadBindingsEnabled(params: {
  channelEnabledRaw: unknown;
  sessionEnabledRaw: unknown;
}): boolean;
declare function resolveThreadBindingSpawnPolicy(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  kind: ThreadBindingSpawnKind;
}): ThreadBindingSpawnPolicy;
declare function resolveThreadBindingIdleTimeoutMsForChannel(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
}): number;
declare function resolveThreadBindingMaxAgeMsForChannel(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
}): number;
declare function formatThreadBindingDisabledError(params: {
  channel: string;
  accountId: string;
  kind: ThreadBindingSpawnKind;
}): string;
declare function formatThreadBindingSpawnDisabledError(params: {
  channel: string;
  accountId: string;
  kind: ThreadBindingSpawnKind;
}): string;
//#endregion
export { resolveThreadBindingEffectiveExpiresAt as a, resolveThreadBindingMaxAgeMs as c, resolveThreadBindingsEnabled as d, resolveThreadBindingConversationIdFromBindingId as f, formatThreadBindingSpawnDisabledError as i, resolveThreadBindingMaxAgeMsForChannel as l, ThreadBindingSpawnPolicy as n, resolveThreadBindingIdleTimeoutMs as o, formatThreadBindingDisabledError as r, resolveThreadBindingIdleTimeoutMsForChannel as s, ThreadBindingSpawnKind as t, resolveThreadBindingSpawnPolicy as u };