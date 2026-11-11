import "./monitor-helpers.test-support.js";
import "./monitor-onchar.test-support.js";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it } from "vitest";
import { setMattermostRuntime } from "../runtime.js";
import type { ResolvedMattermostAccount } from "./accounts.js";
import { resolveMattermostAccount } from "./accounts.js";
import {
  authorizeMattermostCommandInvocation,
  resolveMattermostMonitorInboundAccess,
} from "./monitor-auth.js";
import {
  buildMattermostButtonInteractionMessageSid,
  formatMattermostFinalDeliveryOutcomeLog,
  resolveMattermostInteractionReplyRootId,
  resolveMattermostThreadSessionContext,
  shouldUpdateMattermostDraftToolProgress,
} from "./monitor-context.js";

describe("Mattermost monitor context", () => {
  it.each([
    ["direct", "root", "interaction:post:approve", "root"],
    ["channel", undefined, "other-post", "other-post"],
    ["direct", undefined, "interaction:post:approve", undefined],
  ] as const)(
    "resolves %s interaction with root %s and reply %s",
    (kind, threadRootId, replyToId, expected) => {
      const interactionMessageSid = buildMattermostButtonInteractionMessageSid({
        postId: "post",
        actionId: "approve",
      });
      expect(interactionMessageSid).toBe("interaction:post:approve");
      expect(
        resolveMattermostInteractionReplyRootId({
          kind,
          threadRootId,
          replyToId,
          interactionMessageSid,
          sourcePostId: "post",
        }),
      ).toBe(expected);
    },
  );

  it("starts direct threads without a parent session", () => {
    expect(
      resolveMattermostThreadSessionContext({
        kind: "direct",
        replyToMode: "first",
        baseSessionKey: "base",
        postId: "post",
      }),
    ).toEqual({
      effectiveReplyToId: "post",
      sessionKey: "base:thread:post",
      parentSessionKey: undefined,
    });
  });

  it("disables tool progress when streaming is off", () => {
    expect(
      shouldUpdateMattermostDraftToolProgress(
        account({
          streaming: { mode: "off", progress: { toolProgress: true } },
        }),
      ),
    ).toBe(false);
  });

  it.each([
    ["media", { mediaUrl: "https://example.com/a.png" }, "delivered reply to channel:town-square"],
    ["empty", { text: " \n\t " }, undefined],
    [
      "empty",
      { text: "work result" },
      "mattermost no-visible-reply: no-visible-reply-after-final-delivery to=channel:town-square accountId=default agentId=agent-1 outcome=empty finalTextLength=11 mediaUrlCount=0",
    ],
  ] as const)("reports %s delivery for %j", (outcome, payload, expected) => {
    expect(
      formatMattermostFinalDeliveryOutcomeLog({
        outcome,
        payload,
        to: "channel:town-square",
        accountId: "default",
        agentId: "agent-1",
      }),
    ).toBe(expected);
  });
});

const account = (config: ResolvedMattermostAccount["config"]) =>
  resolveMattermostAccount({
    cfg: {
      channels: {
        mattermost: { botToken: "bot-token", baseUrl: "https://chat.example.com", ...config },
      },
    },
    accountId: "default",
  });
const channelInfo = { id: "chan-1", type: "O", name: "general", display_name: "General" };
const command = {
  cfg: {},
  channelId: "chan-1",
  channelInfo,
  storeAllowFrom: [],
  allowTextCommands: true,
  hasControlCommand: true,
  senderId: "trusted-user",
  senderName: "Trusted User",
};
const directCommand = {
  channelId: "dm-1",
  channelInfo: { id: "dm-1", type: "D", name: "alice", display_name: "Alice" },
  senderId: "alice",
  senderName: "Alice",
};
const direct = {
  kind: "direct",
  chatType: "direct",
  channelName: "alice",
  channelDisplay: "Alice",
  roomLabel: "#alice",
};
const inbound = {
  cfg: {},
  senderId: "trusted-user",
  senderName: "Trusted User",
  channelId: "chan-1",
  groupPolicy: "allowlist" as const,
  storeAllowFrom: ["user:attacker"],
  allowTextCommands: false,
  hasControlCommand: false,
};

