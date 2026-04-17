import { describe, expect, it } from "vitest";
import {
  looksLikeSlackTargetId,
  normalizeSlackMessagingTarget,
  parseSlackTarget,
  resolveSlackChannelId,
} from "./targets.js";

describe("parseSlackTarget", () => {
  it("parses user mentions and prefixes", () => {
    const cases = [
      { input: "<@U123>", id: "U123", normalized: "user:u123" },
      { input: "user:U456", id: "U456", normalized: "user:u456" },
      { input: "slack:U789", id: "U789", normalized: "user:u789" },
    ] as const;
    for (const testCase of cases) {
      expect(parseSlackTarget(testCase.input), testCase.input).toMatchObject({
        kind: "user",
        id: testCase.id,
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
      expect(parseSlackTarget(testCase.input), testCase.input).toMatchObject({
        kind: "channel",
        id: testCase.id,
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

  it("returns undefined for empty or whitespace-only input", () => {
    expect(parseSlackTarget("")).toBeUndefined();
    expect(parseSlackTarget("   ")).toBeUndefined();
    expect(parseSlackTarget("\t\n")).toBeUndefined();
  });

  it("falls back to channel kind for a bare id when no defaultKind is given", () => {
    expect(parseSlackTarget("C123")).toMatchObject({
      kind: "channel",
      id: "C123",
      normalized: "channel:c123",
    });
  });

  it("honors defaultKind: user for a bare id", () => {
    expect(parseSlackTarget("U999", { defaultKind: "user" })).toMatchObject({
      kind: "user",
      id: "U999",
      normalized: "user:u999",
    });
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

  it("returns undefined for empty input", () => {
    expect(normalizeSlackMessagingTarget("")).toBeUndefined();
    expect(normalizeSlackMessagingTarget("   ")).toBeUndefined();
  });
});

describe("looksLikeSlackTargetId", () => {
  it("recognizes mention syntax", () => {
    expect(looksLikeSlackTargetId("<@U123>")).toBe(true);
    expect(looksLikeSlackTargetId("<@u123>")).toBe(true);
  });

  it("recognizes user: and channel: prefixes", () => {
    expect(looksLikeSlackTargetId("user:U123")).toBe(true);
    expect(looksLikeSlackTargetId("channel:C123")).toBe(true);
    expect(looksLikeSlackTargetId("USER:u123")).toBe(true);
  });

  it("recognizes the slack: prefix", () => {
    expect(looksLikeSlackTargetId("slack:U123")).toBe(true);
    expect(looksLikeSlackTargetId("SLACK:u123")).toBe(true);
  });

  it("recognizes @-prefixed and #-prefixed strings", () => {
    expect(looksLikeSlackTargetId("@U123")).toBe(true);
    expect(looksLikeSlackTargetId("#C123")).toBe(true);
  });

  it("recognizes raw Slack ID patterns for each valid leading letter", () => {
    for (const id of ["C12345678", "U12345678", "W12345678", "G12345678", "D12345678"]) {
      expect(looksLikeSlackTargetId(id), id).toBe(true);
    }
  });

  it("returns false for empty input", () => {
    expect(looksLikeSlackTargetId("")).toBe(false);
    expect(looksLikeSlackTargetId("   ")).toBe(false);
  });

  it("returns false for strings that do not match any recognized pattern", () => {
    expect(looksLikeSlackTargetId("not-an-id")).toBe(false);
    expect(looksLikeSlackTargetId("bob")).toBe(false);
    // Leading letter outside CUWGD — Slack IDs always start with one of those.
    expect(looksLikeSlackTargetId("A12345678")).toBe(false);
    // Too short to be a valid Slack ID (needs 8 trailing chars after the leading letter).
    expect(looksLikeSlackTargetId("C1234")).toBe(false);
  });
});
