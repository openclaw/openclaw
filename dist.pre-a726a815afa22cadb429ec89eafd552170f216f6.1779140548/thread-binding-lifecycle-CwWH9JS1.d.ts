//#region src/channels/thread-bindings-messages.d.ts
declare function formatThreadBindingDurationLabel(durationMs: number): string;
declare function resolveThreadBindingThreadName(params: {
  agentId?: string;
  label?: string;
}): string;
declare function resolveThreadBindingIntroText(params: {
  agentId?: string;
  label?: string;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
  sessionCwd?: string;
  sessionDetails?: string[];
}): string;
declare function resolveThreadBindingFarewellText(params: {
  reason?: string;
  farewellText?: string;
  idleTimeoutMs: number;
  maxAgeMs: number;
}): string;
//#endregion
//#region src/shared/thread-binding-lifecycle.d.ts
type ThreadBindingLifecycleRecord = {
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
};
declare function resolveThreadBindingLifecycle(params: {
  record: ThreadBindingLifecycleRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
}): {
  expiresAt?: number;
  reason?: "idle-expired" | "max-age-expired";
};
//#endregion
export { resolveThreadBindingIntroText as a, resolveThreadBindingFarewellText as i, resolveThreadBindingLifecycle as n, resolveThreadBindingThreadName as o, formatThreadBindingDurationLabel as r, ThreadBindingLifecycleRecord as t };