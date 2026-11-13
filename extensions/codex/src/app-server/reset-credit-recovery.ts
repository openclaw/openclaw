/**
 * Earned Codex quota resets are different from monetary credits, OAuth refresh,
 * local cooldown clearing, and the normal quota-window timer.
 *
 * This policy layer never owns auth selection or persistence. Its host must pass
 * the already-authorized ordered profile chain and an atomic, durable claim
 * implementation before wiring it into a runnable request path.
 */
export type CodexResetOutcome = "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit";

export type CodexResetClaim =
  | { status: "owned"; attemptId: string; idempotencyKey: string }
  | { status: "busy" | "limit" | "uncertain" };

export type CodexResetRecoveryResult =
  | { status: "disabled" | "not-eligible" | "busy" | "limit" | "uncertain" }
  | { status: "available" | "restored"; profileId: string }
  | { status: "not-restored"; outcome: CodexResetOutcome };

type CreditChoice = { creditId?: string };

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Require positive, explicit native facts before spending. An absent inventory
 * is unknown (never zero). A positive count does not establish eligibility.
 * Credit detail rows may be incomplete, so the count is not their length.
 */
function isSelectedAccount(raw: unknown, expectedAccountId: string | undefined): boolean {
  const response = object(raw);
  return Boolean(response && (!expectedAccountId || response.accountId === expectedAccountId));
}

/**
 * A reset credit cannot establish resettable subscription exhaustion by itself.
 * In particular, purchased monetary credits and workspace spending caps are
 * independent of the banked-credit inventory.
 */
function isResettableExhaustion(raw: unknown, accountId: string | undefined): boolean {
  if (!isSelectedAccount(raw, accountId)) {
    return false;
  }
  const response = object(raw);
  if (response?.ordinaryUsageAllowed !== false) {
    return false;
  }
  const limit = object(response.rateLimits);
  const monetary = object(limit?.credits);
  return Boolean(
    limit &&
      (limit.limitId === null || limit.limitId === undefined || limit.limitId === "codex") &&
      limit.rateLimitReachedType === "rate_limit_reached" &&
      limit.spendControlReached !== true &&
      monetary?.hasCredits !== true &&
      monetary?.unlimited !== true,
  );
}

/**
 * A positive availableCount is authoritative even if detail rows are capped
 * or null. When details are incomplete, omit creditId and let Codex select it;
 * never assert that the first detail row is the earliest overall expiry.
 */
export function chooseEarnedCodexResetCredit(
  raw: unknown,
  expectedAccountId: string | undefined,
  nowMs: number,
): CreditChoice | undefined {
  if (!isResettableExhaustion(raw, expectedAccountId)) {
    return undefined;
  }
  const inventory = object(object(raw)?.rateLimitResetCredits);
  const count = inventory?.availableCount;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0) {
    return undefined;
  }
  const rows = inventory?.credits;
  if (rows === null || rows === undefined) {
    return {};
  }
  if (!Array.isArray(rows)) {
    return undefined;
  }
  if (rows.length === 0) {
    return {};
  }
  const valid: Array<{ id: string; expiry: number }> = [];
  for (const candidate of rows) {
    const credit = object(candidate);
    if (
      !credit ||
      credit.status !== "available" ||
      credit.resetType !== "codexRateLimits" ||
      typeof credit.id !== "string" ||
      !credit.id.trim() ||
      (credit.expiresAt !== null &&
        (typeof credit.expiresAt !== "number" ||
          !Number.isSafeInteger(credit.expiresAt) ||
          credit.expiresAt <= 0 ||
          credit.expiresAt > 8_640_000_000_000))
    ) {
      // Contradictory or corrupt details are not permission to spend.
      return undefined;
    }
    const expiry =
      credit.expiresAt === null ? Number.POSITIVE_INFINITY : credit.expiresAt * 1000;
    if (expiry <= nowMs) {
      return undefined;
    }
    valid.push({ id: credit.id, expiry });
  }
  if (rows.length !== count) {
    // Count is authoritative, but these details are not complete.
    return {};
  }
  if (new Set(valid.map((entry) => entry.id)).size !== count) {
    return undefined;
  }
  valid.sort((a, b) => a.expiry - b.expiry || a.id.localeCompare(b.id));
  return valid[0] ? { creditId: valid[0].id } : undefined;
}

