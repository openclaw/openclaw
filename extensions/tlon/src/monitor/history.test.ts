import { describe, expect, it, vi } from "vitest";
import { createChannelHistoryCache } from "./history.js";

describe("createChannelHistoryCache", () => {
  it("returns the 50 newest cached messages", async () => {
    const history = createChannelHistoryCache();
    for (let index = 0; index <= 100; index += 1) {
      history.cacheMessage("chat/~host/channel", {
        author: "~zod",
        content: `message-${index}`,
        timestamp: index,
      });
    }
    const scry = vi.fn();

    const messages = await history.getChannelHistory({ scry }, "chat/~host/channel");

    expect(messages).toHaveLength(50);
    expect(messages.at(0)?.content).toBe("message-100");
    expect(messages.at(-1)?.content).toBe("message-51");
    expect(scry).not.toHaveBeenCalled();
  });
});
