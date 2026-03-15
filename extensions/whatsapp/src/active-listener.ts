import { formatCliCommand } from "../../../src/cli/command-format.js";
import type { PollInput } from "../../../src/polls.js";
import { DEFAULT_ACCOUNT_ID } from "../../../src/routing/session-key.js";

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
  close?: () => Promise<void>;
};

// Use a process-level singleton to survive bundler code-splitting.
// Rolldown duplicates this module across multiple output chunks, each with its
// own module-scoped `listeners` Map. The WhatsApp provider writes to one chunk's
// Map via setActiveWebListener(), but the outbound send path reads from a
// different chunk's Map via requireActiveWebListener() — so the listener is
// never found. Pinning the Map to globalThis ensures all chunks share one
// instance.  See: https://github.com/openclaw/openclaw/issues/14406
const GLOBAL_KEY = "__openclaw_wa_listeners" as const;
const GLOBAL_CURRENT_KEY = "__openclaw_wa_current_listener" as const;

type GlobalWithListeners = typeof globalThis & {
  [GLOBAL_KEY]?: Map<string, ActiveWebListener>;
  [GLOBAL_CURRENT_KEY]?: ActiveWebListener | null;
};

const _global = globalThis as GlobalWithListeners;

_global[GLOBAL_KEY] ??= new Map<string, ActiveWebListener>();
_global[GLOBAL_CURRENT_KEY] ??= null;

const listeners = _global[GLOBAL_KEY];

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
