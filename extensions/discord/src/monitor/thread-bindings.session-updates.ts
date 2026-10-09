import { resolveNonNegativeIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import {
  resolveBindingIdsForTargetSession,
  mutateBindingsForTargetSession,
  updateBindingsForTargetSessionSync,
} from "./thread-bindings.session-shared.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

function createDurationUpdate(field: "idleTimeoutMs" | "maxAgeMs", raw: number) {
  const duration = resolveNonNegativeIntegerOption(raw, 0);
  return (existing: ThreadBindingRecord, now: number): ThreadBindingRecord => ({
    ...existing,
    [field]: duration,
    ...(field === "maxAgeMs" ? { boundAt: now } : {}),
    lastActivityAt: now,
  });
}

export async function setThreadBindingIdleTimeoutBySessionKeyAsync(input: {
  targetSessionKey: string;
  accountId?: string;
  idleTimeoutMs: number;
}): Promise<ThreadBindingRecord[]> {
  const params = { ...input };
  return mutateBindingsForTargetSession(
    params,
    createDurationUpdate("idleTimeoutMs", params.idleTimeoutMs),
  );
}

export async function setThreadBindingMaxAgeBySessionKeyAsync(input: {
  targetSessionKey: string;
  accountId?: string;
  maxAgeMs: number;
}): Promise<ThreadBindingRecord[]> {
  const params = { ...input };
  return mutateBindingsForTargetSession(params, createDurationUpdate("maxAgeMs", params.maxAgeMs));
}

/** @deprecated Use the awaited lifecycle setter; retained for the generic SDK contract. */
export function setThreadBindingIdleTimeoutBySessionKey(
  params: Parameters<typeof setThreadBindingIdleTimeoutBySessionKeyAsync>[0],
): ThreadBindingRecord[] {
  const ids = resolveBindingIdsForTargetSession(params);
  return updateBindingsForTargetSessionSync(
    ids,
    createDurationUpdate("idleTimeoutMs", params.idleTimeoutMs),
  );
}

/** @deprecated Use the awaited lifecycle setter; retained for the generic SDK contract. */
export function setThreadBindingMaxAgeBySessionKey(
  params: Parameters<typeof setThreadBindingMaxAgeBySessionKeyAsync>[0],
): ThreadBindingRecord[] {
  const ids = resolveBindingIdsForTargetSession(params);
  return updateBindingsForTargetSessionSync(ids, createDurationUpdate("maxAgeMs", params.maxAgeMs));
}