function isAuthoritativelyAvailable(raw: unknown, accountId: string | undefined): boolean {
  return isSelectedAccount(raw, accountId) && object(raw)?.ordinaryUsageAllowed === true;
}

type ScanResult =
  | { status: "available"; profileId: string }
  | { status: "candidate"; profileId: string; credit: CreditChoice }
  | { status: "not-eligible" };

type RecoveryOptions = Parameters<typeof recoverWithEarnedCodexReset>[0];

/**
 * Inspect the entire previously authorized chain before considering any
 * irreversible spend. A later healthy account always wins over an earlier
 * account's earned credit. Errors do not widen the set of eligible accounts.
 */
async function scanAllowedProfiles(params: RecoveryOptions): Promise<ScanResult> {
  let target: Extract<ScanResult, { status: "candidate" }> | undefined;
  for (const profileId of params.orderedProfileIds) {
    if (params.signal?.aborted) {
      throw new Error("Codex reset recovery cancelled");
    }
    await params.assertCurrent(profileId);
    if (!(await params.isResettableBlocked(profileId))) {
      return { status: "not-eligible" };
    }
    const account = params.accountId(profileId);
    // Never redeem against an account whose native identity cannot be bound
    // to the currently selected OAuth profile.
    if (!account?.trim()) {
      return { status: "not-eligible" };
    }
    const limits = await params.readLimits(profileId, params.signal);
    await params.assertCurrent(profileId);
    if (isAuthoritativelyAvailable(limits, account)) {
      return { status: "available", profileId };
    }
    if (!isResettableExhaustion(limits, account)) {
      return { status: "not-eligible" };
    }
    const credit = chooseEarnedCodexResetCredit(limits, account, Date.now());
    if (!target && credit) {
      target = { status: "candidate", profileId, credit };
    }
  }
  return target ?? { status: "not-eligible" };
}

/**
 * One bounded recovery cycle. The caller must provide a cross-process SQLite
 * claim that atomically enforces a spend cap and persists the idempotency key
 * before this function is permitted to make an external request.
 *
 * "uncertain" is terminal: a caller must reconcile the *same* attempt/key, not
 * select another account and spend a second credit.
 */
