// Mattermost tests cover normalize plugin behavior.
import { describe, expect, it } from "vitest";
import { looksLikeMattermostTargetId, normalizeMattermostMessagingTarget } from "./normalize.js";

describe("normalizeMattermostMessagingTarget", () => {
  it("returns undefined for empty input", () => {
    expect(normalizeMattermostMessagingTarget("")).toBeUndefined();
    expect(normalizeMattermostMessagingTarget("  ")).toBeUndefined();
  });

  it("keeps @username targets", () => {
    expect(normalizeMattermostMessagingTarget("@alice")).toBe("@alice");
    expect(normalizeMattermostMessagingTarget("@Alice")).toBe("@Alice");
  });

  it("returns undefined for empty prefixed values", () => {
    expect(normalizeMattermostMessagingTarget("channel:")).toBeUndefined();
    expect(normalizeMattermostMessagingTarget("user:")).toBeUndefined();
    expect(normalizeMattermostMessagingTarget("@")).toBeUndefined();
    expect(normalizeMattermostMessagingTarget("#")).toBeUndefined();
  });
});

describe("looksLikeMattermostTargetId", () => {
  it("returns false for empty input", () => {
    expect(looksLikeMattermostTargetId("")).toBe(false);
    expect(looksLikeMattermostTargetId("  ")).toBe(false);
  });

  it("recognizes prefixed targets", () => {
    expect(looksLikeMattermostTargetId("channel:abc")).toBe(true);
    expect(looksLikeMattermostTargetId("Channel:abc")).toBe(true);
    expect(looksLikeMattermostTargetId("user:abc")).toBe(true);
    expect(looksLikeMattermostTargetId("group:abc")).toBe(true);
    expect(looksLikeMattermostTargetId("mattermost:abc")).toBe(true);
  });

  it("recognizes @username", () => {
    expect(looksLikeMattermostTargetId("@alice")).toBe(true);
  });

  it("rejects strings longer than 26 chars that are not DM format", () => {
    expect(looksLikeMattermostTargetId("abcdefghijklmnopqrstuvwxyz1")).toBe(false); // pragma: allowlist secret
  });
});
