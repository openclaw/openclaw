// Slack tests cover targets plugin behavior.
import { describe, expect, it } from "vitest";
import {
  normalizeSlackMessagingTarget,
  parseSlackTarget,
  resolveSlackChannelId,
  slackContextTargetsMatch,
  slackTargetsMatch,
} from "./targets.js";

describe("parseSlackTarget", () => {
  it("parses user mentions and prefixes", () => {
    const cases = [
      { input: "<@U123>", id: "U123", normalized: "user:u123" },
      { input: "user:U456", id: "U456", normalized: "user:u456" },
      { input: "slack:U789", id: "U789", normalized: "user:u789" },
    ] as const;
    for (const testCase of cases) {
      expect(parseSlackTarget(testCase.input), testCase.input).toEqual({
        kind: "user",
        id: testCase.id,
        raw: testCase.input,
        normalized: testCase.normalized,
      });
    }
  });

  it("parses channel targets", () => {
    const cases = [
      { input: "channel:C123", id: "C123", normalized: "channel:c123" },
      { input: "#C999", id: "C999", normalized: "channel:c999" },
    ] as const;
    for (const testCase of cases) {
      expect(parseSlackTarget(testCase.input), testCase.input).toEqual({
        kind: "channel",
        id: testCase.id,
        raw: testCase.input,
        normalized: testCase.normalized,
      });
    }
  });

  it("rejects invalid @ and # targets", () => {
    const cases = [
      { input: "@bob-1", expectedMessage: /Slack DMs require a user id/ },
      { input: "#general-1", expectedMessage: /Slack channels require a channel id/ },
    ] as const;
    for (const testCase of cases) {
      expect(() => parseSlackTarget(testCase.input), testCase.input).toThrow(
        testCase.expectedMessage,
      );
    }
  });
});

describe("resolveSlackChannelId", () => {
  it("strips channel: prefix and accepts raw ids", () => {
    expect(resolveSlackChannelId("channel:C123")).toBe("C123");
    expect(resolveSlackChannelId("C123")).toBe("C123");
  });

  it("rejects user targets", () => {
    expect(() => resolveSlackChannelId("user:U123")).toThrow(/channel id is required/i);
  });
});

describe("normalizeSlackMessagingTarget", () => {
  it("defaults raw ids to channels", () => {
    expect(normalizeSlackMessagingTarget("C123")).toBe("channel:c123");
  });
});

describe("slackTargetsMatch", () => {
  it("matches equivalent channel and user targets", () => {
    expect(slackTargetsMatch("channel:C123", "C123")).toBe(true);
    expect(slackTargetsMatch("user:U123", "slack:U123")).toBe(true);
  });

  it("does not match different target kinds", () => {
    expect(slackTargetsMatch("user:U123", "channel:U123")).toBe(false);
  });
});

describe("slackContextTargetsMatch", () => {
  it("matches resolved bare user ids against the routable DM target", () => {
    const context = {
      currentChannelId: "D123",
      currentMessagingTarget: "user:U123",
    };

    expect(slackContextTargetsMatch("U123", context)).toBe(true);
    expect(
      slackContextTargetsMatch("W123", {
        ...context,
        currentMessagingTarget: "user:W123",
      }),
    ).toBe(true);
    expect(slackContextTargetsMatch("U999", context)).toBe(false);
    expect(slackContextTargetsMatch("C123", context)).toBe(false);
  });
});
