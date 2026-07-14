// Signal plugin helpers isolate active-run control scheduling from the inbound handler.
import {
  listChatCommands,
  maybeResolveTextAlias,
  normalizeCommandBody,
} from "openclaw/plugin-sdk/command-auth-native";
import { isAbortRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";

type SignalInboundControlEntry = {
  senderPeerId: string;
  groupId?: string;
  isGroup: boolean;
  commandBody: string;
  commandAuthorized: boolean;
};

const SIGNAL_ACTIVE_RUN_CONTROL_COMMAND_KEYS = new Set([
  "commands",
  "context",
  "help",
  "status",
  "steer",
  "tasks",
  "tools",
  "whoami",
]);

function resolveSignalConversationDebounceKey(
  accountId: string,
  entry: SignalInboundControlEntry,
): string | null {
  const conversationId = entry.isGroup ? (entry.groupId ?? "unknown") : entry.senderPeerId;
  if (!conversationId || !entry.senderPeerId) {
    return null;
  }
  return `signal:${accountId}:${conversationId}:${entry.senderPeerId}`;
}

function isSignalActiveRunControlText(text: string): boolean {
  if (isAbortRequestText(text)) {
    return true;
  }
  const normalizedBody = normalizeCommandBody(text.trim());
  const alias = maybeResolveTextAlias(normalizedBody);
  if (!alias) {
    return false;
  }
  const command = listChatCommands().find((entry) =>
    entry.textAliases.some((candidate) => candidate.trim().toLowerCase() === alias),
  );
  if (command?.key === "queue") {
    // Bare `/queue` only reads current settings. Every argument form can mutate them.
    return normalizedBody.slice(alias.length).trim() === "";
  }
  return command ? SIGNAL_ACTIVE_RUN_CONTROL_COMMAND_KEYS.has(command.key) : false;
}

export function resolveSignalInboundDebounceKey(
  accountId: string,
  entry: SignalInboundControlEntry,
): string | null {
  const conversationKey = resolveSignalConversationDebounceKey(accountId, entry);
  // Active-run-safe controls overtake the conversation run, but remain ordered with each other.
  // Stateful commands keep the normal key so they cannot race session mutations against a run.
  return conversationKey &&
    entry.commandAuthorized &&
    isSignalActiveRunControlText(entry.commandBody)
    ? `${conversationKey}:control`
    : conversationKey;
}

export function cancelPendingSignalInboundOnAbort(
  accountId: string,
  entry: SignalInboundControlEntry,
  cancelKey: (key: string) => boolean,
): void {
  if (!entry.commandAuthorized || !isAbortRequestText(entry.commandBody)) {
    return;
  }
  const conversationKey = resolveSignalConversationDebounceKey(accountId, entry);
  if (conversationKey) {
    // Active work is interrupted later by the reply layer; only undispatched text is removed here.
    cancelKey(conversationKey);
  }
}
