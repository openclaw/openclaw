import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "./context.js";

const readStoreAllowFromForDmPolicyMock = vi.hoisted(() => vi.fn());
let clearSlackAllowFromCacheForTest: typeof import("./auth.js").clearSlackAllowFromCacheForTest;
let resolveSlackEffectiveAllowFrom: typeof import("./auth.js").resolveSlackEffectiveAllowFrom;

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>();
  return {
    ...actual,
    readStoreAllowFromForDmPolicy: (...args: unknown[]) =>
      readStoreAllowFromForDmPolicyMock(...args),
  };
});

function makeSlackCtx(allowFrom: string[]): SlackMonitorContext {
  return {
    allowFrom,
    accountId: "main",
    dmPolicy: "pairing",
  } as unknown as SlackMonitorContext;
}

describe("resolveSlackEffectiveAllowFrom", () => {
  const prevTtl = process.env.OPENCLAW_SLACK_PAIRING_ALLOWFROM_CACHE_TTL_MS;

  beforeEach(async () => {
    vi.resetModules();
    ({ clearSlackAllowFromCacheForTest, resolveSlackEffectiveAllowFrom } =
      await import("./auth.js"));
    readStoreAllowFromForDmPolicyMock.mockReset();
    clearSlackAllowFromCacheForTest();
    if (prevTtl === undefined) {
      delete process.env.OPENCLAW_SLACK_PAIRING_ALLOWFROM_CACHE_TTL_MS;
    } else {
      process.env.OPENCLAW_SLACK_PAIRING_ALLOWFROM_CACHE_TTL_MS = prevTtl;
    }
  });

  it("falls back to channel config allowFrom when pairing store throws", async () => {
    readStoreAllowFromForDmPolicyMock.mockRejectedValueOnce(new Error("boom"));

    const effective = await resolveSlackEffectiveAllowFrom(makeSlackCtx(["u1"]));

    expect(effective.allowFrom).toEqual(["u1"]);
    expect(effective.allowFromLower).toEqual(["u1"]);
  });

  it("treats malformed non-array pairing-store responses as empty", async () => {
    readStoreAllowFromForDmPolicyMock.mockReturnValueOnce(undefined);

    const effective = await resolveSlackEffectiveAllowFrom(makeSlackCtx(["u1"]));

    expect(effective.allowFrom).toEqual(["u1"]);
    expect(effective.allowFromLower).toEqual(["u1"]);
  });

  it("memoizes pairing-store allowFrom reads within TTL", async () => {
    readStoreAllowFromForDmPolicyMock.mockResolvedValue(["u2"]);
    const ctx = makeSlackCtx(["u1"]);

    const first = await resolveSlackEffectiveAllowFrom(ctx, { includePairingStore: true });
    const second = await resolveSlackEffectiveAllowFrom(ctx, { includePairingStore: true });

    expect(first.allowFrom).toEqual(["u1", "u2"]);
    expect(second.allowFrom).toEqual(["u1", "u2"]);
    expect(readStoreAllowFromForDmPolicyMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes pairing-store allowFrom when cache TTL is zero", async () => {
    process.env.OPENCLAW_SLACK_PAIRING_ALLOWFROM_CACHE_TTL_MS = "0";
    readStoreAllowFromForDmPolicyMock.mockResolvedValue(["u2"]);
    const ctx = makeSlackCtx(["u1"]);

    await resolveSlackEffectiveAllowFrom(ctx, { includePairingStore: true });
    await resolveSlackEffectiveAllowFrom(ctx, { includePairingStore: true });

    expect(readStoreAllowFromForDmPolicyMock).toHaveBeenCalledTimes(2);
  });
});
