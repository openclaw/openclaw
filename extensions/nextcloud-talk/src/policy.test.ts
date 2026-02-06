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

    it("strips users/ prefix from sender id", () => {
      expect(
        resolveNextcloudTalkAllowlistMatch({
          allowFrom: ["alice"],
          senderId: "users/alice",
        }),
      ).toEqual({ allowed: true, matchKey: "alice", matchSource: "id" });
    });

    it("strips users/ prefix from allowFrom entry", () => {
      expect(
        resolveNextcloudTalkAllowlistMatch({
          allowFrom: ["users/bob"],
          senderId: "bob",
        }),
      ).toEqual({ allowed: true, matchKey: "bob", matchSource: "id" });
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
