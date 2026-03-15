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

// Use globalThis to ensure a single shared instance across bundled chunks.
// The bundler may duplicate this module into multiple output files, and each
// copy would get its own module-scoped Map — causing setActiveWebListener
// (in chunk A) to register a listener that requireActiveWebListener (in chunk B)
// cannot find. Storing on globalThis avoids this.
const GLOBAL_KEY = "__openclaw_whatsapp_listeners__" as const;
const GLOBAL_CURRENT_KEY = "__openclaw_whatsapp_current_listener__" as const;

type ListenerGlobals = {
  [GLOBAL_KEY]?: Map<string, ActiveWebListener>;
  [GLOBAL_CURRENT_KEY]?: ActiveWebListener | null;
};

const g = globalThis as unknown as ListenerGlobals;
if (!g[GLOBAL_KEY]) {
  g[GLOBAL_KEY] = new Map<string, ActiveWebListener>();
}

const listeners = g[GLOBAL_KEY];

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
    g[GLOBAL_CURRENT_KEY] = listener;
  }
}

export function getActiveWebListener(accountId?: string | null): ActiveWebListener | null {
  const id = resolveWebAccountId(accountId);
  return listeners.get(id) ?? null;
}
