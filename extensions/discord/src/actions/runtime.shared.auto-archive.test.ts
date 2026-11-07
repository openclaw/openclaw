import { describe, expect, it } from "vitest";
import {
  readDiscordAutoArchiveDurationParam,
  readDiscordChannelEditParams,
} from "./runtime.shared.js";

it.each([
  { params: { appliedTags: ["tag-1"] }, expected: ["tag-1"] },
  { params: { appliedTags: [] }, expected: [] },
  { params: { applied_tags: [] }, expected: [] },
  { params: { applied_tags: ["tag-1"] }, expected: ["tag-1"] },
])("preserves applied channel tags %#", ({ params, expected }) => {
  expect(readDiscordChannelEditParams({ channelId: "C1", ...params }).appliedTags).toEqual(
    expected,
  );
});

describe("readDiscordAutoArchiveDurationParam", () => {
  it("accepts Discord REST auto-archive durations", () => {
    for (const minutes of [60, 1440, 4320, 10080]) {
      expect(
        readDiscordAutoArchiveDurationParam({ autoArchiveMinutes: minutes }, "autoArchiveMinutes"),
      ).toBe(minutes);
    }
  });

  it("omits missing values", () => {
    expect(readDiscordAutoArchiveDurationParam({}, "autoArchiveMinutes")).toBeUndefined();
  });

  it("rejects positive integers Discord will not accept before REST", () => {
    expect(() =>
      readDiscordAutoArchiveDurationParam({ autoArchiveMinutes: 999 }, "autoArchiveMinutes"),
    ).toThrow("autoArchiveMinutes must be one of 60, 1440, 4320, or 10080 minutes");
  });
});
