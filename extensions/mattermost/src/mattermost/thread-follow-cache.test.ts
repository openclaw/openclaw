import { beforeEach, describe, expect, it } from "vitest";
import {
  clearMattermostThreadFollowCache,
  hasMattermostThreadFollow,
  recordMattermostThreadFollow,
} from "./thread-follow-cache.js";

describe("mattermost thread follow cache", () => {
  beforeEach(() => {
    clearMattermostThreadFollowCache();
  });

  it("allows follow-up from the same sender within the ttl window", () => {
    recordMattermostThreadFollow({
      accountId: "default",
      channelId: "chan-1",
      threadRootId: "root-1",
      senderId: "user-1",
      ttlMs: 60_000,
      nowMs: 1_000,
    });

    expect(
      hasMattermostThreadFollow({
        accountId: "default",
        channelId: "chan-1",
        threadRootId: "root-1",
        senderId: "user-1",
        ttlMs: 60_000,
        nowMs: 30_000,
      }),
    ).toBe(true);
  });

  it("rejects follow-up from a different sender in the same thread", () => {
    recordMattermostThreadFollow({
      accountId: "default",
      channelId: "chan-1",
      threadRootId: "root-1",
      senderId: "user-1",
      ttlMs: 60_000,
      nowMs: 1_000,
    });

    expect(
      hasMattermostThreadFollow({
        accountId: "default",
        channelId: "chan-1",
        threadRootId: "root-1",
        senderId: "user-2",
        ttlMs: 60_000,
        nowMs: 30_000,
      }),
    ).toBe(false);
  });

  it("expires follow-up eligibility after the ttl window", () => {
    recordMattermostThreadFollow({
      accountId: "default",
      channelId: "chan-1",
      threadRootId: "root-1",
      senderId: "user-1",
      ttlMs: 60_000,
      nowMs: 1_000,
    });

    expect(
      hasMattermostThreadFollow({
        accountId: "default",
        channelId: "chan-1",
        threadRootId: "root-1",
        senderId: "user-1",
        ttlMs: 60_000,
        nowMs: 70_001,
      }),
    ).toBe(false);
  });
});
