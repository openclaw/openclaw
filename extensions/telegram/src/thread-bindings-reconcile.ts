import { readAcpSessionEntry } from "openclaw/plugin-sdk/acp-runtime";
import { isAcpSessionKey } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { persistBindingMutation } from "./thread-bindings-persistence.js";
import { resolveBindingKey } from "./thread-bindings-session.js";
import { getThreadBindingsState, listBindingsForAccount } from "./thread-bindings-state.js";

export async function reconcileTelegramAcpBindingsOnStartup(params: {
  accountId: string;
  persist: boolean;
}): Promise<void> {
  const { accountId, persist } = params;
  const acpSessionKeys = new Set<string>();
  for (const binding of getThreadBindingsState().bindingsByAccountConversation.values()) {
    if (binding.targetKind !== "acp" || !isAcpSessionKey(binding.targetSessionKey)) {
      continue;
    }
    acpSessionKeys.add(binding.targetSessionKey);
  }

  const staleSessionKeys = new Set<string>();
  for (const targetSessionKey of acpSessionKeys) {
    const sessionEntry = readAcpSessionEntry({ sessionKey: targetSessionKey });
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
      getThreadBindingsState().bindingsByAccountConversation.delete(
        resolveBindingKey({ accountId, conversationId: binding.conversationId }),
      );
      await persistBindingMutation({
        accountId,
        persist,
        binding,
        remove: true,
        reason: "cleanup-stale",
      });
    }
    if (bindingsToRemove.length > 0) {
      logVerbose(
        `telegram thread binding: cleaned up ${bindingsToRemove.length} stale binding(s) for session ${sessionKey}`,
      );
    }
  }
}
