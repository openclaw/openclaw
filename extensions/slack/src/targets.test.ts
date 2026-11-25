// Slack tests cover targets plugin behavior.
import { describe, expect, it } from "vitest";
import {
  canonicalizeSlackApiTargetId,
  formatSlackTarget,
  slackTargetsMatch,
} from "./target-parsing.js";
import { parseSlackTarget, resolveSlackChannelId, slackContextTargetsMatch } from "./targets.js";

describe("parseSlackTarget", () => {
  it("parses channel targets", () => {
    const cases = [
      { input: "channel:C123", id: "C123", normalized: "channel:c123" },
      { input: "#C999", id: "C999", normalized: "channel:c999" },
      { input: "updates", id: "updates", normalized: "channel:updates" },
      { input: "workspace", id: "workspace", normalized: "channel:workspace" },
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

  it("formats bare and structurally valid workspace-qualified targets", () => {
    expect(formatSlackTarget({ teamId: "T123", kind: "channel", id: "C456" })).toBe(
      "team:T123:channel:C456",
    );
    expect(formatSlackTarget({ kind: "channel", id: "C456" })).toBe("C456");
    expect(formatSlackTarget({ teamId: "T123", kind: "user", id: "B456" })).toBe(
      "team:T123:user:B456",
    );
    expect(() => formatSlackTarget({ teamId: "E123", kind: "channel", id: "C456" })).toThrow(
      "Invalid Slack workspace-qualified target",
    );
  });
});

describe("resolveSlackChannelId", () => {
  it("strips channel: prefix and accepts raw ids", () => {
    expect(resolveSlackChannelId("channel:C123")).toBe("C123");
    expect(resolveSlackChannelId("C123")).toBe("C123");
  });

  it("preserves an explicit channel name", () => {
    expect(resolveSlackChannelId("#companychat")).toBe("companychat");
  });
});

describe("Slack API target ids", () => {
  it("canonicalizes a proven user id", () => {
    expect(canonicalizeSlackApiTargetId("user", "w09g2dj0275")).toBe("W09G2DJ0275");
  });
});

describe("slackTargetsMatch", () => {
  it("keeps identically named targets in different workspaces distinct", () => {
    expect(slackTargetsMatch("team:T1:channel:C123", "team:T2:channel:C123")).toBe(false);
    expect(slackTargetsMatch("team:T1:channel:C123", "channel:C123")).toBe(false);
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
