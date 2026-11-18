import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramRuntime } from "./runtime.types.js";
import {
  resolveStoredBindingKey,
  sanitizeStoredBinding,
  TELEGRAM_THREAD_BINDINGS_NAMESPACE,
  TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
  type TelegramThreadBindingRecord,
} from "./thread-bindings-store.js";

type TelegramThreadBindingStore = PluginStateKeyedStore<TelegramThreadBindingRecord, 2>;

function openThreadBindingStore(runtime: TelegramRuntime): TelegramThreadBindingStore {
  return runtime.state.openKeyedStoreV2<TelegramThreadBindingRecord>({
    namespace: TELEGRAM_THREAD_BINDINGS_NAMESPACE,
    maxEntries: TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
  });
}

export async function loadBindingsFromStore(
  runtime: TelegramRuntime,
  accountId: string,
): Promise<TelegramThreadBindingRecord[]> {
  let operation = "open";
  let store: TelegramThreadBindingStore;
  let entries: Array<{ key: string; value: TelegramThreadBindingRecord }>;
  try {
    store = openThreadBindingStore(runtime);
    operation = "read";
    entries = await store.entries();
  } catch (err) {
    logVerbose(`telegram thread bindings store ${operation} failed (${accountId}): ${String(err)}`);
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
  runtime: TelegramRuntime;
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
    const store = openThreadBindingStore(params.runtime);
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

/** Native compatibility for the published synchronous SDK, retained during stable deprecation. */
export function updateStoredBindingSync(params: {
  runtime: TelegramRuntime;
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
    const store = params.runtime.state.openSyncKeyedStore<TelegramThreadBindingRecord>({
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
