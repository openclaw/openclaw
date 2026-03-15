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

// ---------------------------------------------------------------------------
// Singleton listener registry – must survive bundler chunk-splitting.
//
// When the bundler (tsdown / Rollup) code-splits this module into multiple
// output chunks, each chunk receives its own copy of module-scoped variables.
// That causes `setActiveWebListener` (called from the inbound/monitor path)
// and `requireActiveWebListener` (called from the outbound/send path) to
// operate on *different* Maps, so outbound sends always throw
// "No active WhatsApp Web listener" even though the socket is alive.
//
// Anchoring the Map on `globalThis` guarantees a single shared instance
// regardless of how many chunks import this file.
// See: https://github.com/openclaw/openclaw/issues/45171
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __openclaw_wa_web_listeners: Map<string, ActiveWebListener> | undefined;
}

const listeners: Map<string, ActiveWebListener> = (globalThis.__openclaw_wa_web_listeners ??=
  new Map<string, ActiveWebListener>());

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
}

export function getActiveWebListener(accountId?: string | null): ActiveWebListener | null {
  const id = resolveWebAccountId(accountId);
  return listeners.get(id) ?? null;
}
