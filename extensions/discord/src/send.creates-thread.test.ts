import { ChannelType, Routes } from "discord-api-types/v10";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasDiscordMessageCreateAmbiguity } from "./retry.js";
import { registerSendAssetsAndRetriesTests } from "./send.assets-and-retries.test-support.js";
import { makeDiscordRest, requestBody, requestPath } from "./send.test-harness.js";

vi.mock("openclaw/plugin-sdk/web-media", async () => {
  const { discordWebMediaMockFactory } = await import("./send.test-harness.js");
  return discordWebMediaMockFactory();
});

let send: typeof import("./send.js");
let discordOutbound: typeof import("./outbound-adapter.js").discordOutbound;
const cfg = { channels: { discord: { accounts: { default: {} } } } };
const retry = { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 };
const multiline = Array.from({ length: 18 }, (_, index) => `line ${index + 1}`).join("\n");
const clientOpts = (rest: ReturnType<typeof makeDiscordRest>["rest"]) => ({
  cfg,
  rest,
  token: "t",
});

function threadHarness(type = ChannelType.GuildText) {
  const mocks = makeDiscordRest();
  mocks.getMock.mockResolvedValue({ type });
  mocks.postMock.mockResolvedValue({ id: "t1", channel_id: "t1" });
  return { ...mocks, opts: clientOpts(mocks.rest) };
}

function forumPayloadHarness() {
  const { rest, getMock, postMock } = makeDiscordRest();
  let messageCount = 0;
  getMock.mockImplementation(async (path: unknown) => ({
    id: String(path).split("/").at(-1),
    type: path === Routes.channel("700") ? ChannelType.GuildForum : ChannelType.PublicThread,
  }));
  postMock.mockImplementation(async (path: unknown) =>
    path === Routes.threads("700")
      ? { id: "701", message: { id: "starter", channel_id: "701" } }
      : { id: `message-${++messageCount}`, channel_id: String(path).split("/").at(-2) },
  );
  return {
    postMock,
    run: (
      payload: { text: string; mediaUrls?: string[] },
      options: Pick<
        Parameters<NonNullable<typeof discordOutbound.sendPayload>>[0],
        "threadId" | "onDeliveryResult"
      > = {},
    ) =>
      discordOutbound.sendPayload?.({
        cfg,
        to: "channel:700",
        text: payload.text,
        payload,
        ...options,
        deps: {
          discord: async (...[to, text, opts]: Parameters<typeof send.sendMessageDiscord>) =>
            await send.sendMessageDiscord(to, text, { ...opts, rest, token: "t" }),
        },
      }),
  };
}

beforeAll(async () => {
  send = await import("./send.js");
  ({ discordOutbound } = await import("./outbound-adapter.js"));
});
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => vi.doUnmock("openclaw/plugin-sdk/web-media"));
registerSendAssetsAndRetriesTests(() => send);

describe("forum outbound delivery", () => {
  it("keeps long text and multiple attachments in one automatically created thread", async () => {
    const { postMock, run } = forumPayloadHarness();
    const onDeliveryResult = vi.fn();
    const result = await run(
      {
        text: "a".repeat(2001),
        mediaUrls: ["https://example.com/first.jpg", "https://example.com/second.jpg"],
      },
      { onDeliveryResult },
    );
    expect(postMock.mock.calls.map(([path]) => path)).toEqual([
      Routes.threads("700"),
      Routes.channelMessages("701"),
      Routes.channelMessages("701"),
    ]);
    expect(onDeliveryResult.mock.calls.map(([delivery]) => delivery.target)).toEqual([
      { kind: "channel", id: "701" },
      { kind: "channel", id: "701" },
      { kind: "channel", id: "701" },
    ]);
    expect(result?.receipt).toMatchObject({
      threadId: "701",
      platformMessageIds: ["starter", "message-1", "message-2"],
    });
  });

  it("keeps chunked replies targeted at an explicitly selected thread", async () => {
    const { postMock, run } = forumPayloadHarness();
    const result = await run({ text: "a".repeat(2001) }, { threadId: "701" });
    expect(postMock.mock.calls.map(([path]) => path)).toEqual([
      Routes.channelMessages("701"),
      Routes.channelMessages("701"),
    ]);
    expect(result?.receipt?.threadId).toBeUndefined();
    expect(result?.receipt?.platformMessageIds).toEqual(["message-2"]);
  });

  it("does not attempt a follow-up when forum creation is rejected", async () => {
    const { postMock, run } = forumPayloadHarness();
    postMock.mockRejectedValueOnce(new Error("missing access"));
    await expect(run({ text: "a".repeat(2001) })).rejects.toThrow("missing access");
    expect(postMock.mock.calls.map(([path]) => path)).toEqual([Routes.threads("700")]);
  });

  it("does not follow up when delivery bookkeeping rejects the starter", async () => {
    const { postMock, run } = forumPayloadHarness();
    const onDeliveryResult = vi.fn().mockRejectedValue(new Error("delivery bookkeeping failed"));
    await expect(run({ text: "a".repeat(2001) }, { onDeliveryResult })).rejects.toThrow(
      "delivery bookkeeping failed",
    );
    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(postMock.mock.calls.map(([path]) => path)).toEqual([Routes.threads("700")]);
  });
});

