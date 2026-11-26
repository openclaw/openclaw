import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { handleSlackAction, type SlackActionContext } from "./action-runtime.js";
import { createSlackActions } from "./channel-actions.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";
import { listSlackMessageActions } from "./message-actions.js";
import { buildSlackThreadingToolContext } from "./threading-tool-context.js";

const list = vi.hoisted(() => vi.fn());
const history = vi.hoisted(() => vi.fn());
const authTest = vi.hoisted(() => vi.fn());
const createSlackLookupClient = vi.hoisted(() =>
  vi.fn((token: string) => ({
    auth: { test: async () => await authTest(token) },
    conversations: { list, history },
  })),
);
const createSlackReadClient = vi.hoisted(() =>
  vi.fn((_token: string) => ({
    conversations: { info: async () => ({ channel: { is_im: true, user: "U1" } }) },
  })),
);
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createSlackLookupClient,
  createSlackReadClient,
}));

let installation: ReturnType<typeof registerSlackInstallationState> | undefined;
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
  return result.details as {
    teamId?: string;
    channels: Array<{ id: string }>;
    nextPageToken?: string;
  };
}

function lookupTokens() {
  return createSlackLookupClient.mock.calls.map(([token]) => token);
}

beforeEach(() => {
  list.mockReset().mockResolvedValue({ ok: true, channels: conversations });
  history.mockReset().mockResolvedValue({ ok: true, messages: [], has_more: false });
  authTest.mockReset().mockResolvedValue({ ok: true, team_id: "T1" });
  installation?.release();
  installation = undefined;
  createSlackLookupClient.mockClear();
  createSlackReadClient.mockClear();
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
    teamId: "T1",
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
  expect(details).toEqual({
    ok: true,
    teamId: "T1",
    channels: [],
    nextPageToken: "dGVhbTpDMg==",
  });
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
    params: { types: ["im"], limit: 10, pageToken: "next", includeArchived: true, readAs: "bot" },
  });
  expect(invoke).toHaveBeenCalledWith(
    {
      action: "channelList",
      types: ["im"],
      limit: 10,
      pageToken: "next",
      includeArchived: true,
      teamId: undefined,
      readAs: "bot",
      accountId: undefined,
    },
    expect.anything(),
    undefined,
  );
});

it("applies workspace-qualified denials when the caller omits teamId", async () => {
  const cfg = slackConfig({
    groupPolicy: "open",
    channels: { "team:T1:channel:C1": { enabled: false } },
  });
  const listed = await listChannels(cfg, {}, {});
  expect(listed.teamId).toBe("T1");
  expect(listed.channels.map((channel) => channel.id)).toEqual(["G1", "G2"]);

  await expect(
    handleSlackAction({ action: "readMessages", channelId: "C1" }, cfg, {}),
  ).rejects.toThrow("Slack read target channel is not allowed.");
  await expect(
    handleSlackAction({ action: "readMessages", channelId: "C1", readAs: "bot" }, cfg, direct),
  ).rejects.toThrow("Slack read target channel is not allowed.");
  expect(history).not.toHaveBeenCalled();
});

it("labels each token with its own workspace and rejects a mismatched teamId", async () => {
  installation = registerSlackInstallationState("default", "workspace", "TBOT");
  authTest.mockImplementation(async (token: string) => ({
    ok: true,
    team_id: token === "xoxp-user" ? "TUSER" : "TOTHER",
  }));
  const cfg = slackConfig({ userToken: "xoxp-user" });

  expect((await listChannels(cfg, { readAs: "bot" })).teamId).toBe("TBOT");
  expect(authTest).not.toHaveBeenCalled();
  expect((await listChannels(cfg, { readAs: "user" })).teamId).toBe("TUSER");
  expect(authTest).toHaveBeenCalledWith("xoxp-user");
  await expect(listChannels(cfg, { readAs: "user", teamId: "TBOT" })).rejects.toThrow(
    "Slack teamId TBOT does not match workspace TUSER of the selected token.",
  );
  expect((await listChannels(cfg, { readAs: "user", teamId: "TUSER" })).teamId).toBe("TUSER");
});

