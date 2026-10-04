import {
  readAcpSessionEntry,
  type AcpSessionEntryPreparer,
  type PreparedAcpSessionEntryRead,
} from "openclaw/plugin-sdk/acp-runtime";
import { isAcpSessionKey } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { persistBindingMutation } from "./thread-bindings-persistence.js";
import { resolveBindingKey } from "./thread-bindings-session.js";
import { getThreadBindingsState, listBindingsForAccount } from "./thread-bindings-state.js";

type TelegramAcpBindingReconciliationParams = {
  accountId: string;
  persist: boolean;
  prepareSession?: AcpSessionEntryPreparer;
};

export async function reconcileTelegramAcpBindingsOnStartup(
  params: TelegramAcpBindingReconciliationParams,
): Promise<void> {
  const preparations = new Map<string, PreparedAcpSessionEntryRead>();
  try {
    await reconcileTelegramAcpBindings(params, preparations);
  } finally {
    preparations.forEach((prepared) => prepared.release());
  }
}

async function reconcileTelegramAcpBindings(
  params: TelegramAcpBindingReconciliationParams,
  preparations: Map<string, PreparedAcpSessionEntryRead>,
): Promise<void> {
  const { accountId, persist } = params;
  const acpSessionKeys = new Set<string>();
  for (const binding of getThreadBindingsState().bindingsByAccountConversation.values()) {
    if (binding.targetKind !== "acp") {
      continue;
    }
    acpSessionKeys.add(binding.targetSessionKey);
  }

  const staleSessionKeys = new Set<string>();
  for (const targetSessionKey of acpSessionKeys) {
    const input = { sessionKey: targetSessionKey };
    const preparation = params.prepareSession?.(input);
    if (!preparation && !isAcpSessionKey(targetSessionKey)) {
      continue;
    }
    const prepared = preparation ? await preparation : undefined;
    if (prepared) {
      preparations.set(targetSessionKey, prepared);
      prepared.assertCurrent();
    }
    const sessionEntry = prepared ? prepared.session : readAcpSessionEntry(input);
    if (!sessionEntry || sessionEntry.storeReadFailed) {
      continue;
    }
    const isStale =
      !sessionEntry.entry ||
      sessionEntry.entry.status === "failed" ||
      sessionEntry.entry.status === "killed" ||
      sessionEntry.entry.status === "timeout" ||
      sessionEntry.acp?.state === "error";
    if (isStale) {
      staleSessionKeys.add(targetSessionKey);
    }
  }

  for (const sessionKey of staleSessionKeys) {
    const bindingsToRemove = listBindingsForAccount(accountId).filter(
      (b) => b.targetSessionKey === sessionKey,
    );
    for (const binding of bindingsToRemove) {
      const key = resolveBindingKey({ accountId, conversationId: binding.conversationId });
      const prepared = preparations.get(sessionKey);
      const assertCurrent = () => {
        prepared?.assertCurrent();
        if (getThreadBindingsState().bindingsByAccountConversation.get(key) !== binding) {
          throw new Error("Telegram binding changed before startup cleanup");
        }
      };
      assertCurrent();
      await persistBindingMutation({
        accountId,
        persist,
        binding,
        remove: true,
        reason: "cleanup-stale",
        ...(prepared ? { assertCurrent, throwOnError: true } : {}),
      });
      if (getThreadBindingsState().bindingsByAccountConversation.get(key) === binding) {
        getThreadBindingsState().bindingsByAccountConversation.delete(key);
      }
    }
    if (bindingsToRemove.length > 0) {
      logVerbose(
        `telegram thread binding: cleaned up ${bindingsToRemove.length} stale binding(s) for session ${sessionKey}`,
      );
    }
  }
}
