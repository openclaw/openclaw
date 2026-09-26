import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getTelegramRuntime } from "./runtime.js";
import {
  resolveStoredBindingKey,
  sanitizeStoredBinding,
  TELEGRAM_THREAD_BINDINGS_NAMESPACE,
  TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
  type TelegramThreadBindingRecord,
} from "./thread-bindings-store.js";

type TelegramThreadBindingStore = PluginStateKeyedStore<TelegramThreadBindingRecord>;

function openThreadBindingStore(): TelegramThreadBindingStore {
  return getTelegramRuntime().state.openKeyedStore<TelegramThreadBindingRecord>({
    namespace: TELEGRAM_THREAD_BINDINGS_NAMESPACE,
    maxEntries: TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
  });
}

export async function loadBindingsFromStore(
  accountId: string,
): Promise<TelegramThreadBindingRecord[]> {
  let store: TelegramThreadBindingStore;
  try {
    store = openThreadBindingStore();
  } catch (err) {
    logVerbose(`telegram thread bindings store open failed (${accountId}): ${String(err)}`);
    return [];
  }
  let entries: Array<{ key: string; value: TelegramThreadBindingRecord }>;
  try {
    entries = await store.entries();
  } catch (err) {
    logVerbose(`telegram thread bindings store read failed (${accountId}): ${String(err)}`);
    return [];
  }
  const bindings: TelegramThreadBindingRecord[] = [];
  for (const entry of entries) {
    if (entry.value.accountId !== accountId) {
      continue;
    }
    const sanitized = sanitizeStoredBinding(accountId, entry.value);
    if (sanitized) {
      bindings.push(sanitized);
      continue;
    }
    try {
      await store.delete(entry.key);
    } catch (err) {
      logVerbose(
        `telegram thread bindings invalid row cleanup failed (${accountId}): ${String(err)}`,
      );
    }
  }
  return bindings;
}

export async function persistBindingMutation(params: {
  accountId: string;
  persist: boolean;
  binding: TelegramThreadBindingRecord;
  remove?: boolean;
  reason: string;
  throwOnError?: boolean;
  assertCurrent?: () => void;
}): Promise<boolean> {
  if (!params.persist) {
    return false;
  }
  try {
    const store = openThreadBindingStore();
    const key = resolveStoredBindingKey(params.binding);
    if (params.remove) {
      await store.delete(key, { assertCurrent: params.assertCurrent });
      return true;
    }
    const stored = sanitizeStoredBinding(params.accountId, params.binding);
    if (stored) {
      await store.register(key, stored, { assertCurrent: params.assertCurrent });
      return true;
    }
  } catch (err) {
    params.assertCurrent?.();
    if (params.throwOnError) {
      throw err;
    }
    logVerbose(
      `telegram thread bindings persist failed (${params.accountId}, ${params.reason}): ${String(err)}`,
    );
  }
  return false;
}

/** Native compatibility for the published synchronous SDK, retained until its next major. */
export function updateStoredBindingSync(params: {
  binding: TelegramThreadBindingRecord;
  persist: boolean;
  pendingValueJson?: string | null;
  update: (current: TelegramThreadBindingRecord) => TelegramThreadBindingRecord | undefined;
}): TelegramThreadBindingRecord | null | undefined {
  const fallback = () => params.update(params.binding) ?? params.binding;
  if (!params.persist) {
    return fallback();
  }
  let observed: TelegramThreadBindingRecord | null | undefined;
  try {
    const store = getTelegramRuntime().state.openSyncKeyedStore<TelegramThreadBindingRecord>({
      namespace: TELEGRAM_THREAD_BINDINGS_NAMESPACE,
      maxEntries: TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
    });
    if (!store.update) {
      throw new Error("Synchronous binding compatibility requires atomic plugin-state updates");
    }
    let next: TelegramThreadBindingRecord | null = null;
    store.update(resolveStoredBindingKey(params.binding), (current) => {
      const canonical = current ? sanitizeStoredBinding(params.binding.accountId, current) : null;
      // Only this owner's in-flight value can supersede newer memory-only facts here.
      observed =
        params.pendingValueJson === null && !canonical
          ? null
          : canonical && JSON.stringify(canonical) === params.pendingValueJson
            ? canonical
            : params.binding;
      if (!observed) {
        return undefined;
      }
      const updated = params.update(observed);
      next = updated ? sanitizeStoredBinding(params.binding.accountId, updated) : observed;
      return updated ? (next ?? undefined) : undefined;
    });
    return next;
  } catch (err) {
    logVerbose(
      `telegram thread bindings compatibility persist failed (${params.binding.accountId}): ${String(err)}`,
    );
    if (observed !== undefined) {
      return observed ? (params.update(observed) ?? observed) : null;
    }
    // Without a canonical read, do not pin old routing over an unacknowledged commit.
    return params.pendingValueJson === undefined ? fallback() : undefined;
  }
}
