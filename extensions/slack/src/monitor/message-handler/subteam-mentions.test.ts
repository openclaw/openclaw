import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { isSlackSubteamMentionForBot } from "./subteam-mentions.js";

function createLookup(users: string[]) {
  const list = vi.fn(async (_options: { usergroup: string; team_id?: string }) => ({
    ok: true,
    users,
  }));
  const client = {
    usergroups: { users: { list } },
  } as unknown as WebClient;
  return {
    list,
    mention: (overrides: Partial<Parameters<typeof isSlackSubteamMentionForBot>[0]> = {}) =>
      isSlackSubteamMentionForBot({
        client,
        text: "<!subteam^S123> ping",
        botUserId: "U_BOT",
        ...overrides,
      }),
  };
}

describe("Slack subteam mentions", () => {
  it("matches when the bot user is a member of a mentioned user group", async () => {
    const { mention, list } = createLookup(["U_OTHER", "U_BOT"]);

    await expect(
      mention({ text: "<!subteam^S123|eng> ping", botUserId: "u_bot", teamId: "T1", now: 1 }),
    ).resolves.toBe(true);
    expect(list).toHaveBeenCalledWith({ usergroup: "S123", team_id: "T1" });
  });

  it("fails closed and caches successful membership lookups", async () => {
    const { mention, list } = createLookup(["U_OTHER"]);
    await expect(mention({ now: 1 })).resolves.toBe(false);
    await expect(mention({ text: "<!subteam^S123> ping again", now: 2 })).resolves.toBe(false);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("fails closed when Slack rejects the user-group lookup", async () => {
    const log = vi.fn();
    const { mention, list } = createLookup([]);
    list.mockRejectedValueOnce(new Error("missing_scope"));

    await expect(mention({ log })).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(
      "slack: failed to resolve user-group mention S123: missing_scope",
    );
  });

  it.each(["nonmember", "rejected", "not-ok"] as const)(
    "finds a later matching group after a %s result and on cached lookup",
    async (firstResult) => {
      const { mention, list } = createLookup([]);
      list.mockImplementation(async ({ usergroup }) => {
        if (usergroup === "S123") {
          if (firstResult === "rejected") {
            throw new Error("missing_scope");
          }
          return { ok: firstResult !== "not-ok", users: ["U_OTHER"] };
        }
        return { ok: true, users: ["U_BOT"] };
      });
      const text = "<!subteam^S123> <!subteam^S456> ping";

      await expect(mention({ text, now: 1 })).resolves.toBe(true);
      await expect(mention({ text, now: 2 })).resolves.toBe(true);
      expect(list.mock.calls.map(([options]) => options.usergroup)).toEqual(
        firstResult === "nonmember" ? ["S123", "S456"] : ["S123", "S456", "S123"],
      );
    },
  );
});
