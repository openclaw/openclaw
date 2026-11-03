import { describe, expect, it, vi } from "vitest";
import {
  chooseEarnedCodexResetCredit,
  recoverWithEarnedCodexReset,
} from "./reset-credit-recovery.js";

const accountId = "account-one";
const blocked = (credits: unknown = { availableCount: 1, credits: null }) => ({
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
  const consume = vi.fn(async () => ({ outcome: "reset" as const }));
  const readLimits = vi.fn().mockResolvedValueOnce(blocked(oneCredit)).mockResolvedValue(recovered);
  const firstAvailable = vi.fn().mockResolvedValue(undefined);
  const assertCurrent = vi.fn(async () => {});
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

  it("selects known valid details but does not confuse expired or capped details with count", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    expect(chooseEarnedCodexResetCredit(blocked({
      availableCount: 3,
      credits: [
        { id: "expired", resetType: "codexRateLimits", status: "available", expiresAt: past },
        { id: "good", resetType: "codexRateLimits", status: "available", expiresAt: null },
      ],
    }), accountId, Date.now())).toEqual({ creditId: "good" });
    expect(chooseEarnedCodexResetCredit(blocked({
      availableCount: 3,
      credits: [{ id: "expired", resetType: "codexRateLimits", status: "available", expiresAt: past }],
    }), accountId, Date.now())).toEqual({});
    expect(chooseEarnedCodexResetCredit(blocked({ availableCount: 3, credits: null }), accountId, Date.now())).toEqual({});
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
    expect(h.readLimits).toHaveBeenCalledTimes(2);
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
        readLimits: vi.fn().mockResolvedValueOnce(blocked(oneCredit)).mockResolvedValue(blocked(oneCredit)),
      });
      expect(await recoverWithEarnedCodexReset(h.options)).toEqual({ status: "not-restored", outcome });
      expect(h.options.readLimits).toHaveBeenCalledTimes(
        outcome === "reset" || outcome === "alreadyRedeemed" ? 2 : 1,
      );
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
      expect(h.settle).toHaveBeenCalledOnce();
    }
  });

  it("a shared durable claim allows only one of two simultaneous processes to consume", async () => {
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
