import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import type { PollInput } from "openclaw/plugin-sdk/media-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";

export type ActiveWebSendOptions = {
  gifPlayback?: boolean;
  accountId?: string;
  fileName?: string;
};

/**
 * Result of a LID/PhoneNumber lookup.
 * Mirrors WPPConnect's getPnLidEntry API.
 */
export type PnLidEntryResult = {
  /** The LID (Linked ID) for the contact */
  lid: string;
  /** The phone number in E.164 format (e.g. "+1234567890") */
  phoneNumber: string | null;
  /** Cached contact info if available */
  contact?: {
    /** Display name (pushName) */
    name?: string | null;
    /** Profile picture URL if available */
    profilePictureUrl?: string | null;
    /** Whether the contact is a business account */
    isBusiness?: boolean;
    /** Contact's WA ID */
    waId?: string;
  };
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
  /**
   * Lookup LID/PhoneNumber mapping and contact information.
   * Accepts a phone number JID (e.g. "123456@s.whatsapp.net") or LID (e.g. "123@lid").
   * Returns the corresponding LID, phone number, and cached contact info.
   */
  lookupPnLidEntry: (phoneOrLid: string) => Promise<PnLidEntryResult | null>;
  close?: () => Promise<void>;
};

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
