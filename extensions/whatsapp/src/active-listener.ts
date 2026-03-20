import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import type { PollInput } from "openclaw/plugin-sdk/media-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";

export type ActiveWebSendOptions = {
  gifPlayback?: boolean;
  accountId?: string;
  fileName?: string;
  replyToId?: string;
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
  close?: () => Promise<void>;
};

// Use process-global symbol keys to survive bundler code-splitting and loader
// cache splits without depending on fragile string property names.
const GLOBAL_LISTENERS_KEY = Symbol.for("openclaw.whatsapp.activeListeners");
const GLOBAL_CURRENT_KEY = Symbol.for("openclaw.whatsapp.currentListener");

type GlobalWithListeners = typeof globalThis & {
  [GLOBAL_LISTENERS_KEY]?: Map<string, ActiveWebListener>;
  [GLOBAL_CURRENT_KEY]?: ActiveWebListener | null;
};

const _global = globalThis as GlobalWithListeners;

_global[GLOBAL_LISTENERS_KEY] ??= new Map<string, ActiveWebListener>();
_global[GLOBAL_CURRENT_KEY] ??= null;

const listeners = _global[GLOBAL_LISTENERS_KEY];

function getCurrentListener(): ActiveWebListener | null {
  return _global[GLOBAL_CURRENT_KEY] ?? null;
}

function setCurrentListener(listener: ActiveWebListener | null): void {
  _global[GLOBAL_CURRENT_KEY] = listener;
}

export function resolveWebAccountId(accountId?: string | null): string {
  return (accountId ?? "").trim() || DEFAULT_ACCOUNT_ID;
}

export function requireActiveWebListener(accountId?: string | null): {
  accountId: string;
  listener: ActiveWebListener;
} {
  const id = resolveWebAccountId(accountId);
  const listener = listeners.get(id) ?? null;
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
    listeners.delete(id);
  } else {
    listeners.set(id, listener);
  }
  if (id === DEFAULT_ACCOUNT_ID) {
    setCurrentListener(listener);
  }
}

export function getActiveWebListener(accountId?: string | null): ActiveWebListener | null {
  const id = resolveWebAccountId(accountId);
  return listeners.get(id) ?? null;
}
