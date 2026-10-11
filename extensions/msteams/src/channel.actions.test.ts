import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { MSTeamsConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { msteamsPlugin } from "./channel.js";

const runtime = vi.hoisted(() => ({
  addParticipantMSTeams: vi.fn(),
  editMessageMSTeams: vi.fn(),
  deleteMessageMSTeams: vi.fn(),
  getChannelInfoMSTeams: vi.fn(),
  getMemberInfoMSTeams: vi.fn(),
  getMessageMSTeams: vi.fn(),
  listChannelsMSTeams: vi.fn(),
  listReactionsMSTeams: vi.fn(),
  pinMessageMSTeams: vi.fn(),
  reactMessageMSTeams: vi.fn(),
  removeParticipantMSTeams: vi.fn(),
  renameGroupMSTeams: vi.fn(),
  sendAdaptiveCardMSTeams: vi.fn(),
  sendMessageMSTeams: vi.fn(),
  unpinMessageMSTeams: vi.fn(),
  unreactMessageMSTeams: vi.fn(),
}));
vi.mock("./channel.runtime.js", () => ({ msTeamsChannelRuntime: runtime }));

const cfg: OpenClawConfig = { channels: { msteams: { groupPolicy: "open", dmPolicy: "open" } } };
const conversation = "conversation:19:current@thread.tacv2";
const graphTeam = "11111111-1111-1111-1111-111111111111";
const graphChannel = "19:channel@thread.tacv2";
const graphTarget = `${graphTeam}/${graphChannel}`;
const message = { id: "msg-1", text: "hello" };
const handle = msteamsPlugin.actions!.handleAction!;
const buildContext = msteamsPlugin.threading!.buildToolContext!;
type Action = ChannelMessageActionContext["action"];
type Context = Partial<Omit<ChannelMessageActionContext, "action" | "params">>;

function run(action: Action, params: Record<string, unknown> = {}, context: Context = {}) {
  return handle({ channel: "msteams", cfg, action, params, ...context });
}

function current(context: Parameters<typeof buildContext>[0]["context"]): Context {
  return {
    accountId: "default",
    requesterAccountId: "default",
    toolContext: {
      currentChannelProvider: "msteams",
      ...buildContext({ cfg, context }),
    },
  };
}

async function success(
  action: Action,
  params: Record<string, unknown>,
  mock: ReturnType<typeof vi.fn>,
  response: Record<string, unknown>,
  expectedArgs: Record<string, unknown>,
  details: Record<string, unknown>,
  context: Context = {},
  content = details,
) {
  mock.mockResolvedValue(response);
  expect(await run(action, params, context)).toEqual({
    content: [{ type: "text", text: JSON.stringify(content) }],
    details,
  });
  expect(mock).toHaveBeenCalledWith({
    cfg: context.cfg ?? cfg,
    accountId: context.accountId,
    ...expectedArgs,
  });
}

function ok(action: string, result: Record<string, unknown> = {}) {
  return { ok: true, channel: "msteams", action, ...result };
}

async function error(
  action: Action,
  params: Record<string, unknown>,
  errorMessage: string,
  context: Context = {},
) {
  expect(await run(action, params, context)).toEqual({
    isError: true,
    content: [{ type: "text", text: errorMessage }],
    details: { error: errorMessage },
  });
}

beforeEach(() => {
  for (const mock of Object.values(runtime)) {
    mock.mockReset();
  }
});

describe("Teams action routing and authority", () => {
  it.each([{ selected: undefined, expected: "support" }])(
    "preserves the selected/default account for presentation sends: $expected",
    async ({ selected, expected }) => {
      const accountCfg: OpenClawConfig = {
        channels: {
          msteams: {
            defaultAccount: "support",
            accounts: { support: { appId: "support-app" } },
          },
        },
      };
      runtime.sendAdaptiveCardMSTeams.mockResolvedValue({
        messageId: "sent-1",
        conversationId: "conv-1",
      });
      await run(
        "send",
        { to: conversation, presentation: { blocks: [{ type: "text", text: "Hello" }] } },
        { cfg: accountCfg, accountId: selected },
      );
      expect(runtime.sendAdaptiveCardMSTeams).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: expected, to: conversation }),
      );
    },
  );

  it("reads the trusted current conversation under restrictive policies", async () => {
    await success(
      "read",
      { messageId: " msg-1 " },
      runtime.getMessageMSTeams,
      message,
      { to: conversation, messageId: "msg-1" },
      ok("read", { message }),
      {
        ...current({ To: ` ${conversation} ` }),
        cfg: { channels: { msteams: { groupPolicy: "allowlist", dmPolicy: "pairing" } } },
      },
    );
  });

  it("rejects a channel context without a compound Graph route", async () => {
    const context = current({
      ChatType: "channel",
      To: conversation,
      NativeChannelId: graphChannel,
    });
    expect(context.toolContext?.currentGraphChannelId).toBeUndefined();
    await error(
      "read",
      { messageId: "msg-1" },
      "Read requires a target (to) and messageId.",
      context,
    );
    expect(runtime.getMessageMSTeams).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "opaque chat without both scopes",
      to: "conversation:19:direct@thread.v2",
      policy: { groupPolicy: "open", dmPolicy: "pairing" },
    },
    {
      name: "DM history config without read authority",
      to: "user:aad-user-1",
      policy: { dmPolicy: "allowlist", allowFrom: [], dms: { "aad-user-1": { historyLimit: 5 } } },
    },
    {
      name: "unconfigured channel",
      to: "team-1/channel-2",
      policy: {
        groupPolicy: "allowlist",
        teams: { "team-1": { channels: { "channel-1": {} } } },
      },
    },
  ] satisfies Array<{ name: string; to: string; policy: MSTeamsConfig }>)(
    "rejects $name before Graph",
    async ({ to, policy }) => {
      await expect(
        run(
          "read",
          { to, messageId: "msg-1" },
          {
            cfg: { channels: { msteams: policy } },
          },
        ),
      ).rejects.toThrow("Microsoft Teams read target is not allowed.");
      expect(runtime.getMessageMSTeams).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])("uses only host-granted upload authority (grant=%s)", async (granted) => {
    const mediaReadFile = vi.fn(async () => Buffer.from("pdf"));
    const mediaAccess = {
      localRoots: ["/approved"],
      workspaceDir: "/approved",
      readFile: mediaReadFile,
    };
    const forged = { localRoots: ["/forged"], workspaceDir: "/forged", readFile: vi.fn() };
    const forgedContext = {
      currentChannelId: conversation,
      mediaAccess: forged,
      mediaReadFile: forged.readFile,
      mediaLocalRoots: forged.localRoots,
    };
    const authority = granted ? { mediaAccess, mediaReadFile, mediaLocalRoots: ["/tmp"] } : {};
    await success(
      "upload-file",
      {
        target: ` ${conversation} `,
        path: " report.pdf ",
        ...(granted ? { message: "Quarterly report", filename: "Q1.pdf" } : {}),
        mediaAccess: forged,
        mediaReadFile: forged.readFile,
        mediaLocalRoots: forged.localRoots,
      },
      runtime.sendMessageMSTeams,
      { messageId: "upload-1", conversationId: "conv-1" },
      {
        to: conversation,
        mediaUrl: " report.pdf ",
        text: granted ? "Quarterly report" : "",
        filename: granted ? "Q1.pdf" : undefined,
        mediaAccess: granted ? mediaAccess : undefined,
        mediaReadFile: granted ? mediaReadFile : undefined,
        mediaLocalRoots: granted ? ["/tmp"] : undefined,
      },
      ok("upload-file", { messageId: "upload-1", conversationId: "conv-1" }),
      {
        ...authority,
        toolContext: forgedContext,
      },
    );
    expect(runtime.sendMessageMSTeams.mock.calls[0]?.[0]?.mediaAccess).toBe(
      granted ? mediaAccess : undefined,
    );
  });

  it.each([false, true])(
    "limits member requester authority to the current chat (current=%s)",
    async (isCurrent) => {
      const groupTarget = "conversation:19:group@thread.v2";
      const to = isCurrent ? groupTarget : graphTarget;
      const context = current({
        ChatType: msteamsPlugin.messaging!.inferTargetChatType!({ to: groupTarget }),
        To: groupTarget,
        ReplyToId: "quoted-parent",
      });
      expect(context.toolContext?.currentThreadTs).toBeUndefined();
      expect(context.toolContext?.replyToMode).toBeUndefined();
      await success(
        "member-info",
        { to, userId: " user-1 " },
        runtime.getMemberInfoMSTeams,
        { member: { id: "user-1" } },
        { to, userId: "user-1", currentRequesterId: isCurrent ? "user-1" : undefined },
        ok("member-info", { member: { id: "user-1" } }),
        {
          ...context,
          requesterSenderId: "user-1",
          cfg: { channels: { msteams: { groupPolicy: "open", dmPolicy: "disabled" } } },
        },
      );
    },
  );

  it("lists channels in an authorized team", async () => {
    await success(
      "channel-list",
      { teamId: ` ${graphTeam} ` },
      runtime.listChannelsMSTeams,
      { channels: [{ id: graphChannel }] },
      { teamId: graphTeam },
      ok("channel-list", { channels: [{ id: graphChannel }] }),
    );
  });

  it("reads channel information using explicit team/channel ids", async () => {
    await success(
      "channel-info",
      { teamId: ` ${graphTeam} `, channelId: ` ${graphChannel} ` },
      runtime.getChannelInfoMSTeams,
      { channel: { id: graphChannel } },
      { teamId: graphTeam, channelId: graphChannel },
      ok("channel-info", { channelInfo: { id: graphChannel } }),
    );
  });

  it("requires a trusted Teams requester for group management", () => {
    const requires = msteamsPlugin.actions!.requiresTrustedRequesterSender!;
    for (const action of ["addParticipant", "removeParticipant", "renameGroup"] as const) {
      expect(requires({ action, toolContext: { currentChannelProvider: "msteams" } })).toBe(true);
    }
    expect(
      requires({ action: "addParticipant", toolContext: { currentChannelProvider: "discord" } }),
    ).toBe(false);
    expect(requires({ action: "read", toolContext: { currentChannelProvider: "msteams" } })).toBe(
      false,
    );
  });

  it("rejects group management without owner or admin authority", async () => {
    for (const action of ["addParticipant", "removeParticipant", "renameGroup"] as const) {
      await error(
        action,
        { target: conversation, userId: "user-1", name: "Renamed" },
        "Microsoft Teams group management requires an owner or operator.admin requester.",
        { senderIsOwner: false, gatewayClientScopes: ["operator.write"] },
      );
    }
    expect(runtime.addParticipantMSTeams).not.toHaveBeenCalled();
    expect(runtime.removeParticipantMSTeams).not.toHaveBeenCalled();
    expect(runtime.renameGroupMSTeams).not.toHaveBeenCalled();
  });

  it("allows an owner to add a participant", async () => {
    const added = { userId: "user-1", chatId: conversation };
    await success(
      "addParticipant",
      { target: conversation, userId: " user-1 ", role: " owner " },
      runtime.addParticipantMSTeams,
      { added },
      { to: conversation, userId: "user-1", role: "owner" },
      ok("addParticipant", { added }),
      { senderIsOwner: true },
    );
  });

  it("allows an admin to remove participants and rename the group", async () => {
    const authority = { senderIsOwner: false, gatewayClientScopes: ["operator.admin"] };
    const removed = { userId: "user-1", chatId: conversation };
    await success(
      "removeParticipant",
      { target: conversation, userId: " user-1 " },
      runtime.removeParticipantMSTeams,
      { removed },
      { to: conversation, userId: "user-1" },
      ok("removeParticipant", { removed }),
      authority,
    );
    const renamed = { chatId: conversation, newName: "Renamed" };
    await success(
      "renameGroup",
      { target: conversation, name: " Renamed " },
      runtime.renameGroupMSTeams,
      { renamed },
      { to: conversation, name: "Renamed" },
      ok("renameGroup", { renamed }),
      authority,
    );
  });

  it("unpins the resource id returned by pin, even when a message id is also supplied", async () => {
    const result = { channel: "msteams", action: "pin", ok: true, pinnedMessageId: "pin-1" };
    await success(
      "pin",
      { target: ` ${conversation} `, messageId: " msg-1 " },
      runtime.pinMessageMSTeams,
      { ok: true, pinnedMessageId: "pin-1" },
      { to: conversation, messageId: "msg-1" },
      result,
    );
    await success(
      "unpin",
      { target: conversation, pinnedMessageId: ` ${result.pinnedMessageId} `, messageId: "msg-1" },
      runtime.unpinMessageMSTeams,
      { ok: true },
      { to: conversation, pinnedMessageId: "pin-1" },
      { channel: "msteams", action: "unpin", ok: true },
    );
  });

  it("edits message content and returns the resolved conversation", async () => {
    await success(
      "edit",
      { to: conversation, messageId: "msg-1", content: "updated" },
      runtime.editMessageMSTeams,
      { conversationId: "edited" },
      { to: conversation, activityId: "msg-1", text: "updated" },
      { ok: true, channel: "msteams" },
      {},
      { ok: true, channel: "msteams", conversationId: "edited" },
    );
  });

  it("rejects unpin without either id", async () => {
    await error(
      "unpin",
      { target: conversation },
      "Unpin requires a target (to) and pinnedMessageId.",
    );
  });

  it("routes a channel reaction through its prepared Graph target", async () => {
    const context = current({
      ChatType: "channel",
      To: conversation,
      NativeChannelId: graphTarget,
      ReplyToId: "root",
    });
    expect(context.toolContext).toMatchObject({
      currentChannelId: conversation,
      currentMessagingTarget: graphTarget,
      currentGraphChannelId: graphTarget,
      currentThreadTs: "root",
      replyToMode: "all",
    });
    await success(
      "react",
      { target: conversation, messageId: " msg-1 ", emoji: " like " },
      runtime.reactMessageMSTeams,
      { ok: true },
      { to: graphTarget, messageId: "msg-1", reactionType: "like" },
      { channel: "msteams", action: "react", reactionType: "like", ok: true },
      {
        ...context,
        cfg: { channels: { msteams: { groupPolicy: "allowlist", groupAllowFrom: ["user-1"] } } },
      },
    );
  });

  it("removes a reaction in a paired DM without inheriting quoted-message threading", async () => {
    const context = current({
      ChatType: "direct",
      To: "user:aad-user-1",
      ReplyToId: "quoted-parent",
    });
    expect(context.toolContext).toMatchObject({
      currentChannelId: "user:aad-user-1",
      currentChatType: "direct",
    });
    expect(context.toolContext?.currentGraphChannelId).toBeUndefined();
    expect(context.toolContext?.currentThreadTs).toBeUndefined();
    expect(context.toolContext?.replyToMode).toBeUndefined();
    await success(
      "react",
      { messageId: " msg-1 ", emoji: " like ", remove: true },
      runtime.unreactMessageMSTeams,
      { ok: true },
      { to: "user:aad-user-1", messageId: "msg-1", reactionType: "like" },
      { channel: "msteams", action: "react", removed: true, reactionType: "like", ok: true },
      {
        ...context,
        cfg: { channels: { msteams: { groupPolicy: "allowlist", dmPolicy: "pairing" } } },
      },
    );
  });

  it.each(["reactions"] as const)("uses the current inbound id for %s", async (action) => {
    const mock = runtime.listReactionsMSTeams;
    mock.mockResolvedValue({ reactions: [] });
    const context = current({ ChatType: "group", To: conversation });
    await expect(
      run(
        action,
        {},
        {
          ...context,
          toolContext: { ...context.toolContext, currentMessageId: 1751234567890 },
        },
      ),
    ).resolves.not.toMatchObject({ isError: true });
    expect(mock).toHaveBeenCalledWith(
      expect.objectContaining({ cfg, to: conversation, messageId: "1751234567890" }),
    );
  });

  it.each([
    { action: "react", params: { emoji: "like" }, mock: runtime.reactMessageMSTeams },
    {
      action: "react",
      params: { emoji: "like", remove: true },
      mock: runtime.unreactMessageMSTeams,
    },
    { action: "reactions", params: {}, mock: runtime.listReactionsMSTeams },
  ] as const)(
    "addresses the current channel reply for $action $params beneath its thread root",
    async ({ action, params, mock }) => {
      mock.mockResolvedValue({ ok: true, reactions: [] });
      const base = current({
        ChatType: "channel",
        To: conversation,
        NativeChannelId: graphTarget,
        MessageThreadId: "root-1",
      });
      const context = {
        ...base,
        toolContext: { ...base.toolContext, currentMessageId: "reply-1" },
      };

      await run(action, params, context);
      await run(action, { ...params, messageId: "other-1" }, context);

      expect(mock.mock.calls.map(([call]) => [call.messageId, call.threadRootId])).toEqual([
        ["reply-1", "root-1"],
        ["other-1", undefined],
      ]);
    },
  );

  it.each([
    { action: "react", params: { to: "conversation:19:other@thread.tacv2", emoji: "like" } },
    { action: "delete", params: { to: conversation } },
  ] as const)(
    "requires an explicit message id for $action outside the reaction fallback",
    async ({ action, params }) => {
      await expect(
        run(action, params, {
          toolContext: {
            currentChannelProvider: "msteams",
            currentChannelId: conversation,
            currentMessageId: 1751234567890,
            currentChatType: "group",
          },
        }),
      ).resolves.toMatchObject({ isError: true });
      expect(runtime.reactMessageMSTeams).not.toHaveBeenCalled();
      expect(runtime.deleteMessageMSTeams).not.toHaveBeenCalled();
    },
  );

  it("requires a target when sending presentation cards", async () => {
    await error(
      "send",
      { presentation: { blocks: [{ type: "text", text: "hello" }] } },
      "Card send requires a target (to).",
    );
  });

  it("preserves card text and buttons while downgrading unsupported selects", async () => {
    await success(
      "send",
      {
        to: conversation,
        message: "Deploy finished",
        presentation: {
          blocks: [
            { type: "buttons", buttons: [{ label: "Open", value: "open" }] },
            {
              type: "select",
              placeholder: "Pick a lane",
              options: [
                { label: "Canary", value: "canary" },
                { label: "Stable", value: "stable" },
              ],
            },
          ],
        },
      },
      runtime.sendAdaptiveCardMSTeams,
      { messageId: "card-1", conversationId: "conv-1" },
      {
        to: conversation,
        card: {
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: "Deploy finished", wrap: true },
            {
              type: "TextBlock",
              text: "Pick a lane:\n- Canary\n- Stable",
              wrap: true,
              isSubtle: true,
              size: "Small",
            },
          ],
          actions: [
            { type: "Action.Submit", title: "Open", data: { value: "open", label: "Open" } },
          ],
        },
      },
      { ok: true, channel: "msteams", messageId: "card-1", conversationId: "conv-1" },
    );
  });

  it("reports valid reaction types when emoji is missing", async () => {
    const validTypes = ["like", "heart", "laugh", "surprised", "sad", "angry"];
    expect(await run("react", { to: conversation, messageId: "msg-1" })).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "React requires an emoji (reaction type). Valid types: like, heart, laugh, surprised, sad, angry.",
        },
      ],
      details: { error: "React requires an emoji (reaction type).", validTypes },
    });
  });

  it("requires a nonblank search query", async () => {
    await error(
      "search",
      { to: conversation, query: "   " },
      "Search requires a target (to) and query.",
    );
  });

  it.each([
    {
      action: "edit",
      params: { messageId: "msg-1", content: "updated" },
      mock: runtime.editMessageMSTeams,
    },
    { action: "delete", params: { messageId: "msg-1" }, mock: runtime.deleteMessageMSTeams },
    { action: "pin", params: { messageId: "msg-1" }, mock: runtime.pinMessageMSTeams },
    { action: "unpin", params: { pinnedMessageId: "pin-1" }, mock: runtime.unpinMessageMSTeams },
    {
      action: "react",
      params: { messageId: "msg-1", emoji: "like" },
      mock: runtime.reactMessageMSTeams,
    },
  ] as const)(
    "blocks $action outside the current authorized conversation",
    async ({ action, params, mock }) => {
      await expect(
        run(
          action,
          { to: graphTarget, ...params },
          {
            ...current({ ChatType: "group", To: conversation }),
            cfg: { channels: { msteams: { groupPolicy: "allowlist", dmPolicy: "pairing" } } },
          },
        ),
      ).rejects.toThrow("Microsoft Teams read target is not allowed.");
      expect(mock).not.toHaveBeenCalled();
    },
  );
});
