import { Routes } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { createScheduledEventDiscord, fetchVoiceStatusDiscord } from "./send.guild.js";
import { readMessagesDiscord, searchMessagesDiscord } from "./send.messages.js";
import { makeDiscordRest } from "./send.test-harness.js";
import { sendTypingDiscord } from "./send.typing.js";

function client() {
  const mocks = makeDiscordRest();
  return {
    ...mocks,
    opts: { rest: mocks.rest, token: "t", cfg: { channels: { discord: { token: "t" } } } },
  };
}

describe("Discord message reads", () => {
  it("returns messages and forwards pagination", async () => {
    const { getMock, opts } = client();
    const messages = [{ id: "1", content: "hello" }];
    getMock.mockResolvedValueOnce(messages);
    await expect(readMessagesDiscord("C1", { limit: 5, before: "10" }, opts)).resolves.toEqual(
      messages,
    );
    expect(getMock).toHaveBeenCalledWith(Routes.channelMessages("C1"), { limit: 5, before: "10" });
  });

  it("rejects non-array message responses", async () => {
    const { getMock, opts } = client();
    getMock.mockResolvedValueOnce("\u001f\ufffd\u0008raw gzip bytes");
    await expect(readMessagesDiscord("C1", {}, opts)).rejects.toThrow(
      "Unexpected Discord response for message read: expected array.",
    );
  });

  it("preserves empty search results while encoding filters and clamping the limit", async () => {
    const { getMock, opts } = client();
    const results = { messages: [], total_results: 0 };
    getMock.mockResolvedValueOnce(results);
    await expect(
      searchMessagesDiscord(
        {
          guildId: "G1",
          content: "release & review",
          channelIds: ["c1", "c2"],
          authorIds: ["u1", "u2"],
          limit: 99,
        },
        opts,
      ),
    ).resolves.toEqual(results);
    expect(getMock).toHaveBeenCalledWith(
      "/guilds/G1/messages/search?content=release+%26+review&channel_id=c1&channel_id=c2&author_id=u1&author_id=u2&limit=25",
    );
  });

  it.each([
    {
      response: {
        message: "Index not yet available. Try again later",
        code: 110000,
        documents_indexed: 0,
        retry_after: 2,
      },
      error:
        "Discord message search unavailable: Index not yet available. Try again later (retry after 2s)",
    },
    {
      response: { total_results: 1 },
      error: "Unexpected Discord response for message search: expected messages array.",
    },
    {
      response: "\u001f\ufffd\u0008raw gzip bytes",
      error: "Unexpected Discord response for message search: expected object.",
    },
  ])("rejects invalid search responses: $error", async ({ response, error }) => {
    const { getMock, opts } = client();
    getMock.mockResolvedValueOnce(response);
    await expect(searchMessagesDiscord({ guildId: "G1", content: "test" }, opts)).rejects.toThrow(
      error,
    );
  });
});

describe("Discord voice status", () => {
  it("returns an active voice state", async () => {
    const { getMock, opts } = client();
    const voiceState = { guild_id: "g1", user_id: "u1", channel_id: "c1", session_id: "s1" };
    getMock.mockResolvedValueOnce(voiceState);
    await expect(fetchVoiceStatusDiscord("g1", "u1", opts)).resolves.toEqual(voiceState);
    expect(getMock).toHaveBeenCalledWith(Routes.guildVoiceState("g1", "u1"));
  });

  it.each([
    Object.assign(new Error("Not Found"), { status: 404, discordCode: 10065 }),
    new Error("DiscordError: Unknown Voice State"),
  ])("recognizes an absent voice state: %s", async (error) => {
    const { getMock, opts } = client();
    getMock.mockRejectedValueOnce(error);
    await expect(fetchVoiceStatusDiscord("g1", "u1", opts)).resolves.toEqual({
      guild_id: "g1",
      user_id: "u1",
      channel_id: null,
      connected: false,
      absent: true,
      reason: "unknown_voice_state",
    });
  });

  it("propagates other Discord failures", async () => {
    const { getMock, opts } = client();
    const error = Object.assign(new Error("Unknown Guild"), { status: 404, discordCode: 10004 });
    getMock.mockRejectedValueOnce(error);
    await expect(fetchVoiceStatusDiscord("g1", "u1", opts)).rejects.toBe(error);
  });
});

it("sends typing to the resolved channel", async () => {
  const { postMock, opts } = client();
  await expect(sendTypingDiscord("12345", { ...opts, accountId: "ops" })).resolves.toEqual({
    ok: true,
    channelId: "12345",
  });
  expect(postMock).toHaveBeenCalledWith(Routes.channelTyping("12345"));
});

it("posts scheduled event fields unchanged to the selected guild", async () => {
  const { postMock, opts } = client();
  const payload = {
    name: "Release review",
    scheduled_start_time: "2026-04-29T10:00:00.000Z",
    scheduled_end_time: "2026-04-29T11:00:00.000Z",
    privacy_level: 2,
    entity_type: 3,
    entity_metadata: { location: "Review room" },
  } as const;
  postMock.mockResolvedValueOnce({ id: "event1" });

  await expect(createScheduledEventDiscord("g1", payload, opts)).resolves.toEqual({ id: "event1" });
  expect(postMock).toHaveBeenCalledExactlyOnceWith("/guilds/g1/scheduled-events", {
    body: payload,
  });
});
