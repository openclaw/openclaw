import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { handleSlackAction, type SlackActionContext } from "./action-runtime.js";
import { createSlackActions } from "./channel-actions.js";
import { listSlackMessageActions } from "./message-actions.js";

const list = vi.hoisted(() => vi.fn());
const createSlackLookupClient = vi.hoisted(() =>
  vi.fn((_token: string) => ({ conversations: { list } })),
);
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createSlackLookupClient,
}));

const direct: SlackActionContext = { conversationReadOrigin: "direct-operator" };
const conversations = [
  { id: "C1", name: "general", is_channel: true, is_member: true, topic: { value: "News" } },
  { id: "C2", name: "random", is_channel: true, is_member: false },
  { id: "G1", name: "secret", is_group: true, is_private: true, is_member: true },
  { id: "D1", is_im: true, user: "U1" },
  { id: "G2", name: "mpdm-a--b-1", is_mpim: true, is_member: true },
];

function slackConfig(overrides: Record<string, unknown> = {}): OpenClawConfig {
  return {
    channels: { slack: { botToken: "xoxb-bot", dm: { groupEnabled: true }, ...overrides } },
  };
}

async function listChannels(
  cfg: OpenClawConfig,
  params: Record<string, unknown> = {},
  context: SlackActionContext = direct,
) {
  const result = await handleSlackAction({ action: "channelList", ...params }, cfg, context);
  return result.details as { channels: Array<{ id: string }>; nextPageToken?: string };
}

beforeEach(() => {
  list.mockReset().mockResolvedValue({ ok: true, channels: conversations });
  createSlackLookupClient.mockClear();
});

it("lists only member channels with the bot token, excluding archived by default", async () => {
  const details = await listChannels(slackConfig());

  expect(createSlackLookupClient.mock.calls[0]?.[0]).toBe("xoxb-bot");
  expect(list).toHaveBeenCalledWith({
    types: "public_channel,private_channel",
    exclude_archived: true,
    limit: 200,
    cursor: undefined,
  });
  expect(details).toEqual({
    ok: true,
    channels: [
      {
        id: "C1",
        name: "general",
        type: "public_channel",
        isMember: true,
        isArchived: false,
        topic: "News",
      },
      { id: "G1", name: "secret", type: "private_channel", isMember: true, isArchived: false },
      { id: "D1", type: "im", isMember: true, isArchived: false, userId: "U1" },
      { id: "G2", name: "mpdm-a--b-1", type: "mpim", isMember: true, isArchived: false },
    ],
  });
});

it("lists every accessible channel with a configured user token", async () => {
  const details = await listChannels(slackConfig({ userToken: "xoxp-user" }));

  expect(createSlackLookupClient.mock.calls[0]?.[0]).toBe("xoxp-user");
  expect(details.channels.map((channel) => channel.id)).toEqual(["C1", "C2", "G1", "D1", "G2"]);
});

it("forwards type filters, archived opt-in, and cursor paging", async () => {
  list.mockResolvedValueOnce({
    ok: true,
    channels: [],
    response_metadata: { next_cursor: "dGVhbTpDMg==" },
  });
  const details = await listChannels(slackConfig(), {
    types: ["im", "public_channel"],
    includeArchived: true,
    limit: 5000,
    pageToken: "dGVhbTpDMQ==",
  });

  expect(list).toHaveBeenCalledWith({
    types: "public_channel,im",
    exclude_archived: false,
    limit: 1000,
    cursor: "dGVhbTpDMQ==",
  });
  expect(details).toEqual({ ok: true, channels: [], nextPageToken: "dGVhbTpDMg==" });
  await expect(listChannels(slackConfig(), { types: ["dm"] })).rejects.toThrow(
    "types must be one or more of",
  );
});

it("applies read policy and surfaces missing Slack scopes", async () => {
  const cfg = slackConfig({
    userToken: "xoxp-user",
    groupPolicy: "allowlist",
    channels: { C1: { enabled: true }, C2: { enabled: false } },
  });
  const delegated = await listChannels(cfg, {}, {});
  expect(delegated.channels.map((channel) => channel.id)).toEqual(["C1", "G2"]);
  const operator = await listChannels(cfg);
  expect(operator.channels.map((channel) => channel.id)).toEqual(["C1", "G1", "D1", "G2"]);

  list.mockRejectedValueOnce(
    Object.assign(new Error("An API error occurred: missing_scope"), {
      data: { error: "missing_scope", needed: "groups:read" },
    }),
  );
  await expect(listChannels(cfg)).rejects.toThrow("missing_scope (needed: groups:read)");
});

it("gates discovery and execution on actions.channelInfo", async () => {
  const cfg = slackConfig({ actions: { channelInfo: false } });
  expect(listSlackMessageActions(slackConfig())).toContain("channel-list");
  expect(listSlackMessageActions(cfg)).not.toContain("channel-list");
  await expect(listChannels(cfg)).rejects.toThrow("Slack channel list is disabled.");
  expect(list).not.toHaveBeenCalled();

  const invoke = vi.fn(async () => ({ content: [], details: { ok: true } }));
  await createSlackActions("slack", { invoke }).handleAction?.({
    channel: "slack",
    action: "channel-list",
    cfg: slackConfig(),
    params: { types: ["im"], limit: 10, pageToken: "next", includeArchived: true },
  });
  expect(invoke).toHaveBeenCalledWith(
    {
      action: "channelList",
      types: ["im"],
      limit: 10,
      pageToken: "next",
      includeArchived: true,
      teamId: undefined,
      accountId: undefined,
    },
    expect.anything(),
    undefined,
  );
});
