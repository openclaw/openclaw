import {
  normalizeNonNegativeMs,
  resolveBindingIdsForTargetSession,
  mutateBindingsForTargetSession,
  updateBindingsForTargetSessionSync,
} from "./thread-bindings.session-shared.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

export async function setThreadBindingIdleTimeoutBySessionKeyAsync(input: {
  targetSessionKey: string;
  accountId?: string;
  idleTimeoutMs: number;
}): Promise<ThreadBindingRecord[]> {
  const params = { ...input };
  const idleTimeoutMs = normalizeNonNegativeMs(params.idleTimeoutMs);
  return mutateBindingsForTargetSession(params, (existing, now) => ({
    ...existing,
    idleTimeoutMs,
    lastActivityAt: now,
  }));
}

export async function setThreadBindingMaxAgeBySessionKeyAsync(input: {
  targetSessionKey: string;
  accountId?: string;
  maxAgeMs: number;
}): Promise<ThreadBindingRecord[]> {
  const params = { ...input };
  const maxAgeMs = normalizeNonNegativeMs(params.maxAgeMs);
  return mutateBindingsForTargetSession(params, (existing, now) => ({
    ...existing,
    maxAgeMs,
    boundAt: now,
    lastActivityAt: now,
  }));
}

/** @deprecated Use the awaited lifecycle setter; retained for the generic SDK contract. */
export function setThreadBindingIdleTimeoutBySessionKey(
  params: Parameters<typeof setThreadBindingIdleTimeoutBySessionKeyAsync>[0],
): ThreadBindingRecord[] {
  const ids = resolveBindingIdsForTargetSession(params);
  const idleTimeoutMs = normalizeNonNegativeMs(params.idleTimeoutMs);
  return updateBindingsForTargetSessionSync(ids, (existing, now) => ({
    ...existing,
    idleTimeoutMs,
    lastActivityAt: now,
  }));
}

/** @deprecated Use the awaited lifecycle setter; retained for the generic SDK contract. */
export function setThreadBindingMaxAgeBySessionKey(
  params: Parameters<typeof setThreadBindingMaxAgeBySessionKeyAsync>[0],
): ThreadBindingRecord[] {
  const ids = resolveBindingIdsForTargetSession(params);
  const maxAgeMs = normalizeNonNegativeMs(params.maxAgeMs);
  return updateBindingsForTargetSessionSync(ids, (existing, now) => ({
    ...existing,
    maxAgeMs,
    boundAt: now,
    lastActivityAt: now,
  }));
}
