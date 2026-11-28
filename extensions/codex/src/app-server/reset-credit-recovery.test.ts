import { describe, expect, it, vi } from "vitest";
import {
  chooseEarnedCodexResetCredit,
  recoverWithEarnedCodexReset,
} from "./reset-credit-recovery.js";

const accountId = "account-one";
const blocked = (credits: unknown) => ({
  accountId,
  ordinaryUsageAllowed: false,
  rateLimits: {
    rateLimitReachedType: "rate_limit_reached",
    spendControlReached: false,
  },
  rateLimitResetCredits: credits,
});
const recovered = { accountId, ordinaryUsageAllowed: true };
const oneCredit = {
  availableCount: 1,
  credits: [
    { id: "earned-credit", status: "available", resetType: "codexRateLimits", expiresAt: null },
  ],
};

function harness(overrides: Record<string, unknown> = {}) {
  let consumed = false;
  const consume = vi.fn(async () => {
    consumed = true;
    return { outcome: "reset" as const };
  });
  // First account has a real exhausted subscription limit and an earned credit.
  // Second account also has exhausted quota, but no earned reset credit.
  const readLimits = vi.fn(async (profileId: string) =>
    profileId === "openai:first"
      ? consumed
        ? recovered
        : blocked(oneCredit)
      : blocked({ availableCount: 0, credits: [] }),
  );
  const firstAvailable = vi.fn().mockResolvedValue(undefined);
  const assertCurrent = vi.fn(async () => {});
  const isResettableBlocked = vi.fn(async () => true);
  const settle = vi.fn(async () => {});
  const claim = vi.fn(async () => ({
    status: "owned" as const,
    attemptId: "attempt-one",
    idempotencyKey: "key-one",
  }));
  const options = {
    enabled: true,
    orderedProfileIds: ["openai:first", "openai:second"],
    maxPer24Hours: 1,
    firstAvailable,
    isResettableBlocked,
    assertCurrent,
    readLimits,
    consume,
    settle,
    claim,
    accountId: () => accountId,
    ...overrides,
  };
  return { options, consume, readLimits, firstAvailable, assertCurrent, settle, claim };
}

describe("earned Codex reset-credit inventory", () => {
  it("never treats missing, partial, malformed or confirmed empty inventory as spendable", () => {
    for (const credits of [undefined, null, {}, { availableCount: 0 }, { availableCount: -1 }, { availableCount: "2" }]) {
      expect(chooseEarnedCodexResetCredit(blocked(credits), accountId, Date.now())).toBeUndefined();
    }
  });

  it("requires explicit exhaustion and matches the authenticated account", () => {
    expect(chooseEarnedCodexResetCredit({ ...blocked(oneCredit), ordinaryUsageAllowed: null }, accountId, Date.now())).toBeUndefined();
    expect(chooseEarnedCodexResetCredit(blocked(oneCredit), "different", Date.now())).toBeUndefined();
    expect(chooseEarnedCodexResetCredit({ ...blocked(oneCredit), rateLimits: { rateLimitReachedType: "workspace_owner_credits_depleted" } }, accountId, Date.now())).toBeUndefined();
    expect(chooseEarnedCodexResetCredit({ ...blocked(oneCredit), rateLimits: { rateLimitReachedType: "rate_limit_reached", spendControlReached: true } }, accountId, Date.now())).toBeUndefined();
  });

  it("sorts verified full details by earliest expiry, preserving non-expiring credits", () => {
    const future = Math.floor(Date.now() / 1000) + 7200;
    expect(chooseEarnedCodexResetCredit(blocked({
      availableCount: 3,
      credits: [
        { id: "never", resetType: "codexRateLimits", status: "available", expiresAt: null },
        { id: "later", resetType: "codexRateLimits", status: "available", expiresAt: future + 3600 },
        { id: "sooner", resetType: "codexRateLimits", status: "available", expiresAt: future },
      ],
    }), accountId, Date.now())).toEqual({ creditId: "sooner" });
  });

  it("uses count-only backend selection for capped details but refuses corrupt/expired rows", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect(chooseEarnedCodexResetCredit(blocked({
      availableCount: 3,
      credits: [{ id: "known", resetType: "codexRateLimits", status: "available", expiresAt: future }],
    }), accountId, Date.now())).toEqual({});
    expect(chooseEarnedCodexResetCredit(blocked({
      availableCount: 3, credits: null,
    }), accountId, Date.now())).toEqual({});
    expect(chooseEarnedCodexResetCredit(blocked({
      availableCount: 2,
      credits: [{ id: "expired", resetType: "codexRateLimits", status: "available", expiresAt: past }],
    }), accountId, Date.now())).toBeUndefined();
    expect(chooseEarnedCodexResetCredit(blocked({
      availableCount: 1,
      credits: [{ id: "broken", resetType: "codexRateLimits", status: "available" }],
    }), accountId, Date.now())).toBeUndefined();
  });

  it("rejects duplicated and out-of-range credit detail rows", () => {
    const valid = {
      id: "same", resetType: "codexRateLimits", status: "available", expiresAt: null,
    };
    expect(chooseEarnedCodexResetCredit(blocked({
      availableCount: 2, credits: [valid, valid],
    }), accountId, Date.now())).toBeUndefined();
    expect(chooseEarnedCodexResetCredit(blocked({
      availableCount: 1,
      credits: [{ ...valid, expiresAt: 8_640_000_000_001 }],
    }), accountId, Date.now())).toBeUndefined();
  });

  it("never spends earned credits when purchased monetary credits are available", () => {
    for (const credits of [{ hasCredits: true }, { unlimited: true }]) {
      expect(chooseEarnedCodexResetCredit({
        ...blocked(oneCredit),
        rateLimits: { rateLimitReachedType: "rate_limit_reached", credits },
      }, accountId, Date.now())).toBeUndefined();
    }
  });
});

