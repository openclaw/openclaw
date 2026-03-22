import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { describe, expect, it } from "vitest";
import { collectTelegramStatusIssues } from "./status-issues.js";

describe("collectTelegramStatusIssues", () => {
  it("reports privacy-mode and wildcard unmentioned-group configuration risks", () => {
    const issues = collectTelegramStatusIssues([
      {
        accountId: "main",
        enabled: true,
        configured: true,
        allowUnmentionedGroups: true,
        audit: {
          hasWildcardUnmentionedGroups: true,
          unresolvedGroups: 2,
        },
      } as ChannelAccountSnapshot,
    ]);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "telegram",
          accountId: "main",
          kind: "config",
        }),
      ]),
    );
    expect(issues.some((issue) => issue.message.includes("privacy mode"))).toBe(true);
    expect(issues.some((issue) => issue.message.includes('uses "*"'))).toBe(true);
    expect(issues.some((issue) => issue.message.includes("unresolvedGroups=2"))).toBe(true);
  });

  it("reports unreachable groups with match metadata", () => {
    const issues = collectTelegramStatusIssues([
      {
        accountId: "main",
        enabled: true,
        configured: true,
        audit: {
          groups: [
            {
              chatId: "-100123",
              ok: false,
              status: "left",
              error: "403",
              matchKey: "alerts",
              matchSource: "channels.telegram.groups",
            },
          ],
        },
      } as ChannelAccountSnapshot,
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      channel: "telegram",
      accountId: "main",
      kind: "runtime",
    });
    expect(issues[0]?.message).toContain("Group -100123 not reachable");
    expect(issues[0]?.message).toContain("alerts");
    expect(issues[0]?.message).toContain("channels.telegram.groups");
  });

  it("ignores accounts that are not both enabled and configured", () => {
    expect(
      collectTelegramStatusIssues([
        {
          accountId: "main",
          enabled: false,
          configured: true,
        } as ChannelAccountSnapshot,
      ]),
    ).toEqual([]);
  });
});
