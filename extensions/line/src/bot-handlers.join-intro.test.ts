import type { messagingApi, webhook } from "@line/bot-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { resolveLineAccount } from "./accounts.js";
import { handleLineWebhookEvents } from "./bot-handlers.js";
import { setLineRuntime } from "./runtime.js";
import type { LineAccountConfig } from "./types.js";

type ReportChannelRoomJoin =
  typeof import("openclaw/plugin-sdk/channel-join-intro-runtime").reportChannelRoomJoin;

const { reportJoin, getGroupSummary, createClient } = vi.hoisted(() => {
  const summary = vi.fn<messagingApi.MessagingApiClient["getGroupSummary"]>();
  return {
    reportJoin: vi.fn<ReportChannelRoomJoin>(async () => ({ kind: "posted" })),
    getGroupSummary: summary,
    createClient: vi.fn(function () {
      return { getGroupSummary: summary };
    }),
  };
});

vi.mock("openclaw/plugin-sdk/channel-join-intro-runtime", () => ({
  reportChannelRoomJoin: reportJoin,
}));
vi.mock("@line/bot-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@line/bot-sdk")>();
  return {
    ...actual,
    messagingApi: { ...actual.messagingApi, MessagingApiClient: createClient },
  };
});

const groupId = `C${"a".repeat(32)}`;
const roomId = `R${"b".repeat(32)}`;
const userId = `U${"c".repeat(32)}`;
const sources = [
  { type: "group", groupId },
  { type: "room", roomId },
] as const;

function joinEvent(source: webhook.Source): webhook.JoinEvent {
  return {
    type: "join",
    source,
    replyToken: "join-reply",
    timestamp: 1_800_000_000_000,
    mode: "active",
    webhookEventId: "join-event",
    deliveryContext: { isRedelivery: false },
  };
}

async function runEvent(event: webhook.Event, config: LineAccountConfig = {}) {
  const work = {
    channelAccessToken: "line-work-token",
    channelSecret: "line-work-secret",
    groupPolicy: "allowlist" as const,
    groupAllowFrom: [userId],
    ...config,
  };
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {}, "room-agent": {} } },
    accessGroups: {
      empty: { type: "message.senders", members: {} },
      other: { type: "message.senders", members: { discord: [userId] } },
      operators: { type: "message.senders", members: { line: [userId] } },
      shared: { type: "message.senders", members: { "*": [userId] } },
      unsupported: { type: "discord.channelAudience", guildId: "guild", channelId: "channel" },
    },
    bindings: [{ agentId: "room-agent", match: { channel: "line", accountId: "work" } }],
    channels: { line: { accounts: { work } } },
  };
  const context = {
    cfg,
    account: resolveLineAccount({ cfg, accountId: "work" }),
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    mediaMaxBytes: 1,
    processMessage: vi.fn(),
  };
  await handleLineWebhookEvents([event], context);
  return context;
}
const introduction = () => expectDefined(reportJoin.mock.calls[0]?.[0], "LINE join introduction");
const roomContext = () => introduction().resolveRoomContext({ messageLimit: 100 });
const noHistory = { historyUnavailable: true };
const emptyAllow = { allowFrom: [] };
const allowed = { allowFrom: [userId] };
type GroupConfig = NonNullable<LineAccountConfig["groups"]>[string];
const groups = (named: GroupConfig, wildcard?: GroupConfig): LineAccountConfig => ({
  groups: { [groupId]: named, ...(wildcard ? { "*": wildcard } : {}) },
});

beforeEach(() => {
  setLineRuntime(createPluginRuntimeMock());
  reportJoin.mockClear();
  createClient.mockClear();
  getGroupSummary.mockReset();
  getGroupSummary.mockResolvedValue({ groupId, groupName: "Incident Response" });
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/channel-join-intro-runtime");
  vi.doUnmock("@line/bot-sdk");
  vi.resetModules();
});

