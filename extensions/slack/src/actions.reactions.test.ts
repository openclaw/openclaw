import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { reactSlackMessage } from "./actions.js";

function createClient() {
  return {
    reactions: {
      add: vi.fn(async () => ({})),
    },
  } as unknown as WebClient & {
    reactions: {
      add: ReturnType<typeof vi.fn>;
    };
  };
}

describe("reactSlackMessage", () => {
  it("ignores duplicate reaction errors from Slack", async () => {
    const client = createClient();
    client.reactions.add.mockRejectedValueOnce({
      data: { error: "already_reacted" },
    });

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

  it("rethrows unrelated Slack reaction errors", async () => {
    const client = createClient();
    const error = new Error("missing_scope");
    client.reactions.add.mockRejectedValueOnce(error);

    await expect(
      reactSlackMessage("C1", "123.456", "✅", {
        client,
        token: "xoxb-test",
      }),
    ).rejects.toBe(error);
  });
});
