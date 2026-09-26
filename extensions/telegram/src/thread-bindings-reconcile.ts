import * as acpRuntime from "openclaw/plugin-sdk/acp-runtime";
import { isAcpSessionKey } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { persistBindingMutation } from "./thread-bindings-persistence.js";
import { resolveBindingKey } from "./thread-bindings-session.js";
import { getThreadBindingsState } from "./thread-bindings-state.js";
import type { TelegramThreadBindingRecord } from "./thread-bindings-store.js";

export async function reconcileTelegramAcpBindingsOnStartup(params: {
  accountId: string;
  persist: boolean;
  startupBindings: readonly TelegramThreadBindingRecord[];
}): Promise<void> {
  const { accountId, persist, startupBindings } = params;
  const acpSessionKeys = new Set<string>();
  for (const binding of startupBindings) {
    if (binding.targetKind !== "acp" || !isAcpSessionKey(binding.targetSessionKey)) {
      continue;
    }
    acpSessionKeys.add(binding.targetSessionKey);
  }

  const staleSessionKeys = new Set<string>();
  const readAcpSessionEntryAsync = acpRuntime.readAcpSessionEntryAsync;
  for (const targetSessionKey of acpSessionKeys) {
    if (typeof readAcpSessionEntryAsync !== "function") {
      throw new Error(
        "ACP thread binding reconciliation requires asynchronous metadata reads. Upgrade the OpenClaw host.",
      );
    }
    const sessionEntry = await readAcpSessionEntryAsync({ sessionKey: targetSessionKey });
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
    const bindingsToRemove = startupBindings.filter((b) => b.targetSessionKey === sessionKey);
    for (const binding of bindingsToRemove) {
      const bindingKey = resolveBindingKey({ accountId, conversationId: binding.conversationId });
      if (getThreadBindingsState().bindingsByAccountConversation.get(bindingKey) !== binding) {
        continue;
      }
      getThreadBindingsState().bindingsByAccountConversation.delete(bindingKey);
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