it.each(sources)("introduces in $type without sender authorization", async (source) => {
  const context = await runEvent(joinEvent(source));
  const conversationId = source.type === "group" ? source.groupId : source.roomId;
  expect(reportJoin).toHaveBeenCalledTimes(1);
  const params = introduction();
  expect(params).toMatchObject({
    cfg: context.cfg,
    channel: "line",
    accountId: "work",
    conversationId,
    deliverTo: conversationId,
    roomAllowed: true,
    route: {
      agentId: "room-agent",
      sessionKey: `agent:room-agent:line:group:${conversationId.toLowerCase()}`,
    },
  });
  await expect(roomContext()).resolves.toEqual(
    source.type === "group" ? { ...noHistory, title: "Incident Response" } : noHistory,
  );
  if (source.type === "group") {
    expect(getGroupSummary).toHaveBeenCalledWith(groupId);
    expect(createClient).toHaveBeenCalledWith({ channelAccessToken: "line-work-token" });
  } else {
    expect(getGroupSummary).not.toHaveBeenCalled();
  }
  expect(context.processMessage).not.toHaveBeenCalled();
});

it("keeps an honest thin snapshot when the group summary request fails", async () => {
  getGroupSummary.mockRejectedValue(new Error("LINE unavailable"));
  // An uncached group forces the failed request instead of reusing its name.
  await runEvent(joinEvent({ type: "group", groupId: `C${"d".repeat(32)}` }));
  await expect(roomContext()).resolves.toEqual(noHistory);
});

it.each([
  joinEvent({ type: "user", userId }),
  {
    ...joinEvent(sources[0]),
    type: "memberJoined",
    joined: { members: [{ type: "user", userId }] },
  } satisfies webhook.MemberJoinedEvent,
])("does not introduce for $type from $source.type", async (event) => {
  const context = await runEvent(event);

  expect(reportJoin).not.toHaveBeenCalled();
  expect(getGroupSummary).not.toHaveBeenCalled();
  expect(context.processMessage).not.toHaveBeenCalled();
});

it.each<[string, boolean, LineAccountConfig]>([
  ["empty account allowlist", false, { groupAllowFrom: [] }],
  ["empty group override", false, groups(emptyAllow)],
  ["missing access group", false, { groupAllowFrom: ["accessGroup:missing"] }],
  ["empty access group", false, { groupAllowFrom: ["accessGroup:empty"] }],
  ["another channel's audience", false, { groupAllowFrom: ["accessGroup:other"] }],
  ["unsupported audience", false, { groupAllowFrom: ["accessGroup:unsupported"] }],
  ["entry normalized to empty", false, { groupAllowFrom: ["line:user:"] }],
  ["inherited empty wildcard", false, groups({ requireMention: false }, emptyAllow)],
  ["inherited disabled wildcard", false, groups({ requireMention: false }, { enabled: false })],
  ["disabled policy", false, { groupPolicy: "disabled" }],
  ["disabled group", false, groups({ enabled: false })],
  ["disabled wildcard", false, { groups: { "*": { enabled: false } } }],
  ["open policy without allowlist", true, { groupPolicy: "open", groupAllowFrom: [] }],
  ["static LINE audience", true, { groupAllowFrom: ["accessGroup:operators"] }],
  ["shared audience", true, { groupAllowFrom: ["accessGroup:shared"] }],
  ["sender and missing group", true, { groupAllowFrom: ["accessGroup:missing", userId] }],
  ["override empty wildcard", true, { groupAllowFrom: [], ...groups(allowed, emptyAllow) }],
  ["override disabled wildcard", true, groups({ enabled: true }, { enabled: false })],
])("checks senderless admission: %s", async (_name, roomAllowed, config) => {
  const context = await runEvent(joinEvent(sources[0]), config);
  expect(reportJoin).toHaveBeenCalledWith(
    expect.objectContaining({ conversationId: groupId, roomAllowed }),
  );
  if (!roomAllowed) {
    expect(getGroupSummary).not.toHaveBeenCalled();
  }
  expect(context.processMessage).not.toHaveBeenCalled();
});
