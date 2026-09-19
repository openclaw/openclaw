// Telegram test support resets the intentionally cross-loader thread-binding registry.
type ThreadBindingsTestState = {
  managersByAccountId: Map<string, { stop(): void }>;
  bindingsByAccountConversation: Map<string, unknown>;
  restoredAccounts?: Set<string>;
  restoringAccounts?: Map<string, Promise<void>>;
};

const TELEGRAM_THREAD_BINDINGS_STATE_KEY = Symbol.for("openclaw.telegramThreadBindingsState");

export function resetTelegramThreadBindingsForTests() {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const state = globalStore[TELEGRAM_THREAD_BINDINGS_STATE_KEY] as
    | ThreadBindingsTestState
    | undefined;
  if (!state) {
    return;
  }
  for (const manager of state.managersByAccountId.values()) {
    manager.stop();
  }
  state.managersByAccountId.clear();
  state.bindingsByAccountConversation.clear();
  state.restoredAccounts?.clear();
  state.restoringAccounts?.clear();
}