describe("createThreadDiscord", () => {
  it("creates a message-attached thread with an archive override and one multiline initial message", async () => {
    const { opts, getMock, postMock } = threadHarness();
    await send.createThreadDiscord(
      "chan1",
      { name: "thread", messageId: "1", autoArchiveMinutes: 4320, content: multiline },
      opts,
    );
    expect(getMock).not.toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledTimes(2);
    expect(requestPath(postMock)).toBe(Routes.threads("chan1", "1"));
    expect(requestBody(postMock)).toEqual({ name: "thread", auto_archive_duration: 4320 });
    expect(requestPath(postMock, 1)).toBe(Routes.channelMessages("t1"));
    expect(requestBody(postMock, 1)).toMatchObject({ content: multiline, enforce_nonce: true });
  });

  it("keeps original create authority after awaited channel metadata", async () => {
    const { opts, getMock, postMock } = threadHarness();
    let ownerCurrent = true;
    const options = {
      ...opts,
      assertCreateAllowed: () => {
        if (!ownerCurrent) {
          throw new Error("Command owner was revoked");
        }
      },
    };
    getMock.mockImplementationOnce(async () => {
      ownerCurrent = false;
      options.assertCreateAllowed = () => {};
      return { type: ChannelType.GuildText };
    });
    await expect(send.createThreadDiscord("chan1", { name: "thread" }, options)).rejects.toThrow(
      "Command owner was revoked",
    );
    expect(postMock).not.toHaveBeenCalled();
  });

  it("inherits forum archive defaults and uses the tagged thread name as its starter", async () => {
    const { opts, getMock, postMock } = threadHarness(ChannelType.GuildForum);
    getMock.mockResolvedValue({
      type: ChannelType.GuildForum,
      default_auto_archive_duration: 1440,
    });
    await send.createThreadDiscord(
      "chan1",
      { name: "thread", appliedTags: ["tag1", "tag2"] },
      opts,
    );
    expect(requestBody(postMock)).toEqual({
      name: "thread",
      auto_archive_duration: 1440,
      message: { content: "thread" },
      applied_tags: ["tag1", "tag2"],
    });
  });

  it("uses an archive override and keeps multiline media-channel content in one starter", async () => {
    const { opts, getMock, postMock } = threadHarness(ChannelType.GuildMedia);
    getMock.mockResolvedValue({
      type: ChannelType.GuildMedia,
      default_auto_archive_duration: 1440,
    });
    await send.createThreadDiscord(
      "chan1",
      { name: "thread", content: multiline, autoArchiveMinutes: 4320 },
      opts,
    );
    expect(postMock).toHaveBeenCalledOnce();
    expect(requestBody(postMock)).toEqual({
      name: "thread",
      auto_archive_duration: 4320,
      message: { content: multiline },
    });
  });

  it("falls back to a public thread without forum tags when channel lookup fails", async () => {
    const { opts, getMock, postMock } = threadHarness();
    getMock.mockRejectedValue(new Error("lookup failed"));
    await send.createThreadDiscord("chan1", { name: "thread", appliedTags: ["tag1"] }, opts);
    expect(requestPath(postMock)).toBe(Routes.threads("chan1"));
    expect(requestBody(postMock)).toEqual({ name: "thread", type: ChannelType.PublicThread });
  });

  it("chunks a private thread's initial message and retries with a stable nonce per chunk", async () => {
    const { opts, getMock, postMock } = threadHarness();
    getMock.mockResolvedValue({
      type: ChannelType.GuildText,
      default_auto_archive_duration: 10080,
    });
    postMock
      .mockResolvedValueOnce({ id: "t1" })
      .mockRejectedValueOnce(Object.assign(new Error("bad gateway"), { status: 502 }))
      .mockResolvedValueOnce({ id: "msg1", channel_id: "t1" })
      .mockResolvedValueOnce({ id: "msg2", channel_id: "t1" });
    await send.createThreadDiscord(
      "chan1",
      { name: "thread", type: ChannelType.PrivateThread, content: "a".repeat(2001) },
      { ...opts, retry },
    );
    expect(postMock).toHaveBeenCalledTimes(4);
    expect(requestBody(postMock)).toEqual({
      name: "thread",
      type: ChannelType.PrivateThread,
      auto_archive_duration: 10080,
    });
    const first = requestBody(postMock, 1);
    const next = requestBody(postMock, 3);
    expect(first).toMatchObject({ content: "a".repeat(2000), enforce_nonce: true });
    expect(requestBody(postMock, 2).nonce).toBe(first.nonce);
    expect(next).toMatchObject({ content: "a", enforce_nonce: true });
    expect(next.nonce).not.toBe(first.nonce);
    expect(requestPath(postMock, 3)).toBe(Routes.channelMessages("t1"));
  });

  it("keeps created thread details when the first initial-message send fails", async () => {
    const { opts, postMock } = threadHarness();
    const thread = { id: "t1", name: "thread", type: ChannelType.PublicThread };
    postMock.mockResolvedValueOnce(thread).mockRejectedValueOnce(new Error("missing access"));
    const error = await send
      .createThreadDiscord("chan1", { name: "thread", content: "Hello thread!" }, opts)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(send.DiscordThreadInitialMessageError);
    expect(error).toMatchObject({
      name: "DiscordThreadInitialMessageError",
      initialMessageError: "missing access",
      thread,
      message: expect.stringContaining("initial message delivery could not be confirmed"),
    });
  });

  it.each([
    { type: ChannelType.GuildForum, status: 403, delivered: "not_delivered" },
    { type: ChannelType.GuildForum, status: 502, delivered: "unknown" },
    { type: ChannelType.GuildText, status: 403, delivered: "not_delivered" },
  ])(
    "reports partial initial delivery for channel $type and HTTP $status",
    async ({ type, status, delivered }) => {
      const { opts, postMock } = threadHarness(type);
      const forum = type === ChannelType.GuildForum;
      postMock.mockResolvedValueOnce({ id: "t1", message: { id: "starter1", channel_id: "t1" } });
      if (!forum) {
        postMock.mockResolvedValueOnce({ id: "msg1", channel_id: "t1" });
      }
      postMock.mockRejectedValue(Object.assign(new Error("send failed"), { status }));
      const error = await send
        .createThreadDiscord(
          "chan1",
          { name: "thread", content: "a".repeat(forum ? 2001 : 4001) },
          { ...opts, retry },
        )
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(send.DiscordThreadInitialMessageError);
      expect(hasDiscordMessageCreateAmbiguity(error)).toBe(status === 502);
      expect(error).toMatchObject({
        initialMessageDelivery: {
          starterMessageDelivered: forum,
          deliveredChunkCount: 1,
          deliveredMessageIds: [forum ? "starter1" : "msg1"],
          failedChunkDelivery: delivered,
          failedChunkIndex: 1,
          totalChunkCount: forum ? 2 : 3,
        },
      });
      expect(postMock).toHaveBeenCalledTimes((forum ? 1 : 2) + (status === 502 ? 2 : 1));
      if (forum) {
        expect(requestBody(postMock)).toEqual({
          name: "thread",
          message: { content: "a".repeat(2000) },
        });
      }
    },
  );
});

