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
// Use a globalThis-backed Map so that every bundler chunk shares the same
// listener registry.
//
// Background: tsdown / Rollup code-splits this module into several output
// chunks.  Each chunk receives its own copy of the module-scoped `listeners`
// Map, which means `setActiveWebListener()` writes to one Map while
// `requireActiveWebListener()` (imported in a different chunk) reads from
// another — causing "No active WhatsApp Web listener" errors on proactive
// outbound sends even though the Baileys socket is connected and inbound
// auto-replies work fine.
//
// Pinning the Map to `globalThis` guarantees a single shared instance
// regardless of how many chunks the bundler produces.
// ---------------------------------------------------------------------------
const GLOBAL_KEY = Symbol.for("openclaw.whatsapp.activeListeners");

function getListeners(): Map<string, ActiveWebListener> {
  const g = globalThis as unknown as Record<symbol, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, ActiveWebListener>();
  }
  return g[GLOBAL_KEY] as Map<string, ActiveWebListener>;
}

let _currentListener: ActiveWebListener | null = null;

export function resolveWebAccountId(accountId?: string | null): string {
  return (accountId ?? "").trim() || DEFAULT_ACCOUNT_ID;
}

export function requireActiveWebListener(accountId?: string | null): {
  accountId: string;
  listener: ActiveWebListener;
} {
  const id = resolveWebAccountId(accountId);
  const listener = getListeners().get(id) ?? null;
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
    getListeners().delete(id);
  } else {
    getListeners().set(id, listener);
  }
  if (id === DEFAULT_ACCOUNT_ID) {
    _currentListener = listener;
  }
}

export function getActiveWebListener(accountId?: string | null): ActiveWebListener | null {
  const id = resolveWebAccountId(accountId);
  return getListeners().get(id) ?? null;
}
