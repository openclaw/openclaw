import { describe, expect, it } from "vitest";
import { collectTwitchStatusIssues } from "./status.js";
import type { ChannelAccountSnapshot } from "./types.js";

function createSnapshot(overrides: Partial<ChannelAccountSnapshot> = {}): ChannelAccountSnapshot {
  return {
    accountId: "default",
    configured: true,
    enabled: true,
    running: false,
    ...overrides,
  };
}

function expectSingleIssue(
  issues: ReturnType<typeof collectTwitchStatusIssues>,
  expected: ReturnType<typeof collectTwitchStatusIssues>[number],
): void {
  expect(issues).toEqual([expected]);
}

function expectIssues(
  issues: ReturnType<typeof collectTwitchStatusIssues>,
  expected: ReturnType<typeof collectTwitchStatusIssues>,
): void {
  expect(issues).toEqual(expected);
}

function neverConnectedIssue(): ReturnType<typeof collectTwitchStatusIssues>[number] {
  return {
    channel: "twitch",
    accountId: "default",
    kind: "runtime",
    message: "Account has never connected successfully",
    fix: "Start the Twitch gateway to begin receiving messages. Check logs for connection errors.",
  };
}

describe("status", () => {
  describe("collectTwitchStatusIssues", () => {
    it("should detect unconfigured accounts", () => {
      const snapshots: ChannelAccountSnapshot[] = [createSnapshot({ configured: false })];

      const issues = collectTwitchStatusIssues(snapshots);

      expectSingleIssue(issues, {
        channel: "twitch",
        accountId: "default",
        kind: "config",
        message: "Twitch account is not properly configured",
        fix: "Add required fields: username, accessToken, and clientId to your account configuration",
      });
    });

    it("should detect disabled accounts", () => {
      const snapshots: ChannelAccountSnapshot[] = [createSnapshot({ enabled: false })];

      const issues = collectTwitchStatusIssues(snapshots);

      expectSingleIssue(issues, {
        channel: "twitch",
        accountId: "default",
        kind: "config",
        message: "Twitch account is disabled",
        fix: "Set enabled: true in your account configuration to enable this account",
      });
    });

    it("should detect runtime errors", () => {
      const snapshots: ChannelAccountSnapshot[] = [
        createSnapshot({ lastError: "Connection timeout" }),
      ];

      const issues = collectTwitchStatusIssues(snapshots);

      expectIssues(issues, [
        {
          channel: "twitch",
          accountId: "default",
          kind: "runtime",
          message: "Last error: Connection timeout",
          fix: "Check your token validity and network connection. Check that the bot has the required OAuth scopes.",
        },
        neverConnectedIssue(),
      ]);
    });

    it("should detect accounts that never connected", () => {
      const snapshots: ChannelAccountSnapshot[] = [
        createSnapshot({
          lastStartAt: undefined,
          lastInboundAt: undefined,
          lastOutboundAt: undefined,
        }),
      ];

      const issues = collectTwitchStatusIssues(snapshots);

      expectSingleIssue(issues, {
        channel: "twitch",
        accountId: "default",
        kind: "runtime",
        message: "Account has never connected successfully",
        fix: "Start the Twitch gateway to begin receiving messages. Check logs for connection errors.",
      });
    });

    it("should detect long-running connections", () => {
      const oldDate = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago

      const snapshots: ChannelAccountSnapshot[] = [
        createSnapshot({
          running: true,
          lastStartAt: oldDate,
        }),
      ];

      const issues = collectTwitchStatusIssues(snapshots);

      expectSingleIssue(issues, {
        channel: "twitch",
        accountId: "default",
        kind: "runtime",
        message: "Connection has been running for 8 days",
        fix: "Consider restarting the connection periodically to refresh the connection. Twitch tokens may expire after long periods.",
      });
    });

    it("should handle empty snapshots array", () => {
      const issues = collectTwitchStatusIssues([]);

      expect(issues).toStrictEqual([]);
    });

    it("should skip non-Twitch accounts gracefully", () => {
      const snapshots: ChannelAccountSnapshot[] = [
        {
          accountId: "unknown",
          configured: false,
          enabled: true,
          running: false,
        },
      ];

      const issues = collectTwitchStatusIssues(snapshots);

      expectSingleIssue(issues, {
        channel: "twitch",
        accountId: "unknown",
        kind: "config",
        message: "Twitch account is not properly configured",
        fix: "Add required fields: username, accessToken, and clientId to your account configuration",
      });
    });
  });
});