describe("earned Codex reset-credit recovery", () => {
  it("is disabled by default and never invokes consumption when disabled", async () => {
    const h = harness({ enabled: false });
    expect(await recoverWithEarnedCodexReset(h.options)).toEqual({ status: "disabled" });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.consume).not.toHaveBeenCalled();
  });

  it("uses an available account before claiming a credit", async () => {
    const h = harness({ firstAvailable: async () => "openai:second" });
    expect(await recoverWithEarnedCodexReset(h.options)).toEqual({ status: "available", profileId: "openai:second" });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.consume).not.toHaveBeenCalled();
  });

  it("spends at most one credit and requires a fresh authoritative recovery read", async () => {
    const h = harness();
    expect(await recoverWithEarnedCodexReset(h.options)).toEqual({ status: "restored", profileId: "openai:first" });
    expect(h.consume).toHaveBeenCalledOnce();
    expect(h.consume).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "openai:first",
      idempotencyKey: "key-one",
      creditId: "earned-credit",
    }));
    expect(h.readLimits).toHaveBeenCalledTimes(5);
    expect(h.settle).toHaveBeenCalledWith("openai:first", "attempt-one", "restored");
  });

  it("rechecks all allowed profiles after claiming and refrains if a peer recovered", async () => {
    const h = harness();
    h.firstAvailable.mockResolvedValueOnce(undefined).mockResolvedValueOnce("openai:second");
    expect(await recoverWithEarnedCodexReset(h.options)).toEqual({ status: "available", profileId: "openai:second" });
    expect(h.consume).not.toHaveBeenCalled();
  });

  it.each(["reset", "alreadyRedeemed", "nothingToReset", "noCredit"] as const)(
    "handles the official outcome %s without a second consumption",
    async (outcome) => {
      const h = harness({
        consume: async () => ({ outcome }),
        readLimits: vi.fn(async (id: string) => id === "openai:first" ? blocked(oneCredit) : blocked({ availableCount: 0, credits: [] })),
      });
      expect(await recoverWithEarnedCodexReset(h.options)).toEqual({ status: "not-restored", outcome });
      expect(h.options.readLimits).toHaveBeenCalledTimes(5);
    },
  );

  it("fails closed on timeout, unknown outcome, credential rotation and absent inventory", async () => {
    for (const overrides of [
      { consume: async () => { throw new Error("timeout"); } },
      { consume: async () => ({ outcome: "not-a-real-outcome" }) },
      { assertCurrent: async () => { throw new Error("credential changed"); } },
      { readLimits: async () => blocked(null) },
    ]) {
      const h = harness(overrides);
      const result = await recoverWithEarnedCodexReset(h.options);
      expect(["uncertain", "not-eligible"]).toContain(result.status);
      expect(h.settle).toHaveBeenCalledTimes(result.status === "not-eligible" ? 0 : 1);
    }
  });

  it("two independent concurrent callers sharing a mocked durable claim allow one consumption", async () => {
    let claimed = false;
    const claim = async () => {
      if (claimed) {
        return { status: "busy" as const };
      }
      claimed = true;
      return { status: "owned" as const, attemptId: "persisted", idempotencyKey: "same-key" };
    };
    const h = harness({ claim });
    const [first, second] = await Promise.all([
      recoverWithEarnedCodexReset(h.options),
      recoverWithEarnedCodexReset(h.options),
    ]);
    expect([first.status, second.status].sort()).toEqual(["busy", "restored"]);
    expect(h.consume).toHaveBeenCalledOnce();
  });

  it("refuses to spend if a later profile is still available despite a blocked first", async () => {
    const h = harness({
      readLimits: async (id: string) => id === "openai:second" ? recovered : blocked(oneCredit),
    });
    expect(await recoverWithEarnedCodexReset(h.options)).toEqual({
      status: "available",
      profileId: "openai:second",
    });
    expect(h.claim).not.toHaveBeenCalled();
  });

  it("rejects unbound native account identities before reserving a spend", async () => {
    const h = harness({ accountId: () => undefined });
    expect(await recoverWithEarnedCodexReset(h.options)).toEqual({
      status: "not-eligible",
    });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.consume).not.toHaveBeenCalled();
  });

  it("refuses to spend when any authorized profile has a non-quota failure", async () => {
    const h = harness({ isResettableBlocked: async (id: string) => id !== "openai:second" });
    expect(await recoverWithEarnedCodexReset(h.options)).toEqual({ status: "not-eligible" });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.consume).not.toHaveBeenCalled();
  });

  it("joins a bounded peer result, then revalidates the chain without a new spend", async () => {
    let reads = 0;
    const h = harness({
      claim: async () => ({ status: "busy" }),
      waitForPending: async () => "settled",
      readLimits: async (id: string) => {
        if (id === "openai:second") {
          return blocked({ availableCount: 0, credits: [] });
        }
        reads++;
        return reads === 1 ? blocked(oneCredit) : recovered;
      },
    });
    expect(await recoverWithEarnedCodexReset(h.options)).toEqual({
      status: "available", profileId: "openai:first",
    });
    expect(h.consume).not.toHaveBeenCalled();
  });

  it("selects the second authorized account if the first is exhausted without earned credits", async () => {
    let consumed = false;
    const h = harness({
      readLimits: async (id: string) =>
        id === "openai:first"
          ? blocked({ availableCount: 0, credits: [] })
          : consumed ? recovered : blocked(oneCredit),
      consume: async () => {
        consumed = true;
        return { outcome: "reset" };
      },
    });
    expect(await recoverWithEarnedCodexReset(h.options)).toEqual({
      status: "restored",
      profileId: "openai:second",
    });
    expect(h.claim).toHaveBeenCalledWith("openai:second", 1);
  });

  it("on a crash retry only permits the persisted idempotency key, never a new logical spend", async () => {
    let calls = 0;
    const keys: string[] = [];
    const h = harness({
      claim: async () => ({ status: "owned", attemptId: "durable-attempt", idempotencyKey: "original-key" }),
      consume: async (input: { idempotencyKey: string }) => {
        keys.push(input.idempotencyKey);
        calls++;
        if (calls === 1) {
          throw new Error("Gateway stopped after dispatch");
        }
        return { outcome: "alreadyRedeemed" };
      },
      readLimits: async (id: string) =>
        id === "openai:second" ? blocked({ availableCount: 0, credits: [] })
        : calls > 1 ? recovered : blocked(oneCredit),
    });
    expect(await recoverWithEarnedCodexReset(h.options)).toEqual({ status: "uncertain" });
    expect(await recoverWithEarnedCodexReset(h.options)).toEqual({
      status: "restored", profileId: "openai:first",
    });
    expect(keys).toEqual(["original-key", "original-key"]);
  });

  it("never widens the authorized account chain and fails closed on unavailable storage", async () => {
    const outside = harness({ firstAvailable: async () => "openai:outside" });
    expect(await recoverWithEarnedCodexReset(outside.options)).toEqual({ status: "uncertain" });
    expect(outside.consume).not.toHaveBeenCalled();

    const storage = harness({ claim: async () => { throw new Error("storage offline"); } });
    expect(await recoverWithEarnedCodexReset(storage.options)).toEqual({ status: "uncertain" });
    expect(storage.consume).not.toHaveBeenCalled();
  });

  it("refuses unavailable durable ownership, capped spending, and cancellation", async () => {
    const h = harness({ claim: async () => ({ status: "uncertain" as const }) });
    expect(await recoverWithEarnedCodexReset(h.options)).toEqual({ status: "uncertain" });
    expect(h.consume).not.toHaveBeenCalled();
    const capped = harness({ claim: async () => ({ status: "limit" as const }) });
    expect(await recoverWithEarnedCodexReset(capped.options)).toEqual({ status: "limit" });
    const controller = new AbortController();
    controller.abort();
    const cancelled = harness({ signal: controller.signal });
    expect(await recoverWithEarnedCodexReset(cancelled.options)).toEqual({ status: "not-eligible" });
    expect(cancelled.claim).not.toHaveBeenCalled();
  });
});
