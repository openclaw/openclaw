import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { searchSlackMessages } from "./actions.js";

function createClient() {
  return {
    conversations: {
      info: vi.fn(async () => ({ channel: { name: "general" } })),
    },
    search: {
      messages: vi.fn(async () => ({ messages: { matches: [], total: 0 } })),
    },
  } as unknown as WebClient & {
    conversations: {
      info: ReturnType<typeof vi.fn>;
    };
    search: {
      messages: ReturnType<typeof vi.fn>;
    };
  };
}

describe("searchSlackMessages", () => {
  it("resolves channel ids to names before scoping search.messages", async () => {
    const client = createClient();

    await searchSlackMessages("hello", {
      client,
      token: "xoxp-test",
      channelId: "C123456789",
    });

    expect(client.conversations.info).toHaveBeenCalledWith({ channel: "C123456789" });
    expect(client.search.messages).toHaveBeenCalledWith({
      query: "hello in:general",
      count: undefined,
      sort: undefined,
      sort_dir: undefined,
      page: undefined,
    });
  });

  it("fails closed when channel id scoping cannot resolve a Slack channel name", async () => {
    const client = createClient();
    client.conversations.info.mockRejectedValueOnce({ data: { error: "missing_scope" } });

    await expect(
      searchSlackMessages("hello", {
        client,
        token: "xoxp-test",
        channelId: "C123456789",
      }),
    ).rejects.toThrow(/requires resolving the channel name/);
    expect(client.search.messages).not.toHaveBeenCalled();
  });

  it("uses explicit channel names without conversations.info lookup", async () => {
    const client = createClient();

    await searchSlackMessages("hello", {
      client,
      token: "xoxp-test",
      channelName: "random",
    });

    expect(client.conversations.info).not.toHaveBeenCalled();
    expect(client.search.messages).toHaveBeenCalledWith(
      expect.objectContaining({ query: "hello in:random" }),
    );
  });
});