export async function recoverWithEarnedCodexReset(params: {
  enabled: boolean;
  orderedProfileIds: readonly string[];
  maxPer24Hours: number;
  signal?: AbortSignal;
  /** Fresh selection within the same authorized ordered chain. */
  firstAvailable: () => Promise<string | undefined>;
  /**
   * The auth owner confirms each profile is blocked specifically by a
   * resettable subscription limit, not auth, billing, transport or a 5xx.
   */
  isResettableBlocked: (profileId: string) => Promise<boolean>;
  /**
   * The shared-state claim atomically enforces the rolling spend cap and
   * unresolved-attempt fence across all accounts. Crash retries must return
   * the original idempotency key; only the ledger may mint a new key.
   */
  claim: (profileId: string, maxPer24Hours: number) => Promise<CodexResetClaim>;
  /**
   * Optional bounded shared-result waiter supplied by the durable owner. A
   * "settled" hint never grants auth; the full authorized chain is rechecked.
   */
  waitForPending?: (signal?: AbortSignal) =>
    Promise<"settled" | "uncertain" | "timeout" | "aborted">;
  /** Must revalidate selection, account identity, and credential generation. */
  assertCurrent: (profileId: string) => Promise<void>;
  readLimits: (profileId: string, signal?: AbortSignal) => Promise<unknown>;
  consume: (input: {
    profileId: string;
    idempotencyKey: string;
    creditId?: string;
    signal?: AbortSignal;
  }) => Promise<unknown>;
  settle: (
    profileId: string,
    attemptId: string,
    status: "restored" | "not-restored" | "uncertain" | "not-needed",
  ) => Promise<void>;
  accountId: (profileId: string) => string | undefined;
}): Promise<CodexResetRecoveryResult> {
  if (!params.enabled) {
    return { status: "disabled" };
  }
  if (
    !Number.isSafeInteger(params.maxPer24Hours) ||
    params.maxPer24Hours < 1 ||
    params.orderedProfileIds.length === 0 ||
    params.signal?.aborted
  ) {
    return { status: "not-eligible" };
  }
  if (new Set(params.orderedProfileIds).size !== params.orderedProfileIds.length) {
    return { status: "not-eligible" };
  }
  const checkedAvailable = async () => {
    const selected = await params.firstAvailable();
    if (selected && !params.orderedProfileIds.includes(selected)) {
      throw new Error("Auth selection escaped authorized profile chain");
    }
    return selected;
  };
  let selection: ScanResult;
  try {
    const available = await checkedAvailable();
    if (available) {
      return { status: "available", profileId: available };
    }
    selection = await scanAllowedProfiles(params);
  } catch {
    return { status: "uncertain" };
  }
  if (selection.status === "available") {
    return { status: "available", profileId: selection.profileId };
  }
  if (selection.status !== "candidate") {
    return { status: "not-eligible" };
  }
  const profileId = selection.profileId;
  let claim: CodexResetClaim;
  try {
    claim = await params.claim(profileId, params.maxPer24Hours);
  } catch {
    return { status: "uncertain" };
  }
  if (claim.status !== "owned") {
    if (claim.status === "busy" && params.waitForPending) {
      try {
        const waited = await params.waitForPending(params.signal);
        if (waited === "uncertain") {
          return { status: "uncertain" };
        }
        if (waited === "settled" && !params.signal?.aborted) {
          const available = await checkedAvailable();
          if (available) {
            return { status: "available", profileId: available };
          }
          const refreshed = await scanAllowedProfiles(params);
          if (refreshed.status === "available") {
            return { status: "available", profileId: refreshed.profileId };
          }
        }
      } catch {
        return { status: "uncertain" };
      }
    }
    return { status: claim.status };
  }
  if (!claim.attemptId.trim() || !claim.idempotencyKey.trim()) {
    return { status: "uncertain" };
  }
  let settled = false;
  const settle = async (status: Parameters<typeof params.settle>[2]) => {
    await params.settle(profileId, claim.attemptId, status);
    settled = true;
  };
  try {
    if (params.signal?.aborted) {
      await settle("not-needed");
      return { status: "not-eligible" };
    }
    // A peer may have recovered any candidate before this durable claim settled.
    const currentAvailable = await checkedAvailable();
    if (currentAvailable) {
      await settle("not-needed");
      return { status: "available", profileId: currentAvailable };
    }
    // Recheck the ENTIRE chain after taking durable ownership. A peer may have
    // restored a different permitted account while we were claiming.
    const current = await scanAllowedProfiles(params);
    if (current.status === "available") {
      await settle("not-needed");
      return { status: "available", profileId: current.profileId };
    }
    if (current.status !== "candidate" || current.profileId !== profileId) {
      await settle("not-needed");
      return { status: "not-eligible" };
    }
    await params.assertCurrent(profileId);
    if (params.signal?.aborted) {
      await settle("not-needed");
      return { status: "not-eligible" };
    }
    // The idempotency key must already be durably recorded by claim().
    const raw = await params.consume({
      profileId,
      idempotencyKey: claim.idempotencyKey,
      ...(current.credit.creditId ? { creditId: current.credit.creditId } : {}),
      signal: params.signal,
    });
    const outcome = object(raw)?.outcome;
    if (
      outcome !== "reset" &&
      outcome !== "alreadyRedeemed" &&
      outcome !== "nothingToReset" &&
      outcome !== "noCredit"
    ) {
      await settle("uncertain");
      return { status: "uncertain" };
    }
    // All official outcomes need a fresh authoritative read. In particular,
    // nothingToReset can race a natural quota renewal; it is not permission to
    // clear a locally blocked state without observing the account.
    await params.assertCurrent(profileId);
    const after = await params.readLimits(profileId, params.signal);
    await params.assertCurrent(profileId);
    if (isAuthoritativelyAvailable(after, params.accountId(profileId))) {
      if (outcome === "reset" || outcome === "alreadyRedeemed") {
        await settle("restored");
        return { status: "restored", profileId };
      }
      await settle("not-needed");
      return { status: "available", profileId };
    }
    await settle("not-restored");
    return { status: "not-restored", outcome };
  } catch {
    // A timeout or late write is not evidence that another credit may be spent.
    // Reconcile this attempt under the same persisted idempotency key.
    if (!settled) {
      try {
        await settle("uncertain");
      } catch {
        // Unavailable persistence is itself uncertain; fail closed.
      }
    }
    return { status: "uncertain" };
  }
}
