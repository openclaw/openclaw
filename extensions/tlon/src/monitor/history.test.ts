// Tlon tests cover channel history cache behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheMessage,
  getChannelHistory,
  MAX_CACHED_CHANNEL_HISTORY_NAMESPACES,
  testing,
} from "./history.js";

describe("tlon monitor history cache", () => {
  beforeEach(() => {
    testing.clearMessageCacheForTests();
  });

  it("caps cached channel history namespaces and evicts the oldest channel", async () => {
    for (let index = 0; index <= MAX_CACHED_CHANNEL_HISTORY_NAMESPACES; index += 1) {
      cacheMessage(`group/channel-${index}`, {
        author: "~zod",
        content: `message ${index}`,
        timestamp: index,
      });
    }

    expect(testing.getCachedChannelCountForTests()).toBe(
      MAX_CACHED_CHANNEL_HISTORY_NAMESPACES,
    );
    expect(testing.hasCachedChannelForTests("group/channel-0")).toBe(false);
    expect(testing.hasCachedChannelForTests("group/channel-1")).toBe(true);

    const api = { scry: vi.fn(async () => []) };
    await expect(getChannelHistory(api, "group/channel-0", 1)).resolves.toEqual([]);
    expect(api.scry).toHaveBeenCalledWith(
      "/channels/v4/group/channel-0/posts/newest/1/outline.json",
    );

    const cached = await getChannelHistory(api, "group/channel-1", 1);
    expect(cached).toEqual([
      {
        author: "~zod",
        content: "message 1",
        timestamp: 1,
      },
    ]);
  });
});
