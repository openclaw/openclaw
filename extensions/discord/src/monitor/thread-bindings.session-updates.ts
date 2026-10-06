import { resolveNonNegativeIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import {
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
  const idleTimeoutMs = resolveNonNegativeIntegerOption(params.idleTimeoutMs, 0);
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
  const maxAgeMs = resolveNonNegativeIntegerOption(params.maxAgeMs, 0);
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
  const idleTimeoutMs = resolveNonNegativeIntegerOption(params.idleTimeoutMs, 0);
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
  const maxAgeMs = resolveNonNegativeIntegerOption(params.maxAgeMs, 0);
  return updateBindingsForTargetSessionSync(ids, (existing, now) => ({
    ...existing,
    maxAgeMs,
    boundAt: now,
    lastActivityAt: now,
  }));
}