it.each([
  { readAs: undefined, token: "xoxp-user", dm: "D7", ids: ["C1", "C2", "G1", "D1", "G2"] },
  { readAs: "bot", token: "xoxb-bot", dm: "D8", ids: ["C1", "G1", "D1", "G2"] },
  { readAs: "user", token: "xoxp-user", dm: "D9", ids: ["C1", "C2", "G1", "D1", "G2"] },
])("lists and reads with readAs $readAs", async ({ readAs, token, dm, ids }) => {
  const cfg = slackConfig({ userToken: "xoxp-user", allowFrom: ["U1"] });
  const details = await listChannels(cfg, { readAs });
  expect(details.channels.map((channel) => channel.id)).toEqual(ids);

  // A delegated DM read resolves the DM owner, so both lookups prove the selected token.
  await handleSlackAction({ action: "readMessages", channelId: dm, readAs }, cfg, {});
  expect(createSlackReadClient.mock.calls.map(([used]) => used)).toEqual([token]);
  // channel-list: auth.test + conversations.list; read: conversations.history.
  expect(lookupTokens()).toEqual([token, token, token]);
});

it("rejects readAs when the requested token is not configured", async () => {
  await expect(listChannels(slackConfig(), { readAs: "user" })).rejects.toThrow(
    'Slack readAs "user" requires a configured user token',
  );
  await expect(
    handleSlackAction(
      { action: "readMessages", channelId: "C1", readAs: "user" },
      slackConfig(),
      direct,
    ),
  ).rejects.toThrow('Slack readAs "user" requires a configured user token');
  await expect(
    listChannels({ channels: { slack: { userToken: "xoxp-user" } } }, { readAs: "bot" }),
  ).rejects.toThrow('Slack readAs "bot" requires a configured bot token');
  await expect(listChannels(slackConfig(), { readAs: "admin" })).rejects.toThrow(
    'Slack readAs must be "bot" or "user".',
  );
  expect(list).not.toHaveBeenCalled();
  expect(history).not.toHaveBeenCalled();
});

it("does not reuse a user-identity monitor workspace for the companion bot token", async () => {
  installation = registerSlackInstallationState("default", "workspace", "TUSER");
  authTest.mockImplementation(async (token: string) => ({
    ok: true,
    team_id: token === "xoxb-bot" ? "TBOT" : "TUSER",
  }));
  const cfg = slackConfig({
    postAs: "user",
    userToken: "xoxp-user",
    groupPolicy: "open",
    channels: { "team:TBOT:channel:C1": { enabled: false } },
  });

  const listed = await listChannels(cfg, { readAs: "bot" }, {});
  expect(listed.teamId).toBe("TBOT");
  expect(listed.channels.map((channel) => channel.id)).not.toContain("C1");
  await expect(
    handleSlackAction({ action: "readMessages", channelId: "C1", readAs: "bot" }, cfg, {}),
  ).rejects.toThrow("Slack read target channel is not allowed.");
  expect(history).not.toHaveBeenCalled();
  expect((await listChannels(cfg, { readAs: "user" })).teamId).toBe("TUSER");
});

it.each([
  { name: "no workspace-qualified policy", channels: {} },
  { name: "an unrelated workspace-qualified entry", channels: { "team:T1:channel:C9": {} } },
])("keeps the unqualified current DM readable with $name", async ({ channels }) => {
  const cfg = slackConfig({ channels });
  const context = {
    ...buildSlackThreadingToolContext({
      cfg,
      accountId: null,
      context: { ChatType: "direct", Channel: "slack", To: "user:U123", NativeChannelId: "D123" },
    }),
    currentChannelProvider: "slack",
    requesterAccountId: "default",
  };
  list.mockResolvedValueOnce({ ok: true, channels: [{ id: "D123", is_im: true, user: "U123" }] });

  const listed = await listChannels(cfg, { types: ["im"] }, context);
  expect(listed.channels.map((channel) => channel.id)).toEqual(["D123"]);
  await handleSlackAction({ action: "readMessages", channelId: "D123" }, cfg, context);
  expect(history).toHaveBeenCalledWith(expect.objectContaining({ channel: "D123" }));
});
