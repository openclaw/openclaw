import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

// Covers a device-code sign-in started from the picker gate (codes live up to
// 30 minutes). In memory only: a Gateway restart also ends that sign-in, so a
// lost entry just means the user selects the model again.
const PENDING_PICKER_SELECTION_TTL_MS = 30 * 60_000;

type PickerSessionScope = { accountId: string; agentId: string; sessionKey: string };

export type PendingPickerSelection = {
  provider: string;
  model: string;
  /** The session's own model choice when the gate blocked the selection. */
  sessionModelRef: string | undefined;
  /** The resolved current model the picker passed to the selection owner. */
  currentModelRef: string | undefined;
};

const pendingSelections = new Map<string, PendingPickerSelection & { expiresAt: number }>();

function pendingKey(scope: PickerSessionScope, provider: string): string {
  return JSON.stringify([
    scope.accountId,
    scope.agentId,
    scope.sessionKey,
    normalizeLowercaseStringOrEmpty(provider),
  ]);
}

/** The model this session chose, so a pick made while signing in is respected. */
export function sessionModelRef(
  entry?: Pick<SessionEntry, "providerOverride" | "modelOverride" | "modelProvider" | "model">,
): string | undefined {
  const provider = entry?.providerOverride ?? entry?.modelProvider;
  const model = entry?.modelOverride ?? entry?.model;
  return provider && model ? `${provider}/${model}` : model;
}

/** Remembers a gate-blocked selection until its provider's sign-in completes. */
export function recordPendingPickerSelection(
  scope: PickerSessionScope,
  selection: PendingPickerSelection,
): void {
  const now = Date.now();
  for (const [key, entry] of pendingSelections) {
    if (entry.expiresAt <= now) {
      pendingSelections.delete(key);
    }
  }
  pendingSelections.set(pendingKey(scope, selection.provider), {
    ...selection,
    expiresAt: now + PENDING_PICKER_SELECTION_TTL_MS,
  });
}

/** Consumes the selection waiting for this session's sign-in to the provider. */
export function takePendingPickerSelection(
  scope: PickerSessionScope,
  provider: string,
): PendingPickerSelection | undefined {
  const key = pendingKey(scope, provider);
  const entry = pendingSelections.get(key);
  pendingSelections.delete(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    return undefined;
  }
  const { expiresAt: _expiresAt, ...selection } = entry;
  return selection;
}
