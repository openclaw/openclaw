import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export type ImapCursor = { uidValidity: string; lastSeenUid: number; updatedAt: number };
export type ImapClaim = { accountId: string; uid: number; recordedAt: number };
export type ImapAttempt = { count: number; reason: string };
export type ImapMessageRing = { messageIds: string[] };

export const MAX_IMAP_UID = 0xffff_ffff;

export function isImapUid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_IMAP_UID;
}

function isCursorUid(value: unknown): value is number {
  return value === 0 || isImapUid(value);
}

export function createImapState(runtime: OpenClawPluginApi["runtime"]) {
  return {
    cursors: runtime.state.openKeyedStore<ImapCursor>({
      namespace: "cursor",
      maxEntries: 256,
      overflowPolicy: "reject-new",
    }),
    claims: runtime.state.openKeyedStore<ImapClaim | ImapAttempt>({
      namespace: "dispatch-claim",
      maxEntries: 20_000,
      defaultTtlMs: 7 * 24 * 60 * 60 * 1_000,
    }),
    messageIds: runtime.state.openKeyedStore<ImapMessageRing>({
      namespace: "msgid-ring",
      maxEntries: 256,
      overflowPolicy: "reject-new",
    }),
    skips: runtime.state.openKeyedStore<{ count: number }>({
      namespace: "skip-count",
      maxEntries: 2_048,
    }),
  };
}

export type ImapWatcherState = ReturnType<typeof createImapState>;

export async function initializeImapCursor(
  state: ImapWatcherState,
  accountId: string,
  uidValidity: string,
  resolveBaseline: () => Promise<number>,
  isActive: () => boolean,
): Promise<{ kind: "baseline" | "reset" | "resume"; cursor: ImapCursor } | undefined> {
  // ImapFlow supports UIDVALIDITY values wider than message UIDs. Preserve the
  // mailbox identity as a decimal string without narrowing its range or precision.
  if (!/^[1-9]\d*$/u.test(uidValidity)) {
    throw new Error("imap: invalid mailbox UIDVALIDITY");
  }
  const existing = await state.cursors.lookup(accountId);
  if (!isActive()) {
    return undefined;
  }
  if (existing?.uidValidity === uidValidity) {
    if (!isCursorUid(existing.lastSeenUid)) {
      throw new Error("imap: invalid persisted cursor UID");
    }
    return { kind: "resume", cursor: existing };
  }
  // A changed UIDVALIDITY invalidates the old UID space, including any invalid
  // UID saved by an older initializer. Only the new baseline must be usable.
  // Resolving a new baseline may perform I/O. A resumed cursor must never depend
  // on that lookup or skip mail that arrived while the watcher was offline.
  const lastSeenUid = await resolveBaseline();
  if (!isActive()) {
    return undefined;
  }
  if (!isCursorUid(lastSeenUid)) {
    throw new Error("imap: invalid baseline UID");
  }
  const cursor = { uidValidity, lastSeenUid, updatedAt: Date.now() };
  await state.cursors.register(accountId, cursor);
  return { kind: existing ? "reset" : "baseline", cursor };
}

export async function advanceImapCursor(
  state: ImapWatcherState,
  accountId: string,
  uidValidity: string,
  uid: number,
): Promise<void> {
  await state.cursors.register(accountId, {
    uidValidity,
    lastSeenUid: uid,
    updatedAt: Date.now(),
  });
}

export async function rememberImapMessage(
  state: ImapWatcherState,
  accountId: string,
  messageId: string,
): Promise<boolean> {
  const ring = await state.messageIds.lookup(accountId);
  if (ring?.messageIds.includes(messageId)) {
    return false;
  }
  await state.messageIds.register(accountId, {
    messageIds: [...(ring?.messageIds ?? []), messageId].slice(-100),
  });
  return true;
}

export async function countImapSkip(
  state: ImapWatcherState,
  accountId: string,
  reason: string,
): Promise<void> {
  const key = `${accountId}:${reason}`;
  const current = await state.skips.lookup(key);
  await state.skips.register(key, { count: Math.min((current?.count ?? 0) + 1, 1_000_000) });
}

export async function recordImapAttempt(
  state: ImapWatcherState,
  messageKey: string,
  reason: string,
): Promise<number> {
  const key = `attempt:${messageKey}`;
  const previous = await state.claims.lookup(key);
  const count = (previous && "count" in previous ? previous.count : 0) + 1;
  await state.claims.register(key, { count, reason });
  return count;
}
