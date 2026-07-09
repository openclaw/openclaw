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
  it("preserves original case of channel ids", () => {
    expect(normalizeSlackMessagingTarget("C123")).toBe("channel:C123");
    expect(normalizeSlackMessagingTarget("c123")).toBe("channel:c123");
    expect(normalizeSlackMessagingTarget("C08GQH53EJM")).toBe("channel:C08GQH53EJM");
  });

  it("preserves original case of user ids", () => {
    expect(normalizeSlackMessagingTarget("user:U123")).toBe("user:U123");
    expect(normalizeSlackMessagingTarget("user:u123")).toBe("user:u123");
    expect(normalizeSlackMessagingTarget("U123")).toBe("channel:U123");
  });

  it("preserves case for slack: prefixed targets", () => {
    expect(normalizeSlackMessagingTarget("slack:U123")).toBe("user:U123");
    expect(normalizeSlackMessagingTarget("slack:u123")).toBe("user:u123");
  });

  it("preserves case for # prefixed channel targets", () => {
    expect(normalizeSlackMessagingTarget("#C123")).toBe("channel:C123");
    expect(normalizeSlackMessagingTarget("#c123")).toBe("channel:c123");
  });
});

describe("slackTargetsMatch", () => {
  it("matches equivalent channel and user targets", () => {
    expect(slackTargetsMatch("channel:C123", "C123")).toBe(true);
    expect(slackTargetsMatch("user:U123", "slack:U123")).toBe(true);
  });

  it("matches case-insensitively for mixed-case inputs", () => {
    // Lowercase bare id should match uppercase channel:
    expect(slackTargetsMatch("channel:C123", "c123")).toBe(true);
    // Uppercase bare id should match lowercase channel:
    expect(slackTargetsMatch("channel:c123", "C123")).toBe(true);
    // User targets with different case:
    expect(slackTargetsMatch("user:U123", "slack:u123")).toBe(true);
    expect(slackTargetsMatch("user:u123", "slack:U123")).toBe(true);
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

  it("matches context targets case-insensitively", () => {
    // Channel ID in different case:
    expect(
      slackContextTargetsMatch("c123", {
        currentChannelId: "C123",
        currentMessagingTarget: "user:U123",
      }),
    ).toBe(true);
    expect(
      slackContextTargetsMatch("C123", {
        currentChannelId: "c123",
        currentMessagingTarget: "user:U123",
      }),
    ).toBe(true);
    // Messaging target in different case:
    expect(
      slackContextTargetsMatch("u123", {
        currentChannelId: "D123",
        currentMessagingTarget: "user:U123",
      }),
    ).toBe(true);
    expect(
      slackContextTargetsMatch("U123", {
        currentChannelId: "D123",
        currentMessagingTarget: "user:u123",
      }),
    ).toBe(true);
  });
});

describe("resolver-to-action channelId path", () => {
  it("preserves channel ID case through the full normalization-to-action pipeline", () => {
    // This simulates the flow when the outbound target resolver falls through
    // to buildNormalizedResolveResult using normalizeTargetForProvider, which
    // calls normalizeSlackMessagingTarget. The normalized form is then passed
    // to handleSlackMessageAction's resolveChannelId which calls
    // resolveSlackChannelId, and the result goes to the Slack Web API.

    const rawId = "C08GQH53EJM";

    // Step 1: normalizeSlackMessagingTarget produces the normalized form
    // with case preserved (the return value of the Slack plugin's normalizeTarget callback)
    const normalized = normalizeSlackMessagingTarget(rawId);
    expect(normalized).toBe("channel:C08GQH53EJM");

    // Step 2: sanitizeGroupTargetId strips the channel: prefix
    // (this is what resolveActionTarget does in the core message-action-runner)
    const sanitizeId = (target: string) => target.replace(/^(channel|group):/i, "");
    const stripped = sanitizeId(normalized);
    expect(stripped).toBe("C08GQH53EJM");

    // Step 3: resolveSlackChannelId is what handleSlackMessageAction's
    // resolveChannelId calls to extract the channel ID for Slack API calls
    const channelId = resolveSlackChannelId(normalized);
    expect(channelId).toBe("C08GQH53EJM");

    // Step 4: Direct resolveSlackChannelId with the bare channel ID
    // (used when the LLM provides channelId directly)
    const directChannelId = resolveSlackChannelId(rawId);
    expect(directChannelId).toBe("C08GQH53EJM");
  });

  it("preserves channel ID case for lowercase inputs through the full pipeline", () => {
    // Even when the LLM provides a lowercase channel ID, the pipeline
    // preserves it faithfully (the fix is about not LOSING case, not about forcing it)
    // The Slack API will reject it, but that's an LLM issue, not a code bug

    const rawId = "c08gqh53ejm";

    const normalized = normalizeSlackMessagingTarget(rawId);
    expect(normalized).toBe("channel:c08gqh53ejm");

    const sanitizeId = (target: string) => target.replace(/^(channel|group):/i, "");
    const stripped = sanitizeId(normalized);
    expect(stripped).toBe("c08gqh53ejm");

    const channelId = resolveSlackChannelId(normalized);
    expect(channelId).toBe("c08gqh53ejm");
  });

  it("preserves channel ID case for pre-prefixed inputs", () => {
    // When the LLM provides channel:C123 format

    const rawId = "channel:C123";

    const normalized = normalizeSlackMessagingTarget(rawId);
    expect(normalized).toBe("channel:C123");

    const channelId = resolveSlackChannelId(rawId);
    expect(channelId).toBe("C123");
  });

  it("preserves case when the normalized form is used as a comparison key", () => {
    // Lowercase input matches uppercase input through slackTargetsMatch
    expect(slackTargetsMatch("channel:C08GQH53EJM", "channel:c08gqh53ejm")).toBe(true);
    expect(slackTargetsMatch("channel:C08GQH53EJM", "c08gqh53ejm")).toBe(true);
    expect(slackTargetsMatch("C08GQH53EJM", "channel:c08gqh53ejm")).toBe(true);
  });
});