describe("mattermost monitor authz", () => {
  beforeEach(() => setMattermostRuntime(createPluginRuntimeMock()));

  it.each([
    ["direct", ["@group-owner"], ["trusted-user", "attacker"]],
    ["channel", ["@group-owner"], ["group-owner"]],
    ["channel", undefined, ["trusted-user"]],
  ] as const)(
    "isolates %s admission with group list %s",
    async (kind, groupAllowFrom, expected) => {
      const resolved = await resolveMattermostMonitorInboundAccess({
        ...inbound,
        storeAllowFrom: [...inbound.storeAllowFrom],
        kind,
        account: account({
          allowFrom: ["@trusted-user"],
          ...(groupAllowFrom ? { groupAllowFrom: [...groupAllowFrom] } : {}),
        }),
      });
      expect(
        kind === "direct"
          ? resolved.senderAccess.effectiveAllowFrom
          : resolved.senderAccess.effectiveGroupAllowFrom,
      ).toEqual(expected);
    },
  );

  it.each([
    {
      name: "denies unauthorized group command senders",
      params: {
        account: account({ groupPolicy: "allowlist", allowFrom: ["trusted-user"] }),
        senderId: "attacker",
        senderName: "attacker",
      },
      result: { ok: false, denyReason: "unauthorized", commandAuthorized: false },
    },
    {
      name: "denies commands without trusted channel type",
      params: {
        channelId: "dm-1",
        channelInfo: { id: "dm-1", name: "", display_name: "" },
        account: account({ dmPolicy: "open", groupPolicy: "open", allowFrom: ["*"] }),
      },
      result: { ok: false, denyReason: "unknown-channel", commandAuthorized: false },
    },
    {
      name: "denies open DM commands without an allowlist",
      params: { ...directCommand, account: account({ dmPolicy: "open" }) },
      result: { ...direct, ok: false, denyReason: "unauthorized", commandAuthorized: false },
    },
    {
      name: "authorizes open DM commands through a wildcard allowlist",
      params: { ...directCommand, account: account({ dmPolicy: "open", allowFrom: ["*"] }) },
      result: { ...direct, ok: true, commandAuthorized: true },
    },
    {
      name: "denies DM commands when direct messages are disabled",
      params: { ...directCommand, account: account({ dmPolicy: "disabled" }) },
      result: { ...direct, ok: false, denyReason: "dm-disabled", commandAuthorized: false },
    },
    {
      name: "denies channel commands without a group allowlist",
      params: { account: account({ groupPolicy: "allowlist" }), hasControlCommand: false },
      result: {
        ok: false,
        denyReason: "channel-no-allowlist",
        kind: "channel",
        roomLabel: "#general",
      },
    },
    {
      name: "authorizes group senders through static access groups",
      params: {
        channelInfo: { ...channelInfo, type: "g" },
        account: account({ groupPolicy: "allowlist", groupAllowFrom: ["accessGroup:oncall"] }),
        cfg: {
          accessGroups: {
            oncall: {
              type: "message.senders" as const,
              members: { mattermost: ["mattermost:trusted-user"] },
            },
          },
        },
      },
      result: { ok: true, commandAuthorized: true, kind: "group", chatType: "group" },
    },
  ])("$name", async ({ params, result }) => {
    expect(await authorizeMattermostCommandInvocation({ ...command, ...params })).toMatchObject(
      result,
    );
  });

  it("denies direct reactions without pairing admission", async () => {
    expect(
      await resolveMattermostMonitorInboundAccess({
        ...inbound,
        kind: "direct",
        account: account({ dmPolicy: "pairing" }),
        storeAllowFrom: [],
        senderId: "new-user",
        senderName: "New User",
        eventKind: "reaction",
        mayPair: false,
      }),
    ).toMatchObject({ ingress: { decision: "block", reasonCode: "event_pairing_not_allowed" } });
  });
});
