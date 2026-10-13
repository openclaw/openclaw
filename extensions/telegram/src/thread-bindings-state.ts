import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import type { StoreWriterQueue } from "openclaw/plugin-sdk/sqlite-runtime";
import { persistBindingMutation } from "./thread-bindings-persistence.js";
import { resolveBindingKey } from "./thread-bindings-session.js";
import { sanitizeStoredBinding } from "./thread-bindings-store.js";
import type {
  TelegramThreadBindingManager,
  TelegramThreadBindingRecord,
} from "./thread-bindings-store.js";

type PendingBindingMutation = { preparedValueJson?: string | null };

type TelegramThreadBindingsState = {
  managersByAccountId: Map<string, TelegramThreadBindingManager>;
  queues: Map<string, StoreWriterQueue>;
  pendingMutations: WeakMap<TelegramThreadBindingManager, Map<string, PendingBindingMutation>>;
  bindingsByAccountConversation: Map<string, TelegramThreadBindingRecord>;
};

// Source plugin reloads can retain the registry created before queued mutations existed.
type TelegramThreadBindingsReloadState = Pick<
  TelegramThreadBindingsState,
  "managersByAccountId" | "bindingsByAccountConversation"
> &
  Partial<Pick<TelegramThreadBindingsState, "queues" | "pendingMutations">>;

/**
 * Keep Telegram thread binding state shared across bundled chunks so routing,
 * binding lookups, and binding mutations all observe the same live registry.
 */
const TELEGRAM_THREAD_BINDINGS_STATE_KEY = Symbol.for("openclaw.telegramThreadBindingsState");
let threadBindingsState: TelegramThreadBindingsState | undefined;

export function getThreadBindingsState(): TelegramThreadBindingsState {
  if (threadBindingsState) {
    return threadBindingsState;
  }
  const state = resolveGlobalSingleton<TelegramThreadBindingsReloadState>(
    TELEGRAM_THREAD_BINDINGS_STATE_KEY,
    () => ({
      managersByAccountId: new Map<string, TelegramThreadBindingManager>(),
      bindingsByAccountConversation: new Map<string, TelegramThreadBindingRecord>(),
    }),
  );
  return (threadBindingsState = Object.assign(state, {
    queues: state.queues ?? new Map<string, StoreWriterQueue>(),
    pendingMutations:
      state.pendingMutations ??
      new WeakMap<TelegramThreadBindingManager, Map<string, PendingBindingMutation>>(),
  }));
}

export function finishBindingMutationScope(manager: TelegramThreadBindingManager) {
  getThreadBindingsState().pendingMutations.delete(manager);
}

export function pendingBindingValue(manager: TelegramThreadBindingManager, conversationId: string) {
  return getThreadBindingsState().pendingMutations.get(manager)?.get(conversationId)
    ?.preparedValueJson;
}

export function listBindingsForAccount(accountId: string): TelegramThreadBindingRecord[] {
  return [...getThreadBindingsState().bindingsByAccountConversation.values()].filter(
    (entry) => entry.accountId === accountId,
  );
}

export function captureBindingMutation(
  manager: TelegramThreadBindingManager,
  conversationId: string,
) {
  const state = getThreadBindingsState();
  const key = resolveBindingKey({ accountId: manager.accountId, conversationId });
  const previous = state.bindingsByAccountConversation.get(key);
  const pending = state.pendingMutations.get(manager) ?? new Map<string, PendingBindingMutation>();
  const receipt: PendingBindingMutation = {};
  pending.set(conversationId, receipt);
  state.pendingMutations.set(manager, pending);
  const isCurrent = () =>
    state.managersByAccountId.get(manager.accountId) === manager &&
    state.bindingsByAccountConversation.get(key) === previous;
  const assertCurrent = () => {
    if (!isCurrent()) {
      throw new Error(
        `Telegram thread binding changed before persistence (${manager.accountId}:${conversationId})`,
      );
    }
  };
  return {
    previous,
    assertCurrent,
    prepare(record: TelegramThreadBindingRecord | null) {
      receipt.preparedValueJson = record
        ? JSON.stringify(sanitizeStoredBinding(manager.accountId, record))
        : null;
    },
    publish(record: TelegramThreadBindingRecord | null, committed: boolean) {
      try {
        if (!isCurrent()) {
          // A native compatibility mutation can follow COMMIT before its Promise continuation.
          if (!committed) {
            assertCurrent();
          }
          return;
        }
        if (record) {
          state.bindingsByAccountConversation.set(key, record);
        } else {
          state.bindingsByAccountConversation.delete(key);
        }
      } finally {
        pending.delete(conversationId);
      }
    },
    async commit(
      binding: TelegramThreadBindingRecord,
      options: { reason: string; remove?: boolean; throwOnError?: boolean },
    ) {
      const next = options.remove ? null : binding;
      this.prepare(next);
      const committed = await persistBindingMutation({
        ...options,
        accountId: manager.accountId,
        persist: manager.shouldPersistMutations(),
        binding,
        assertCurrent,
      });
      this.publish(next, committed);
    },
  };
}
