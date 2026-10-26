import { ChannelType, Routes } from "discord-api-types/v10";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { hasDiscordMessageCreateAmbiguity } from "./retry.js";
import { registerSendAssetsAndRetriesTests } from "./send.assets-and-retries.test-support.js";
import { makeDiscordRest, requestBody, requestPath } from "./send.test-harness.js";

vi.mock("openclaw/plugin-sdk/web-media", async () => {
  const { discordWebMediaMockFactory } = await import("./send.test-harness.js");
  return discordWebMediaMockFactory();
});

import { discordOutbound } from "./outbound-payload.js";
import * as send from "./send.js";
const cfg = { channels: { discord: { accounts: { default: {} } } } };
const retry = { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 };
const multiline = Array.from({ length: 18 }, (_, index) => `line ${index + 1}`).join("\n");
const longText = "a".repeat(2001);
const firstChunk = "a".repeat(2000);
const member = { guildId: "g1", userId: "u1" };
type Rest = ReturnType<typeof makeDiscordRest>["rest"];
type CreateSpec = Partial<Parameters<typeof send.createThreadDiscord>[1]>;
type CreateOptions = Parameters<typeof send.createThreadDiscord>[2];
type PayloadOptions = Pick<
  Parameters<NonNullable<typeof discordOutbound.sendPayload>>[0],
  "threadId" | "onDeliveryResult"
>;
const timeoutMember = (rest: Rest, durationMinutes: number) =>
  send.timeoutMemberDiscord({ ...member, durationMinutes }, clientOpts(rest));
const clientOpts = (rest: Rest) => ({ cfg, rest, token: "t" });
const requests = (mock: ReturnType<typeof makeDiscordRest>["postMock"]) =>
  mock.mock.calls.map((_, index) => [requestPath(mock, index), requestBody(mock, index)]);

function threadHarness(type = ChannelType.GuildText, archive?: number) {
  const mocks = makeDiscordRest();
  mocks.getMock.mockResolvedValue({ type, default_auto_archive_duration: archive });
  mocks.postMock.mockResolvedValue({ id: "t1", channel_id: "t1" });
  const opts = clientOpts(mocks.rest);
  return {
    ...mocks,
    opts,
    create: (spec: CreateSpec = {}, options: CreateOptions = opts) =>
      send.createThreadDiscord("chan1", { name: "thread", ...spec }, options),
  };
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
    run: (payload: { text: string; mediaUrls?: string[] }, options: PayloadOptions = {}) =>
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

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => vi.doUnmock("openclaw/plugin-sdk/web-media"));
registerSendAssetsAndRetriesTests(() => send);

it.each([false, true])("keeps chunked replies in one thread (explicit=%s)", async (explicit) => {
  const { postMock, run } = forumPayloadHarness();
  const onDeliveryResult = vi.fn();
  const result = await run(
    {
      text: longText,
      mediaUrls: explicit
        ? undefined
        : ["https://example.com/first.jpg", "https://example.com/second.jpg"],
    },
    {
      threadId: explicit ? "701" : undefined,
      onDeliveryResult: explicit ? undefined : onDeliveryResult,
    },
  );
  expect(postMock.mock.calls.map(([path]) => path)).toEqual([
    ...(explicit ? [] : [Routes.threads("700")]),
    Routes.channelMessages("701"),
    Routes.channelMessages("701"),
  ]);
  if (!explicit) {
    expect(onDeliveryResult.mock.calls.map(([delivery]) => delivery.target)).toEqual(
      Array.from({ length: 3 }, () => ({ kind: "channel", id: "701" })),
    );
  }
  expect(result?.receipt?.threadId).toBe(explicit ? undefined : "701");
  expect(result?.receipt).toMatchObject({
    platformMessageIds: explicit ? ["message-2"] : ["starter", "message-1", "message-2"],
  });
});

it("does not follow up when delivery bookkeeping rejects the starter", async () => {
  const { postMock, run } = forumPayloadHarness();
  const onDeliveryResult = vi.fn().mockRejectedValue(new Error("delivery bookkeeping failed"));
  await expect(run({ text: longText }, { onDeliveryResult })).rejects.toThrow(
    "delivery bookkeeping failed",
  );
  expect(onDeliveryResult).toHaveBeenCalledOnce();
  expect(postMock.mock.calls.map(([path]) => path)).toEqual([Routes.threads("700")]);
});

it("creates a message-attached thread with an archive override and one multiline initial message", async () => {
  const { create, getMock, postMock } = threadHarness();
  await create({ messageId: "1", autoArchiveMinutes: 4320, content: multiline });
  expect(getMock).not.toHaveBeenCalled();
  expect(requests(postMock)).toEqual([
    [Routes.threads("chan1", "1"), { name: "thread", auto_archive_duration: 4320 }],
    [
      Routes.channelMessages("t1"),
      expect.objectContaining({ content: multiline, enforce_nonce: true }),
    ],
  ]);
});

it("keeps original create authority after awaited channel metadata", async () => {
  const { create, opts, getMock, postMock } = threadHarness();
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
  await expect(create({}, options)).rejects.toThrow("Command owner was revoked");
  expect(postMock).not.toHaveBeenCalled();
});

it("inherits forum archive defaults and uses the tagged thread name as its starter", async () => {
  const { create, postMock } = threadHarness(ChannelType.GuildForum, 1440);
  await create({ appliedTags: ["tag1", "tag2"] });
  expect(requestBody(postMock)).toEqual({
    name: "thread",
    auto_archive_duration: 1440,
    message: { content: "thread" },
    applied_tags: ["tag1", "tag2"],
  });
});

