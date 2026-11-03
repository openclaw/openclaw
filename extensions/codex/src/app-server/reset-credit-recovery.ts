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
export function chooseEarnedCodexResetCredit(
  raw: unknown,
  expectedAccountId: string | undefined,
  nowMs: number,
): CreditChoice | undefined {
  const response = object(raw);
  if (!response || response.ordinaryUsageAllowed !== false) {
    return undefined;
  }
  if (
    expectedAccountId &&
    response.accountId !== expectedAccountId
  ) {
    return undefined;
  }
  const limits = object(response.rateLimits);
  if (
    limits?.rateLimitReachedType !== "rate_limit_reached" ||
    limits.spendControlReached === true
  ) {
    return undefined;
  }
  const inventory = object(response.rateLimitResetCredits);
  const count = inventory?.availableCount;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0) {
    return undefined;
  }

  const rows = inventory?.credits;
  if (!Array.isArray(rows)) {
    return {};
  }
  // Use a specific credit only for a confidently available, compatible row.
  // Otherwise let the backend select a valid credit from its authoritative count.
  for (const candidate of rows) {
    const credit = object(candidate);
    if (
      !credit ||
      credit.status !== "available" ||
      credit.resetType !== "codexRateLimits" ||
      typeof credit.id !== "string" ||
      !credit.id.trim()
    ) {
      continue;
    }
    if (
      credit.expiresAt !== null &&
      (typeof credit.expiresAt !== "number" ||
        !Number.isSafeInteger(credit.expiresAt) ||
        credit.expiresAt * 1000 <= nowMs)
    ) {
      continue;
    }
    return { creditId: credit.id };
  }
  return {};
}

function isAuthoritativelyAvailable(raw: unknown, accountId: string | undefined): boolean {
  const response = object(raw);
  return (
    response?.ordinaryUsageAllowed === true &&
    (!accountId || response.accountId === accountId)
  );
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
  /** Atomically owns a durable attempt for this profile or refuses the claim. */
  claim: (profileId: string, maxPer24Hours: number) => Promise<CodexResetClaim>;
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
  let available: string | undefined;
  try {
    available = await params.firstAvailable();
  } catch {
    return { status: "uncertain" };
  }
  if (available) {
    return params.orderedProfileIds.includes(available)
      ? { status: "available", profileId: available }
      : { status: "uncertain" };
  }
  // Existing ordering is authoritative; never widen the chain.
  const profileId = params.orderedProfileIds[0];
  if (!profileId) {
    return { status: "not-eligible" };
  }
  let claim: CodexResetClaim;
  try {
    claim = await params.claim(profileId, params.maxPer24Hours);
  } catch {
    return { status: "uncertain" };
  }
  if (claim.status !== "owned") {
    return { status: claim.status };
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
    const currentAvailable = await params.firstAvailable();
    if (currentAvailable) {
      if (!params.orderedProfileIds.includes(currentAvailable)) {
        await settle("uncertain");
        return { status: "uncertain" };
      }
      await settle("not-needed");
      return { status: "available", profileId: currentAvailable };
    }
    await params.assertCurrent(profileId);
    const before = await params.readLimits(profileId, params.signal);
    const credit = chooseEarnedCodexResetCredit(before, params.accountId(profileId), Date.now());
    if (!credit) {
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
      ...(credit.creditId ? { creditId: credit.creditId } : {}),
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
    if (outcome === "reset" || outcome === "alreadyRedeemed") {
      await params.assertCurrent(profileId);
      const after = await params.readLimits(profileId, params.signal);
      if (isAuthoritativelyAvailable(after, params.accountId(profileId))) {
        await settle("restored");
        return { status: "restored", profileId };
      }
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
