import { Routes } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { editChannelDiscord } from "./send.js";
import { makeDiscordRest } from "./send.test-harness.js";

describe("editChannelDiscord", () => {
  it("passes applied_tags in the Discord PATCH body", async () => {
    const { patchMock, rest } = makeDiscordRest();
    patchMock.mockResolvedValue({ id: "thread-1" });

    await editChannelDiscord(
      {
        channelId: "thread-1",
        appliedTags: ["tag-1", "tag-2"],
      },
      { rest, token: "t" },
    );

    expect(patchMock).toHaveBeenCalledWith(
      Routes.channel("thread-1"),
      expect.objectContaining({
        body: expect.objectContaining({
          applied_tags: ["tag-1", "tag-2"],
        }),
      }),
    );
  });

  it("preserves explicit empty applied_tags when clearing forum tags", async () => {
    const { patchMock, rest } = makeDiscordRest();
    patchMock.mockResolvedValue({ id: "thread-1" });

    await editChannelDiscord(
      {
        channelId: "thread-1",
        appliedTags: [],
      },
      { rest, token: "t" },
    );

    expect(patchMock).toHaveBeenCalledWith(
      Routes.channel("thread-1"),
      expect.objectContaining({
        body: expect.objectContaining({
          applied_tags: [],
        }),
      }),
    );
  });
});
