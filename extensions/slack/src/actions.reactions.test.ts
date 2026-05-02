import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { reactSlackMessage, removeOwnSlackReactions, removeSlackReaction } from "./actions.js";

function createClient() {
  return {
    reactions: {
      add: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({})),
      get: vi.fn(async () => ({ message: { reactions: [] } })),
    },
    auth: {
      test: vi.fn(async () => ({ user_id: "U_BOT" })),
    },
  } as unknown as WebClient & {
    reactions: {
      add: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
    };
    auth: {
      test: ReturnType<typeof vi.fn>;
    };
  };
}

function slackPlatformError(error: string) {
  return Object.assign(new Error(`An API error occurred: ${error}`), {
    data: {
      ok: false,
      error,
    },
  });
}

describe("reactSlackMessage", () => {
  it("treats already_reacted as idempotent success", async () => {
    const client = createClient();
    client.reactions.add.mockRejectedValueOnce(slackPlatformError("already_reacted"));

    await expect(
      reactSlackMessage("C1", "123.456", ":white_check_mark:", {
        client,
        token: "xoxb-test",
      }),
    ).resolves.toBeUndefined();

    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "123.456",
      name: "white_check_mark",
    });
  });

  it("propagates unrelated reaction add errors", async () => {
    const client = createClient();
    client.reactions.add.mockRejectedValueOnce(slackPlatformError("invalid_name"));

    await expect(
      reactSlackMessage("C1", "123.456", "not-an-emoji", {
        client,
        token: "xoxb-test",
      }),
    ).rejects.toMatchObject({
      data: {
        error: "invalid_name",
      },
    });
  });
});

describe("removeSlackReaction", () => {
  it("treats no_reaction as idempotent success", async () => {
    const client = createClient();
    client.reactions.remove.mockRejectedValueOnce(slackPlatformError("no_reaction"));

    await expect(
      removeSlackReaction("C1", "123.456", ":white_check_mark:", {
        client,
        token: "xoxb-test",
      }),
    ).resolves.toBeUndefined();

    expect(client.reactions.remove).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "123.456",
      name: "white_check_mark",
    });
  });

  it("propagates unrelated reaction remove errors", async () => {
    const client = createClient();
    client.reactions.remove.mockRejectedValueOnce(slackPlatformError("channel_not_found"));

    await expect(
      removeSlackReaction("C1", "123.456", ":x:", {
        client,
        token: "xoxb-test",
      }),
    ).rejects.toMatchObject({
      data: {
        error: "channel_not_found",
      },
    });
  });
});

describe("removeOwnSlackReactions", () => {
  it("survives a no_reaction race between list and remove", async () => {
    const client = createClient();
    client.reactions.get.mockResolvedValueOnce({
      message: {
        reactions: [
          { name: "thumbsup", users: ["U_BOT"], count: 1 },
          { name: "eyes", users: ["U_BOT"], count: 1 },
        ],
      },
    });
    client.reactions.remove
      .mockRejectedValueOnce(slackPlatformError("no_reaction"))
      .mockResolvedValueOnce({});

    await expect(
      removeOwnSlackReactions("C1", "123.456", { client, token: "xoxb-test" }),
    ).resolves.toEqual(expect.arrayContaining(["thumbsup", "eyes"]));

    expect(client.reactions.remove).toHaveBeenCalledTimes(2);
  });
});
