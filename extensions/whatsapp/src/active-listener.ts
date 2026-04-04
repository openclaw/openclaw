import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import type { PollInput } from "openclaw/plugin-sdk/media-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";

export type ActiveWebSendOptions = {
  gifPlayback?: boolean;
  accountId?: string;
  fileName?: string;
};

export type ActiveWebListener = {
  sendMessage: (
    to: string,
    text: string,
    mediaBuffer?: Buffer,
    mediaType?: string,
    options?: ActiveWebSendOptions,
  ) => Promise<{ messageId: string }>;
  sendPoll: (to: string, poll: PollInput) => Promise<{ messageId: string }>;
  sendReaction: (
    chatJid: string,
    messageId: string,
    emoji: string,
    fromMe: boolean,
    participant?: string,
  ) => Promise<void>;
  sendComposingTo: (to: string) => Promise<void>;
  addChatLabel: (chatJid: string, labelId: string) => Promise<void>;
  removeChatLabel: (chatJid: string, labelId: string) => Promise<void>;
  getLabels?: () => Promise<
    { id: string; name: string; color: number; deleted: boolean; predefinedId?: string }[]
  >;
  createLabel?: (
    name: string,
    color: number,
  ) => Promise<{ id: string; name: string; color: number } | undefined>;
  addLabel?: (
    jid: string,
    labels: { id: string; name?: string; color?: number; deleted?: boolean; predefinedId?: number },
  ) => Promise<void>;
  addMessageLabel?: (jid: string, messageId: string, labelId: string) => Promise<void>;
  removeMessageLabel?: (jid: string, messageId: string, labelId: string) => Promise<void>;
  onWhatsApp?: (
    ...phoneNumbers: string[]
  ) => Promise<{ jid: string; exists: boolean }[] | undefined>;
  getBusinessProfile?: (jid: string) => Promise<unknown>;
  fetchStatus?: (...jids: string[]) => Promise<unknown>;
  chatModify?: (mod: unknown, jid: string) => Promise<void>;
  fetchBlocklist?: () => Promise<(string | undefined)[]>;
  profilePictureUrl?: (
    jid: string,
    type?: "preview" | "image",
    timeoutMs?: number,
  ) => Promise<string | undefined>;
  groupMetadata?: (jid: string) => Promise<unknown>;
  readMessages?: (keys: unknown[]) => Promise<void>;
  star?: (
    jid: string,
    messages: { id: string; fromMe?: boolean }[],
    star: boolean,
  ) => Promise<void>;
  fetchMessageHistory?: (
    count: number,
    oldestMsgKey: { remoteJid: string; fromMe: boolean; id: string },
    oldestMsgTimestamp: number,
  ) => Promise<string>;
  close?: () => Promise<void>;
};

// Raw message subscribers — plugins can register to receive every WAMessage
type RawMessageCallback = (accountId: string, msg: unknown) => void;
const rawMessageSubscribers = new Set<RawMessageCallback>();

export function onRawWhatsAppMessage(cb: RawMessageCallback): () => void {
  rawMessageSubscribers.add(cb);
  return () => rawMessageSubscribers.delete(cb);
}

export function emitRawWhatsAppMessage(accountId: string, msg: unknown): void {
  for (const cb of rawMessageSubscribers) {
    try {
      cb(accountId, msg);
    } catch (err) {
      console.error("[whatsapp] Raw message subscriber error:", err);
    }
  }
}

// WhatsApp shares a live Baileys socket between inbound and outbound runtime
// chunks. Keep this on a direct globalThis symbol lookup; the generic
// singleton helper was previously inlined during code-splitting and split the
// listener state back into per-chunk Maps.
const WHATSAPP_ACTIVE_LISTENER_STATE_KEY = Symbol.for("openclaw.whatsapp.activeListenerState");

type ActiveListenerState = {
  listeners: Map<string, ActiveWebListener>;
  current: ActiveWebListener | null;
};

const g = globalThis as unknown as Record<symbol, ActiveListenerState | undefined>;
if (!g[WHATSAPP_ACTIVE_LISTENER_STATE_KEY]) {
  g[WHATSAPP_ACTIVE_LISTENER_STATE_KEY] = {
    listeners: new Map<string, ActiveWebListener>(),
    current: null,
  };
}
const state = g[WHATSAPP_ACTIVE_LISTENER_STATE_KEY]!;

function setCurrentListener(listener: ActiveWebListener | null): void {
  state.current = listener;
}

export function resolveWebAccountId(accountId?: string | null): string {
  return (accountId ?? "").trim() || DEFAULT_ACCOUNT_ID;
}

export function requireActiveWebListener(accountId?: string | null): {
  accountId: string;
  listener: ActiveWebListener;
} {
  const id = resolveWebAccountId(accountId);
  const listener = state.listeners.get(id) ?? null;
  if (!listener) {
    throw new Error(
      `No active WhatsApp Web listener (account: ${id}). Start the gateway, then link WhatsApp with: ${formatCliCommand(`openclaw channels login --channel whatsapp --account ${id}`)}.`,
    );
  }
  return { accountId: id, listener };
}

export function setActiveWebListener(listener: ActiveWebListener | null): void;
export function setActiveWebListener(
  accountId: string | null | undefined,
  listener: ActiveWebListener | null,
): void;
export function setActiveWebListener(
  accountIdOrListener: string | ActiveWebListener | null | undefined,
  maybeListener?: ActiveWebListener | null,
): void {
  const { accountId, listener } =
    typeof accountIdOrListener === "string"
      ? { accountId: accountIdOrListener, listener: maybeListener ?? null }
      : {
          accountId: DEFAULT_ACCOUNT_ID,
          listener: accountIdOrListener ?? null,
        };

  const id = resolveWebAccountId(accountId);
  if (!listener) {
    state.listeners.delete(id);
  } else {
    state.listeners.set(id, listener);
  }
  if (id === DEFAULT_ACCOUNT_ID) {
    setCurrentListener(listener);
  }
}

export function getActiveWebListener(accountId?: string | null): ActiveWebListener | null {
  const id = resolveWebAccountId(accountId);
  return state.listeners.get(id) ?? null;
}
