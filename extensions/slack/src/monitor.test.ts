// Slack tests cover monitor plugin behavior.
import { describe, expect, it } from "vitest";
import { buildSlackSlashCommandMatcher } from "./monitor/commands.js";
import { isSlackChannelAllowedByPolicy } from "./monitor/policy.js";

describe("slack groupPolicy gating", () => {
  it.each([
    ["open", false, false, true],
    ["disabled", true, true, false],
    ["allowlist", false, true, false],
    ["allowlist", true, true, true],
    ["allowlist", true, false, false],
  ] as const)(
    "%s policy with configured=%s, allowed=%s permits=%s",
    (groupPolicy, channelAllowlistConfigured, channelAllowed, expected) => {
      expect(
        isSlackChannelAllowedByPolicy({
          groupPolicy,
          channelAllowlistConfigured,
          channelAllowed,
        }),
      ).toBe(expected);
    },
  );
});

describe("buildSlackSlashCommandMatcher", () => {
  it("matches with or without a leading slash", () => {
    const matcher = buildSlackSlashCommandMatcher("openclaw");

    expect(matcher.test("openclaw")).toBe(true);
    expect(matcher.test("/openclaw")).toBe(true);
  });

  it("does not match similar names", () => {
    const matcher = buildSlackSlashCommandMatcher("openclaw");

    expect(matcher.test("/openclaw-bot")).toBe(false);
    expect(matcher.test("openclaw-bot")).toBe(false);
  });
});