describe("thread and member administration", () => {
  it("lists active threads by guild", async () => {
    const { rest, getMock } = makeDiscordRest();
    getMock.mockResolvedValue({ threads: [] });
    await send.listThreadsDiscord({ guildId: "g1" }, clientOpts(rest));
    expect(getMock).toHaveBeenCalledWith(Routes.guildActiveThreads("g1"));
  });
  it("times out a member", async () => {
    const { rest, patchMock } = makeDiscordRest();
    patchMock.mockResolvedValue({ id: "m1" });
    await send.timeoutMemberDiscord(
      { guildId: "g1", userId: "u1", durationMinutes: 10 },
      clientOpts(rest),
    );
    expect(requestPath(patchMock)).toBe(Routes.guildMember("g1", "u1"));
    expect(requestBody(patchMock).communication_disabled_until).toBeTypeOf("string");
  });
  it("rejects timeout durations that overflow from the current clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    const { rest, patchMock } = makeDiscordRest();
    await expect(
      send.timeoutMemberDiscord(
        { guildId: "g1", userId: "u1", durationMinutes: 1 },
        clientOpts(rest),
      ),
    ).rejects.toThrow("Discord timeout duration is outside the supported Date range");
    expect(patchMock).not.toHaveBeenCalled();
  });
  it("adds and removes roles", async () => {
    const { rest, putMock, deleteMock } = makeDiscordRest();
    await send.addRoleDiscord({ guildId: "g1", userId: "u1", roleId: "r1" }, clientOpts(rest));
    await send.removeRoleDiscord({ guildId: "g1", userId: "u1", roleId: "r1" }, clientOpts(rest));
    expect(putMock).toHaveBeenCalledWith(Routes.guildMemberRole("g1", "u1", "r1"));
    expect(deleteMock).toHaveBeenCalledWith(Routes.guildMemberRole("g1", "u1", "r1"));
  });
  it("bans a member", async () => {
    const { rest, putMock } = makeDiscordRest();
    await send.banMemberDiscord(
      { guildId: "g1", userId: "u1", deleteMessageDays: 2 },
      clientOpts(rest),
    );
    expect(requestPath(putMock)).toBe(Routes.guildBan("g1", "u1"));
    expect(requestBody(putMock)).toEqual({ delete_message_days: 2 });
  });
});
