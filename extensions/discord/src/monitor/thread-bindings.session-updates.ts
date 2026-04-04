import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  BINDINGS_BY_THREAD_ID,
  ensureBindingsLoaded,
  resolveBindingIdsForSession,
  saveBindingsToDisk,
  setBindingRecord,
  shouldPersistBindingMutations,
} from "./thread-bindings.state.js";
import type { ThreadBindingRecord, ThreadBindingTargetKind } from "./thread-bindings.types.js";

function normalizeNonNegativeMs(raw: number): number {
  if (!Number.isFinite(raw)) {
    return 0;
  }
  return Math.max(0, Math.floor(raw));
}

function resolveBindingIdsForTargetSession(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
}) {
  ensureBindingsLoaded();
  const targetSessionKey = params.targetSessionKey.trim();
  if (!targetSessionKey) {
    return [];
  }
  const accountId = params.accountId ? normalizeAccountId(params.accountId) : undefined;
  return resolveBindingIdsForSession({
    targetSessionKey,
    accountId,
    targetKind: params.targetKind,
  });
}

function updateBindingsForTargetSession(
  ids: string[],
  update: (existing: ThreadBindingRecord, now: number) => ThreadBindingRecord,
) {
  if (ids.length === 0) {
    return [];
  }
  const now = Date.now();
  const updated: ThreadBindingRecord[] = [];
  for (const bindingKey of ids) {
    const existing = BINDINGS_BY_THREAD_ID.get(bindingKey);
    if (!existing) {
      continue;
    }
    const nextRecord = update(existing, now);
    setBindingRecord(nextRecord);
    updated.push(nextRecord);
  }
  if (updated.length > 0 && shouldPersistBindingMutations()) {
    saveBindingsToDisk({ force: true });
  }
  return updated;
}

export function setThreadBindingIdleTimeoutBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  idleTimeoutMs: number;
}): ThreadBindingRecord[] {
  const ids = resolveBindingIdsForTargetSession(params);
  const idleTimeoutMs = normalizeNonNegativeMs(params.idleTimeoutMs);
  return updateBindingsForTargetSession(ids, (existing, now) => ({
    ...existing,
    idleTimeoutMs,
    lastActivityAt: now,
  }));
}

export function setThreadBindingMaxAgeBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  maxAgeMs: number;
}): ThreadBindingRecord[] {
  const ids = resolveBindingIdsForTargetSession(params);
  const maxAgeMs = normalizeNonNegativeMs(params.maxAgeMs);
  return updateBindingsForTargetSession(ids, (existing, now) => ({
    ...existing,
    maxAgeMs,
    boundAt: now,
    lastActivityAt: now,
  }));
}
