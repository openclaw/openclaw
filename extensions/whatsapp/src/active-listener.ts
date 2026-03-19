import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import type { PollInput } from "openclaw/plugin-sdk/media-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import type { WebListenerCloseReason } from "./inbound/types.js";

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
  signalClose?: (reason?: WebListenerCloseReason) => void;
};

export type ActiveWebRecoveryRequest = {
  accountId: string;
  reason?: string;
};

export type ActiveWebRecoveryFn = (
  request: ActiveWebRecoveryRequest,
) => Promise<boolean | void> | boolean | void;

// Use process-global symbol keys to survive bundler code-splitting and loader
// cache splits without depending on fragile string property names.
const GLOBAL_LISTENERS_KEY = Symbol.for("openclaw.whatsapp.activeListeners");
const GLOBAL_CURRENT_KEY = Symbol.for("openclaw.whatsapp.currentListener");
const GLOBAL_RECOVERY_KEY = Symbol.for("openclaw.whatsapp.recoveryHooks");

type GlobalWithListeners = typeof globalThis & {
  [GLOBAL_LISTENERS_KEY]?: Map<string, ActiveWebListener>;
  [GLOBAL_CURRENT_KEY]?: ActiveWebListener | null;
  [GLOBAL_RECOVERY_KEY]?: Map<string, ActiveWebRecoveryFn>;
};

const _global = globalThis as GlobalWithListeners;

_global[GLOBAL_LISTENERS_KEY] ??= new Map<string, ActiveWebListener>();
_global[GLOBAL_CURRENT_KEY] ??= null;
_global[GLOBAL_RECOVERY_KEY] ??= new Map<string, ActiveWebRecoveryFn>();

const listeners = _global[GLOBAL_LISTENERS_KEY];
const recoveryHooks = _global[GLOBAL_RECOVERY_KEY];

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

export function clearActiveWebListener(
  accountId?: string | null,
  expectedListener?: ActiveWebListener | null,
): boolean {
  const id = resolveWebAccountId(accountId);
  const current = listeners.get(id) ?? null;
  if (expectedListener && current !== expectedListener) {
    return false;
  }
  listeners.delete(id);
  if (id === DEFAULT_ACCOUNT_ID) {
    setCurrentListener(listeners.get(id) ?? null);
  }
  return true;
}

export function getActiveWebListener(accountId?: string | null): ActiveWebListener | null {
  const id = resolveWebAccountId(accountId);
  return listeners.get(id) ?? null;
}

export function setWebListenerRecovery(
  accountId: string | null | undefined,
  recovery: ActiveWebRecoveryFn | null,
): void {
  const id = resolveWebAccountId(accountId);
  if (!recovery) {
    recoveryHooks.delete(id);
    return;
  }
  recoveryHooks.set(id, recovery);
}

export function clearWebListenerRecovery(
  accountId: string | null | undefined,
  expectedRecovery?: ActiveWebRecoveryFn | null,
): boolean {
  const id = resolveWebAccountId(accountId);
  const current = recoveryHooks.get(id);
  if (expectedRecovery && current !== expectedRecovery) {
    return false;
  }
  recoveryHooks.delete(id);
  return true;
}

export async function requestWebListenerRecovery(
  accountId?: string | null,
  reason?: string,
): Promise<boolean> {
  const id = resolveWebAccountId(accountId);
  const recovery = recoveryHooks.get(id);
  if (!recovery) {
    return false;
  }
  const result = await recovery({ accountId: id, reason });
  return result !== false;
}
