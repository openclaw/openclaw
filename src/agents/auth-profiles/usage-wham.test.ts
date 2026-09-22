import { describe, expect, it } from "vitest";
import { classifyWhamUsage, type WhamUsage } from "./usage-wham.js";

const now = 1_700_000_000_000;

// Observed shape for a Pro account whose weekly window is exhausted while
// purchased credits keep serving requests.
const exhaustedWeeklyWindow: WhamUsage["rate_limit"] = {
  limit_reached: true,
  primary_window: { used_percent: 100, reset_after_seconds: 363_981 },
  secondary_window: null,
};
const purchasedCredits = { has_credits: true, unlimited: false, overage_limit_reached: false };

describe("classifyWhamUsage", () => {
  it("keeps the profile available when the included window is not exhausted", () => {
    expect(
      classifyWhamUsage(
        {
          rate_limit: {
            limit_reached: false,
            primary_window: { used_percent: 45, reset_after_seconds: 9_000 },
          },
        },
        now,
      ),
    ).toEqual({ available: true, cooldownMs: 15_000 });
  });

  it("blocks until the reset when the window is exhausted and no credits remain", () => {
    expect(classifyWhamUsage({ rate_limit: exhaustedWeeklyWindow }, now)).toEqual({
      cooldownMs: 15_000,
      blockedUntil: now + 363_981_000,
    });
  });

  it.each([
    { label: "purchased credits", credits: purchasedCredits },
    { label: "unlimited credits", credits: { has_credits: true, unlimited: true } },
    { label: "purchased credits and no reached type", credits: purchasedCredits, untyped: true },
  ])(
    "keeps the profile available when $label cover an exhausted window",
    ({ credits, untyped }) => {
      expect(
        classifyWhamUsage(
          {
            rate_limit: exhaustedWeeklyWindow,
            credits,
            spend_control: { reached: false },
            ...(untyped ? {} : { rate_limit_reached_type: { type: "rate_limit_reached" } }),
          },
          now,
        ),
      ).toEqual({ available: true, cooldownMs: 15_000 });
    },
  );

  it.each([
    { label: "the payload has no credits object", credits: undefined },
    { label: "no credits were purchased", credits: { has_credits: false, unlimited: false } },
    {
      label: "the overage cap is reached",
      credits: { ...purchasedCredits, overage_limit_reached: true },
    },
    {
      label: "workspace owner credits are depleted",
      credits: purchasedCredits,
      reachedType: "workspace_owner_credits_depleted" as const,
    },
    {
      label: "workspace member credits are depleted",
      credits: purchasedCredits,
      reachedType: "workspace_member_credits_depleted" as const,
    },
    {
      label: "the workspace owner usage cap is reached",
      credits: purchasedCredits,
      reachedType: "workspace_owner_usage_limit_reached" as const,
    },
    {
      label: "a workspace member usage cap is reached",
      credits: purchasedCredits,
      reachedType: "workspace_member_usage_limit_reached" as const,
    },
    {
      label: "the reached type is unknown",
      credits: purchasedCredits,
      reachedType: "unknown" as const,
    },
  ])("still blocks until the reset when $label", ({ credits, reachedType }) => {
    expect(
      classifyWhamUsage(
        {
          rate_limit: exhaustedWeeklyWindow,
          ...(credits ? { credits } : {}),
          rate_limit_reached_type: { type: reachedType ?? "rate_limit_reached" },
        },
        now,
      ),
    ).toEqual({ cooldownMs: 15_000, blockedUntil: now + 363_981_000 });
  });

  it("does not let credits override a reached spend control", () => {
    expect(
      classifyWhamUsage(
        {
          rate_limit: exhaustedWeeklyWindow,
          credits: purchasedCredits,
          spend_control: { reached: true },
        },
        now,
      ),
    ).toEqual({ cooldownMs: 30_000 });
  });
});
