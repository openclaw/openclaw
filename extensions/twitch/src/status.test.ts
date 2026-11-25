import { describe, expect, it } from "vitest";
import { twitchPlugin } from "./plugin.js";
import type { ChannelAccountSnapshot } from "./types.js";

const collectTwitchStatusIssues = twitchPlugin.status!.collectStatusIssues!;

function collect(overrides: Partial<ChannelAccountSnapshot>) {
  return collectTwitchStatusIssues([
    {
      accountId: "default",
      configured: true,
      enabled: true,
      running: false,
      ...overrides,
    },
  ]);
}

type Issue = ReturnType<typeof collectTwitchStatusIssues>[number];
const issue = (
  kind: Issue["kind"],
  message: string,
  fix: string,
  accountId = "default",
): Issue => ({ channel: "twitch", accountId, kind, message, fix });

describe("status", () => {
  it("should detect disabled accounts", () => {
    expect(collect({ enabled: false })).toEqual([
      issue(
        "config",
        "Twitch account is disabled",
        "Set enabled: true in your account configuration to enable this account",
      ),
    ]);
  });

  it("should detect runtime errors", () => {
    expect(collect({ lastError: "Connection timeout" })).toEqual([
      issue(
        "runtime",
        "Last error: Connection timeout",
        "Check your token validity and network connection. Check that the bot has the required OAuth scopes.",
      ),
      issue(
        "runtime",
        "Account has never connected successfully",
        "Start the Twitch gateway to begin receiving messages. Check logs for connection errors.",
      ),
    ]);
  });

  it("should detect long-running connections", () => {
    expect(collect({ running: true, lastStartAt: Date.now() - 8 * 24 * 60 * 60 * 1000 })).toEqual([
      issue(
        "runtime",
        "Connection has been running for 8 days",
        "Consider restarting the connection periodically to refresh the connection. Twitch tokens may expire after long periods.",
      ),
    ]);
  });

  it("reports an unconfigured account by its account ID", () => {
    expect(collect({ accountId: "unknown", configured: false })).toEqual([
      issue(
        "config",
        "Twitch account is not properly configured",
        "Add required fields: username, accessToken, and clientId to your account configuration",
        "unknown",
      ),
    ]);
  });
});