it("falls back to a public thread without forum tags when channel lookup fails", async () => {
  const { create, getMock, postMock } = threadHarness();
  getMock.mockRejectedValue(new Error("lookup failed"));
  await create({ appliedTags: ["tag1"] });
  expect(requests(postMock)).toEqual([
    [Routes.threads("chan1"), { name: "thread", type: ChannelType.PublicThread }],
  ]);
});

it("chunks a private thread's initial message and retries with a stable nonce per chunk", async () => {
  const { create, opts, postMock } = threadHarness(ChannelType.GuildText, 10080);
  postMock
    .mockResolvedValueOnce({ id: "t1" })
    .mockRejectedValueOnce(Object.assign(new Error("bad gateway"), { status: 502 }))
    .mockResolvedValueOnce({ id: "msg1", channel_id: "t1" })
    .mockResolvedValueOnce({ id: "msg2", channel_id: "t1" });
  await create({ type: ChannelType.PrivateThread, content: longText }, { ...opts, retry });
  expect(postMock).toHaveBeenCalledTimes(4);
  expect(requestBody(postMock)).toEqual({
    name: "thread",
    type: ChannelType.PrivateThread,
    auto_archive_duration: 10080,
  });
  const first = requestBody(postMock, 1);
  const next = requestBody(postMock, 3);
  expect(first).toMatchObject({ content: firstChunk, enforce_nonce: true });
  expect(requestBody(postMock, 2).nonce).toBe(first.nonce);
  expect(next).toMatchObject({ content: "a", enforce_nonce: true });
  expect(next.nonce).not.toBe(first.nonce);
  expect(requestPath(postMock, 3)).toBe(Routes.channelMessages("t1"));
});

it("keeps created thread details when the first initial-message send fails", async () => {
  const { create, postMock } = threadHarness();
  const thread = { id: "t1", name: "thread", type: ChannelType.PublicThread };
  postMock.mockResolvedValueOnce(thread).mockRejectedValueOnce(new Error("missing access"));
  const error = await create({ content: "Hello thread!" }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(send.DiscordThreadInitialMessageError);
  expect(error).toMatchObject({
    name: "DiscordThreadInitialMessageError",
    initialMessageError: "missing access",
    thread,
    message: expect.stringContaining("initial message delivery could not be confirmed"),
  });
});

it.each([
  { status: 403, delivered: "not_delivered" },
  { status: 502, delivered: "unknown" },
])("tracks forum partial delivery on HTTP $status", async ({ status, delivered }) => {
  const { create, opts, postMock } = threadHarness(ChannelType.GuildForum);
  postMock.mockResolvedValueOnce({ id: "t1", message: { id: "starter1", channel_id: "t1" } });
  postMock.mockRejectedValue(Object.assign(new Error("send failed"), { status }));
  const error = await create({ content: longText }, { ...opts, retry }).catch(
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(send.DiscordThreadInitialMessageError);
  expect(hasDiscordMessageCreateAmbiguity(error)).toBe(status === 502);
  expect(error).toMatchObject({
    initialMessageDelivery: {
      starterMessageDelivered: true,
      deliveredChunkCount: 1,
      deliveredMessageIds: ["starter1"],
      failedChunkDelivery: delivered,
      failedChunkIndex: 1,
      totalChunkCount: 2,
    },
  });
  expect(postMock).toHaveBeenCalledTimes(1 + (status === 502 ? 2 : 1));
  expect(requestBody(postMock)).toEqual({ name: "thread", message: { content: firstChunk } });
});

it("lists active threads by guild", async () => {
  const { rest, getMock } = makeDiscordRest();
  await send.listThreadsDiscord({ guildId: "g1" }, clientOpts(rest));
  expect(getMock).toHaveBeenCalledWith(Routes.guildActiveThreads("g1"));
});
it("times out a member", async () => {
  const { rest, patchMock } = makeDiscordRest();
  await timeoutMember(rest, 10);
  expect(requestPath(patchMock)).toBe(Routes.guildMember("g1", "u1"));
  expect(requestBody(patchMock).communication_disabled_until).toBeTypeOf("string");
});
it("rejects timeout durations that overflow from the current clock", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(8_640_000_000_000_000));
  const { rest, patchMock } = makeDiscordRest();
  await expect(timeoutMember(rest, 1)).rejects.toThrow(
    "Discord timeout duration is outside the supported Date range",
  );
  expect(patchMock).not.toHaveBeenCalled();
});
it("adds and removes roles", async () => {
  const { rest, putMock, deleteMock } = makeDiscordRest();
  await send.addRoleDiscord({ ...member, roleId: "r1" }, clientOpts(rest));
  await send.removeRoleDiscord({ ...member, roleId: "r1" }, clientOpts(rest));
  expect(putMock).toHaveBeenCalledWith(Routes.guildMemberRole("g1", "u1", "r1"));
  expect(deleteMock).toHaveBeenCalledWith(Routes.guildMemberRole("g1", "u1", "r1"));
});
it("bans a member", async () => {
  const { rest, putMock } = makeDiscordRest();
  await send.banMemberDiscord({ ...member, deleteMessageDays: 2 }, clientOpts(rest));
  expect(requests(putMock)).toEqual([[Routes.guildBan("g1", "u1"), { delete_message_days: 2 }]]);
});
