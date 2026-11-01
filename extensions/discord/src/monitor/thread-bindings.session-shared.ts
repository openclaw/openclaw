import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  commitBindingRecord,
  updateBindingRecordSync,
  runThreadBindingAccountOperation,
  runThreadBindingMutation,
  shouldPersistBindingMutations,
} from "./thread-bindings.persistence.js";
import {
  BINDINGS_BY_THREAD_ID,
  ensureBindingsLoadedAsync,
  resolveBindingIdsForSession,
  MANAGERS_BY_ACCOUNT_ID,
} from "./thread-bindings.state.js";
import type {
  ThreadBindingManager,
  ThreadBindingRecord,
  ThreadBindingTargetKind,
} from "./thread-bindings.types.js";

export function resolveBindingIdsForTargetSession(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
}) {
  return resolveBindingIdsForSession({
    ...params,
    accountId: params.accountId ? normalizeAccountId(params.accountId) : undefined,
  });
}

export function mutateBindingsForTargetSession(
  params: Parameters<typeof resolveBindingIdsForTargetSession>[0],
  update: (existing: ThreadBindingRecord, now: number) => ThreadBindingRecord | null,
  onRemoved?: (record: ThreadBindingRecord, manager: ThreadBindingManager | undefined) => void,
): Promise<ThreadBindingRecord[]> {
  const accountId = params.accountId ? normalizeAccountId(params.accountId) : undefined;
  const managers: ThreadBindingManager[] = [];
  const stoppingAtAdmission = new Map<string, boolean>();
  for (const [ownerAccountId, manager] of MANAGERS_BY_ACCOUNT_ID) {
    if (accountId === undefined || ownerAccountId === accountId) {
      managers.push(manager);
      stoppingAtAdmission.set(ownerAccountId, manager.isStopping());
    }
  }
  // Include pending binds whose target rows do not exist until their account work settles.
  return runThreadBindingAccountOperation(managers, () =>
    runThreadBindingMutation(async () => {
      await ensureBindingsLoadedAsync();
      const ids = resolveBindingIdsForTargetSession(params);
      for (const bindingKey of ids) {
        const existing = BINDINGS_BY_THREAD_ID.get(bindingKey);
        if (!existing) {
          continue;
        }
        const manager = MANAGERS_BY_ACCOUNT_ID.get(existing.accountId);
        // Shutdown drains admitted work; only newly discovered owners use their current state.
        if (stoppingAtAdmission.get(existing.accountId) ?? manager?.isStopping()) {
          throw new Error("Discord thread binding manager is stopping");
        }
      }
      const now = Date.now();
      const updated: ThreadBindingRecord[] = [];
      for (const bindingKey of ids) {
        const existing = BINDINGS_BY_THREAD_ID.get(bindingKey);
        if (!existing) {
          continue;
        }
        const manager = MANAGERS_BY_ACCOUNT_ID.get(existing.accountId);
        const nextRecord = update(existing, now);
        await commitBindingRecord({
          bindingKey,
          previous: existing,
          next: nextRecord,
          persist: shouldPersistBindingMutations(),
        });
        if (!nextRecord) {
          onRemoved?.(existing, manager);
        }
        updated.push(nextRecord ?? existing);
      }
      return updated;
    }),
  );
}

/** @deprecated Generic SDK synchronous lifecycle compatibility. */
export function updateBindingsForTargetSessionSync(
  ids: string[],
  update: (existing: ThreadBindingRecord, now: number) => ThreadBindingRecord,
): ThreadBindingRecord[] {
  const now = Date.now();
  const updated: ThreadBindingRecord[] = [];
  for (const bindingKey of ids) {
    const existing = BINDINGS_BY_THREAD_ID.get(bindingKey);
    if (!existing) {
      continue;
    }
    if (MANAGERS_BY_ACCOUNT_ID.get(existing.accountId)?.isStopping()) {
      throw new Error("Discord thread binding manager is stopping");
    }
    const next = updateBindingRecordSync({
      bindingKey,
      transform: (record) =>
        record.targetSessionKey === existing.targetSessionKey ? update(record, now) : record,
      persist: shouldPersistBindingMutations(),
    });
    if (next?.targetSessionKey === existing.targetSessionKey) {
      updated.push(next);
    }
  }
  return updated;
}
