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
  ensureBindingsLoaded,
  ensureBindingsLoadedAsync,
  resolveBindingIdsForSession,
  MANAGERS_BY_ACCOUNT_ID,
} from "./thread-bindings.state.js";
import type {
  ThreadBindingManager,
  ThreadBindingRecord,
  ThreadBindingTargetKind,
} from "./thread-bindings.types.js";

export function normalizeNonNegativeMs(raw: number): number {
  if (!Number.isFinite(raw)) {
    return 0;
  }
  return Math.max(0, Math.floor(raw));
}

export function resolveBindingIdsForTargetSession(params: {
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

export function mutateBindingsForTargetSession(
  params: Parameters<typeof resolveBindingIdsForTargetSession>[0],
  update: (existing: ThreadBindingRecord, now: number) => ThreadBindingRecord | null,
  onRemoved?: (record: ThreadBindingRecord, manager: ThreadBindingManager | undefined) => void,
): Promise<ThreadBindingRecord[]> {
  const accountId = params.accountId ? normalizeAccountId(params.accountId) : undefined;
  const admittedOwners = new Map(
    [...MANAGERS_BY_ACCOUNT_ID]
      .filter(([ownerAccountId]) => accountId === undefined || ownerAccountId === accountId)
      .map(
        ([ownerAccountId, manager]) =>
          [ownerAccountId, { manager, stopping: manager.isStopping() }] as const,
      ),
  );
  // Include pending binds whose target rows do not exist until their account work settles.
  return runThreadBindingAccountOperation(
    [...admittedOwners.values()].map(({ manager }) => manager),
    () =>
      runThreadBindingMutation(async () => {
        await ensureBindingsLoadedAsync();
        const ids = resolveBindingIdsForTargetSession(params);
        const owners = new Map<string, ThreadBindingManager | undefined>();
        for (const bindingKey of ids) {
          const existing = BINDINGS_BY_THREAD_ID.get(bindingKey);
          if (!existing) {
            continue;
          }
          const manager = MANAGERS_BY_ACCOUNT_ID.get(existing.accountId);
          const admitted = admittedOwners.get(existing.accountId);
          if (admitted?.stopping || (!admitted && manager?.isStopping())) {
            throw new Error("Discord thread binding manager is stopping");
          }
          if (admitted?.manager !== manager) {
            throw new Error("Discord thread binding manager changed");
          }
          owners.set(existing.accountId, manager);
        }
        const now = Date.now();
        const updated: ThreadBindingRecord[] = [];
        for (const bindingKey of ids) {
          const existing = BINDINGS_BY_THREAD_ID.get(bindingKey);
          if (!existing) {
            continue;
          }
          const manager = owners.get(existing.accountId);
          const assertCurrent = () => {
            if (MANAGERS_BY_ACCOUNT_ID.get(existing.accountId) !== manager) {
              throw new Error("Discord thread binding manager changed");
            }
          };
          const nextRecord = update(existing, now);
          await commitBindingRecord({
            bindingKey,
            previous: existing,
            next: nextRecord,
            persist: shouldPersistBindingMutations(),
            assertCurrent,
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
