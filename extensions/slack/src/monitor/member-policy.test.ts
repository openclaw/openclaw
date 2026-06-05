// Slack tests cover workspace member policy behavior.
import { describe, expect, it } from "vitest";
import type { SlackMonitorContext } from "./context.js";
import { authorizeSlackMemberPolicy } from "./member-policy.js";

function ctx(
  memberPolicy: SlackMonitorContext["memberPolicy"],
  user: Awaited<ReturnType<SlackMonitorContext["resolveUserAccess"]>>,
): SlackMonitorContext {
  return {
    teamId: "T123",
    memberPolicy,
    resolveUserAccess: async () => user,
  } as SlackMonitorContext;
}

describe("slack member policy", () => {
  it("allows by default when policy is disabled", async () => {
    await expect(
      authorizeSlackMemberPolicy({
        ctx: ctx(undefined, { teamId: "T999", isRestricted: true }),
        senderId: "U123",
      }),
    ).resolves.toEqual({ allowed: true });
  });

  it("allows full workspace members", async () => {
    await expect(
      authorizeSlackMemberPolicy({
        ctx: ctx(
          { enabled: true },
          {
            teamId: "T123",
            deleted: false,
            isBot: false,
            isRestricted: false,
            isUltraRestricted: false,
            isStranger: false,
          },
        ),
        senderId: "U123",
      }),
    ).resolves.toEqual({ allowed: true });
  });

  it("denies guests, externals, bots, deleted users, and team mismatches", async () => {
    const cases: Array<{
      user: Awaited<ReturnType<SlackMonitorContext["resolveUserAccess"]>>;
      reason: string;
    }> = [
      { user: { teamId: "T123", isRestricted: true }, reason: "guest-user" },
      { user: { teamId: "T123", isUltraRestricted: true }, reason: "guest-user" },
      { user: { teamId: "T123", isStranger: true }, reason: "external-user" },
      { user: { teamId: "T123", isBot: true }, reason: "bot-user" },
      { user: { teamId: "T123", deleted: true }, reason: "deleted-user" },
      { user: { teamId: "T999" }, reason: "team-mismatch" },
    ];

    for (const entry of cases) {
      await expect(
        authorizeSlackMemberPolicy({
          ctx: ctx({ enabled: true }, entry.user),
          senderId: "U123",
        }),
      ).resolves.toEqual({ allowed: false, reason: entry.reason });
    }
  });

  it("fails closed when enabled and user lookup fails", async () => {
    const failingCtx = {
      teamId: "T123",
      memberPolicy: { enabled: true },
      resolveUserAccess: async () => {
        throw new Error("rate limited");
      },
    } as SlackMonitorContext;

    const decision = await authorizeSlackMemberPolicy({
      ctx: failingCtx,
      senderId: "U123",
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("user-lookup-failed");
    }
  });
});
