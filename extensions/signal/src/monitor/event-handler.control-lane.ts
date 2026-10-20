import type { ChannelInboundMediaInput } from "openclaw/plugin-sdk/channel-inbound";
import type {
  ChannelIngressContextBinding,
  ResolvedChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  listChatCommands,
  maybeResolveTextAlias,
  normalizeCommandBody,
} from "openclaw/plugin-sdk/command-auth-native";
import { isAbortRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SignalIngressLifecycle } from "../signal-ingress.js";

export type SignalInboundEntry = {
  /** Admission and buffered dispatch share this receipt-time snapshot. */
  cfg: OpenClawConfig;
  senderName: string;
  senderDisplay: string;
  senderRecipient: string;
  senderPeerId: string;
  groupId?: string;
  groupName?: string;
  isGroup: boolean;
  bodyText: string;
  nativeReplyBody?: string;
  commandBody: string;
  timestamp?: number;
  messageId?: string;
  replyToId?: string;
  isBatched?: boolean;
  media?: ChannelInboundMediaInput[];
  commandAuthorized: boolean;
  canDetectMention?: boolean;
  wasMentioned?: boolean;
  replyToBody?: string;
  replyToSender?: string;
  replyToIsQuote?: boolean;
  turnAdoptionLifecycle?: SignalIngressLifecycle;
  channelIngress?: readonly ResolvedChannelMessageIngress[];
  resolveChannelIngress?: (
    contextBinding: ChannelIngressContextBinding,
  ) => Promise<ResolvedChannelMessageIngress>;
};

type TrackedSignalInboundLane = {
  conversationKey: string;
  inboundKey: string;
};

const SIGNAL_ACTIVE_RUN_CONTROL_COMMAND_KEYS = new Set([
  "approve",
  "commands",
  "context",
  "help",
  "status",
  "steer",
  "tasks",
  "tools",
  "whoami",
]);

function resolveSignalConversationId(entry: SignalInboundEntry): string | null {
  const conversationId = entry.isGroup ? entry.groupId : entry.senderPeerId;
  return conversationId?.trim() || null;
}

export function resolveSignalInboundDebounceKey(
  accountId: string,
  entry: SignalInboundEntry,
): string | null {
  const conversationId = resolveSignalConversationId(entry);
  if (!conversationId || !entry.senderPeerId) {
    return null;
  }
  return `signal:${accountId}:${conversationId}:${entry.senderPeerId}`;
}

function resolveSignalInboundConversationKey(
  accountId: string,
  entry: SignalInboundEntry,
): string | null {
  const conversationId = resolveSignalConversationId(entry);
  return conversationId ? `signal:${accountId}:${conversationId}` : null;
}

function isSignalActiveRunControlText(text: string): boolean {
  if (isAbortRequestText(text)) {
    return true;
  }
  const normalizedBody = normalizeCommandBody(text);
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

export function resolveSignalControlLaneKey(
  accountId: string,
  entry: SignalInboundEntry,
): string | null {
  if (!entry.commandAuthorized || !isSignalActiveRunControlText(entry.commandBody)) {
    return null;
  }
  const conversationId = resolveSignalConversationId(entry);
  return conversationId ? `signal:${accountId}:${conversationId}:control` : null;
}

export function createSignalPendingInboundRegistry(accountId: string) {
  const trackedEntries = new Map<SignalInboundEntry, TrackedSignalInboundLane>();

  const track = (entry: SignalInboundEntry) => {
    const conversationKey = resolveSignalInboundConversationKey(accountId, entry);
    const inboundKey = resolveSignalInboundDebounceKey(accountId, entry);
    if (!conversationKey || !inboundKey) {
      return;
    }
    trackedEntries.set(entry, { conversationKey, inboundKey });
  };

  const complete = (entries: SignalInboundEntry[]) => {
    for (const entry of entries) {
      trackedEntries.delete(entry);
    }
  };

  const cancelPendingOnAbort = (entry: SignalInboundEntry, cancelKey: (key: string) => boolean) => {
    if (!entry.commandAuthorized || !isAbortRequestText(entry.commandBody)) {
      return;
    }
    const conversationKey = resolveSignalInboundConversationKey(accountId, entry);
    if (!conversationKey) {
      return;
    }
    // Group members have distinct normal debounce keys, but stop applies to the shared session.
    // Cancel every still-tracked sender lane before core interrupts the active run.
    const inboundKeys = new Set<string>();
    for (const tracked of trackedEntries.values()) {
      if (tracked.conversationKey === conversationKey) {
        inboundKeys.add(tracked.inboundKey);
      }
    }
    for (const inboundKey of inboundKeys) {
      cancelKey(inboundKey);
    }
  };

  return { track, complete, cancelPendingOnAbort };
}
