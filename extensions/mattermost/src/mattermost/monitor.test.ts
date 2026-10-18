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
  buildMattermostModelPickerSelectMessageSid,
  formatMattermostFinalDeliveryOutcomeLog,
  resolveMattermostInteractionReplyRootId,
  resolveMattermostReactionChannelId,
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
    const resolvedAccount = resolveMattermostAccount({
      cfg: {
        channels: { mattermost: { streaming: { mode: "off", progress: { toolProgress: true } } } },
      },
      accountId: "default",
    });
    expect(shouldUpdateMattermostDraftToolProgress(resolvedAccount)).toBe(false);
  });

  it.each([
    {
      outcome: "media",
      payload: { mediaUrl: "https://example.com/a.png" },
      expected: "delivered reply to channel:town-square",
    },
    { outcome: "empty", payload: { text: " \n\t " }, expected: undefined },
    {
      outcome: "empty",
      payload: { text: "work result" },
      expected:
        "mattermost no-visible-reply: no-visible-reply-after-final-delivery to=channel:town-square accountId=default agentId=agent-1 outcome=empty finalTextLength=11 mediaUrlCount=0",
    },
  ] as const)("reports $outcome delivery for $payload", ({ outcome, payload, expected }) => {
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

  it("normalizes model picker selection identities", () => {
    expect(
      buildMattermostModelPickerSelectMessageSid({
        postId: "post",
        provider: "OpenAI",
        model: " GPT-5 ",
      }),
    ).toBe("interaction:post:select:openai/gpt-5");
  });

  it("resolves reaction channel without a broadcast", () => {
    expect(resolveMattermostReactionChannelId({ data: { channel_id: "channel" } })).toBe("channel");
  });
});

function account(config: ResolvedMattermostAccount["config"]): ResolvedMattermostAccount {
  return {
    accountId: "default",
    enabled: true,
    botToken: "bot-token",
    baseUrl: "https://chat.example.com",
    botTokenSource: "config",
    baseUrlSource: "config",
    streamingMode: "partial",
    config,
  };
}
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

  it("does not auto-authorize DM commands in open mode without allowlists", async () => {
    const access = await resolveMattermostMonitorInboundAccess({
      ...inbound,
      kind: "direct",
      account: account({ dmPolicy: "open" }),
      storeAllowFrom: [],
      allowTextCommands: true,
      hasControlCommand: true,
    });
    expect(access).toMatchObject({
      ingress: { decision: "block" },
      commandAccess: { authorized: false },
    });
  });

  it("denies unauthorized group command senders", async () => {
    expect(
      await authorizeMattermostCommandInvocation({
        ...command,
        account: account({ groupPolicy: "allowlist", allowFrom: ["trusted-user"] }),
        senderId: "attacker",
        senderName: "attacker",
      }),
    ).toMatchObject({ ok: false, denyReason: "unauthorized", commandAuthorized: false });
  });

  it("denies commands without trusted channel type", async () => {
    expect(
      await authorizeMattermostCommandInvocation({
        ...command,
        channelId: "dm-1",
        channelInfo: { id: "dm-1", name: "", display_name: "" },
        account: account({
          dmPolicy: "allowlist",
          groupPolicy: "open",
          allowFrom: ["trusted-user"],
        }),
        senderId: "new-user",
        senderName: "New User",
      }),
    ).toMatchObject({
      ok: false,
      denyReason: "unknown-channel",
      commandAuthorized: false,
    });
  });

  it("authorizes group senders through static access groups", async () => {
    expect(
      await authorizeMattermostCommandInvocation({
        ...command,
        channelInfo: { ...channelInfo, type: "g" },
        account: account({ groupPolicy: "allowlist", groupAllowFrom: ["accessGroup:oncall"] }),
        cfg: {
          accessGroups: {
            oncall: {
              type: "message.senders",
              members: { mattermost: ["mattermost:trusted-user"] },
            },
          },
        },
      }),
    ).toMatchObject({
      ok: true,
      commandAuthorized: true,
      kind: "group",
      chatType: "group",
    });
  });

  it("fails direct reaction access without pairing admission", async () => {
    const access = await resolveMattermostMonitorInboundAccess({
      ...inbound,
      kind: "direct",
      account: account({ dmPolicy: "pairing" }),
      senderId: "new-user",
      senderName: "New User",
      storeAllowFrom: [],
      eventKind: "reaction",
      mayPair: false,
    });
    expect(access.ingress).toMatchObject({
      decision: "block",
      reasonCode: "event_pairing_not_allowed",
    });
  });
});
