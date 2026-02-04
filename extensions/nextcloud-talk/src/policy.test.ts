import { describe, expect, it } from "vitest";

import { resolveNextcloudTalkAllowlistMatch } from "./policy.js";

describe("nextcloud-talk policy", () => {
  describe("resolveNextcloudTalkAllowlistMatch", () => {
    it("allows wildcard", () => {
      expect(
        resolveNextcloudTalkAllowlistMatch({
          allowFrom: ["*"],
          senderId: "user-id",
        }).allowed,
      ).toBe(true);
    });

    it("allows sender id match with normalization", () => {
      expect(
        resolveNextcloudTalkAllowlistMatch({
          allowFrom: ["nc:User-Id"],
          senderId: "user-id",
        }),
      ).toEqual({ allowed: true, matchKey: "user-id", matchSource: "id" });
    });

    it("blocks when sender id does not match", () => {
      expect(
        resolveNextcloudTalkAllowlistMatch({
          allowFrom: ["allowed"],
          senderId: "other",
        }).allowed,
      ).toBe(false);
    });
  });
});
