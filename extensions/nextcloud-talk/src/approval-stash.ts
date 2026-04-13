import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";

/** Keycap emoji → approval decision mapping (1️⃣ allow-once, 2️⃣ allow-always, 3️⃣ deny). */
const KEYCAP_DECISION_MAP: ReadonlyMap<string, ExecApprovalReplyDecision> = new Map([
  ["1️⃣", "allow-once"],
  ["2️⃣", "allow-always"],
  ["3️⃣", "deny"],
]);

/** Binary fallback when allowedDecisions is narrowed to a 2-decision set. */
const BINARY_DECISION_MAP: ReadonlyMap<string, ExecApprovalReplyDecision> = new Map([
  ["👍", "allow-once"],
  ["👎", "deny"],
]);

export type ApprovalStashAction = {
  emoji: string;
  decision: ExecApprovalReplyDecision;
};

export type ApprovalStashEntry = {
  approvalId: string;
  approvalSlug: string;
  approvalKind: "exec" | "plugin";
  actions: readonly ApprovalStashAction[];
  sessionKey?: string;
  createdAt: number;
};

/** Default TTL: 10 minutes. */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

type StashKey = `${string}:${string}:${string}`;

function makeKey(accountId: string, roomToken: string, messageId: string): StashKey {
  return `${accountId}:${roomToken}:${messageId}`;
}

const stash = new Map<StashKey, ApprovalStashEntry>();

/**
 * Build the emoji→decision action list for a given set of allowed decisions.
 * Uses keycap numerals (1️⃣/2️⃣/3️⃣) for the standard 3-decision set, falls back
 * to 👍/👎 when the decisions are narrowed to a binary pair.
 */
export function buildApprovalActions(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): ApprovalStashAction[] {
  if (allowedDecisions.length <= 2) {
    return allowedDecisions
      .map((decision) => {
        for (const [emoji, d] of BINARY_DECISION_MAP) {
          if (d === decision) {
            return { emoji, decision };
          }
        }
        return null;
      })
      .filter((a): a is ApprovalStashAction => a !== null);
  }
  return allowedDecisions
    .map((decision) => {
      for (const [emoji, d] of KEYCAP_DECISION_MAP) {
        if (d === decision) {
          return { emoji, decision };
        }
      }
      return null;
    })
    .filter((a): a is ApprovalStashAction => a !== null);
}

/** Seed a stash entry for an outbound approval prompt message. */
export function stashApproval(
  accountId: string,
  roomToken: string,
  messageId: string,
  entry: Omit<ApprovalStashEntry, "createdAt">,
): void {
  stash.set(makeKey(accountId, roomToken, messageId), {
    ...entry,
    createdAt: Date.now(),
  });
}

/** Look up a stash entry by the message the reaction was placed on. */
export function lookupApproval(
  accountId: string,
  roomToken: string,
  messageId: string,
): ApprovalStashEntry | undefined {
  return stash.get(makeKey(accountId, roomToken, messageId));
}

/** Resolve a reaction emoji to a decision using the stashed action mapping. */
export function resolveReactionDecision(
  entry: ApprovalStashEntry,
  emoji: string,
): ExecApprovalReplyDecision | undefined {
  return entry.actions.find((a) => a.emoji === emoji)?.decision;
}

/** Remove a stash entry after the decision is dispatched. */
export function consumeApproval(accountId: string, roomToken: string, messageId: string): void {
  stash.delete(makeKey(accountId, roomToken, messageId));
}

/** Evict entries older than the given TTL (default 10 min). */
export function purgeExpiredApprovals(ttlMs: number = DEFAULT_TTL_MS): number {
  const cutoff = Date.now() - ttlMs;
  let removed = 0;
  for (const [key, entry] of stash) {
    if (entry.createdAt < cutoff) {
      stash.delete(key);
      removed++;
    }
  }
  return removed;
}

/** Visible-for-testing: current stash size. */
export function approvalStashSize(): number {
  return stash.size;
}

/** Visible-for-testing: clear all entries. */
export function clearApprovalStash(): void {
  stash.clear();
}
