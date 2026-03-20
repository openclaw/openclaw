import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { reactSlackMessage, removeSlackReaction } from "./actions.js";

type MockClient = {
  reactions: {
    add: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
};

function mockClient(): MockClient & WebClient {
  return {
    reactions: {
      add: vi.fn(),
      remove: vi.fn(),
    },
  } as unknown as MockClient & WebClient;
}

function slackApiError(code: string): Error {
  const err = new Error(`slack api: ${code}`) as Error & {
    data?: { error?: string };
  };
  err.data = { error: code };
  return err;
}

describe("reactSlackMessage", () => {
  it("adds a reaction normally", async () => {
    const client = mockClient();
    await reactSlackMessage("C1", "123.456", "thumbsup", { client });
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "123.456",
      name: "thumbsup",
    });
  });

  it("suppresses already_reacted errors", async () => {
    const client = mockClient();
    client.reactions.add.mockRejectedValue(slackApiError("already_reacted"));
    await expect(
      reactSlackMessage("C1", "123.456", "thumbsup", { client }),
    ).resolves.toBeUndefined();
  });

  it("re-throws other Slack API errors", async () => {
    const client = mockClient();
    client.reactions.add.mockRejectedValue(slackApiError("channel_not_found"));
    await expect(reactSlackMessage("C1", "123.456", "thumbsup", { client })).rejects.toThrow(
      "channel_not_found",
    );
  });
});

describe("removeSlackReaction", () => {
  it("removes a reaction normally", async () => {
    const client = mockClient();
    await removeSlackReaction("C1", "123.456", "thumbsup", { client });
    expect(client.reactions.remove).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "123.456",
      name: "thumbsup",
    });
  });

  it("suppresses no_reaction errors", async () => {
    const client = mockClient();
    client.reactions.remove.mockRejectedValue(slackApiError("no_reaction"));
    await expect(
      removeSlackReaction("C1", "123.456", "thumbsup", { client }),
    ).resolves.toBeUndefined();
  });

  it("re-throws other Slack API errors", async () => {
    const client = mockClient();
    client.reactions.remove.mockRejectedValue(slackApiError("channel_not_found"));
    await expect(removeSlackReaction("C1", "123.456", "thumbsup", { client })).rejects.toThrow(
      "channel_not_found",
    );
  });
});
