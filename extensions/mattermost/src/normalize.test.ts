// Mattermost tests cover normalize plugin behavior.
import { describe, expect, it } from "vitest";
import { looksLikeMattermostTargetId, normalizeMattermostMessagingTarget } from "./normalize.js";

describe("normalizeMattermostMessagingTarget", () => {
  it.each([
    ["", undefined],
    ["  ", undefined],
    ["channel:", undefined],
    ["user:", undefined],
    ["@", undefined],
    ["#", undefined],
    ["@alice", "@alice"],
    ["@Alice", "@Alice"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeMattermostMessagingTarget(input)).toBe(expected);
  });
});

describe("looksLikeMattermostTargetId", () => {
  it.each([
    ["", false],
    ["  ", false],
    ["channel:abc", true],
    ["Channel:abc", true],
    ["user:abc", true],
    ["group:abc", true],
    ["mattermost:abc", true],
    ["@alice", true],
    ["abcdefghijklmnopqrstuvwxyz1", false], // pragma: allowlist secret
  ])("classifies %j as %s", (input, expected) => {
    expect(looksLikeMattermostTargetId(input)).toBe(expected);
  });
});
