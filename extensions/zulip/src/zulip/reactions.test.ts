import { describe, expect, it, vi } from "vitest";

vi.mock("./client.js", () => {
  return {
    zulipRequestWithRetry: vi.fn(async () => ({ result: "success" })),
  };
});

import type { ZulipAuth } from "./client.js";
import { zulipRequestWithRetry } from "./client.js";
import { addZulipReaction, removeZulipReaction } from "./reactions.js";

describe("removeZulipReaction", () => {
  it("sends emoji_name as query params", async () => {
    const auth: ZulipAuth = {
      baseUrl: "https://zulip.example",
      email: "bot@zulip.example",
      apiKey: "not-a-real-key",
    };

    await removeZulipReaction({
      auth,
      messageId: 123,
      emojiName: ":eyes:",
    });

    expect(zulipRequestWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "DELETE",
        path: "/api/v1/messages/123/reactions",
        query: { emoji_name: "eyes" },
      }),
    );
  });
});

describe("addZulipReaction", () => {
  it("sends emoji_name as form params", async () => {
    const auth: ZulipAuth = {
      baseUrl: "https://zulip.example",
      email: "bot@zulip.example",
      apiKey: "not-a-real-key",
    };

    await addZulipReaction({
      auth,
      messageId: 456,
      emojiName: ":eyes:",
    });

    expect(zulipRequestWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/api/v1/messages/456/reactions",
        form: { emoji_name: "eyes" },
      }),
    );
  });
});
