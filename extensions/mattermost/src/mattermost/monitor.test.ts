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
    {
      kind: "direct",
      threadRootId: "root",
      replyToId: "interaction:post:approve",
      expected: "root",
    },
    { kind: "channel", threadRootId: undefined, replyToId: "other-post", expected: "other-post" },
    {
      kind: "direct",
      threadRootId: undefined,
      replyToId: "interaction:post:approve",
      expected: undefined,
    },
  ] as const)("resolves $kind interaction reply $replyToId with root $threadRootId", (row) => {
    const interactionMessageSid = buildMattermostButtonInteractionMessageSid({
      postId: "post",
      actionId: "approve",
    });
    expect(interactionMessageSid).toBe("interaction:post:approve");
    expect(
      resolveMattermostInteractionReplyRootId({
        ...row,
        interactionMessageSid,
        sourcePostId: "post",
      }),
    ).toBe(row.expected);
  });

  it.each([{ kind: "direct", replyToMode: "first", parentSessionKey: undefined }] as const)(
    "starts $kind threads with the appropriate parent session",
    (row) => {
      expect(
        resolveMattermostThreadSessionContext({
          ...row,
          baseSessionKey: "base",
          postId: "post",
        }),
      ).toEqual({
        effectiveReplyToId: "post",
        sessionKey: "base:thread:post",
        parentSessionKey: row.parentSessionKey,
      });
    },
  );

  it("disables tool progress when streaming is off", () => {
    const resolvedAccount = resolveMattermostAccount({
      cfg: {
        channels: {
          mattermost: {
            streaming: { mode: "off", progress: { toolProgress: true } },
          },
        },
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

  it.each([{ data: { channel_id: "channel" }, expected: "channel" }])(
    "resolves reaction channel without a broadcast: $expected",
    ({ data, expected }) => {
      expect(resolveMattermostReactionChannelId({ data })).toBe(expected);
    },
  );
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
};
const inbound = {
  cfg: {},
  senderId: "trusted-user",
  senderName: "Trusted User",
  channelId: "chan-1",
  groupPolicy: "allowlist",
  storeAllowFrom: ["user:attacker"],
  allowTextCommands: false,
  hasControlCommand: false,
} as const;

describe("mattermost monitor authz", () => {
  beforeEach(() => setMattermostRuntime(createPluginRuntimeMock()));

  it.each([
    {
      kind: "direct",
      config: { allowFrom: ["@trusted-user"], groupAllowFrom: ["@group-owner"] },
      expected: ["trusted-user", "attacker"],
    },
    {
      kind: "channel",
      config: { allowFrom: ["@trusted-user"], groupAllowFrom: ["@group-owner"] },
      expected: ["group-owner"],
    },
    { kind: "channel", config: { allowFrom: ["@trusted-user"] }, expected: ["trusted-user"] },
  ] as const)(
    "isolates $kind admission from unrelated pairing and group entries: $expected",
    async ({ kind, config, expected }) => {
      const resolved = await resolveMattermostMonitorInboundAccess({
        ...inbound,
        storeAllowFrom: [...inbound.storeAllowFrom],
        kind,
        account: account({
          allowFrom: [...config.allowFrom],
          ...(config.groupAllowFrom ? { groupAllowFrom: [...config.groupAllowFrom] } : {}),
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
    expect(access.ingress.decision).toBe("block");
    expect(access.commandAccess.authorized).toBe(false);
  });

  it.each([
    {
      senderId: "attacker",
      result: { ok: false, denyReason: "unauthorized", commandAuthorized: false },
    },
  ])("authorizes group commands by sender: $senderId", async ({ senderId, result }) => {
    expect(
      await authorizeMattermostCommandInvocation({
        ...command,
        account: account({ groupPolicy: "allowlist", allowFrom: ["trusted-user"] }),
        senderId,
        senderName: senderId,
      }),
    ).toMatchObject(result);
  });

  it("denies commands without trusted channel type", async () => {
    const unknownChannel = { id: "dm-1", name: "", display_name: "" };
    expect(
      await authorizeMattermostCommandInvocation({
        ...command,
        channelId: "dm-1",
        channelInfo: unknownChannel,
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
    const groupChannel = { ...channelInfo, type: "g" };
    expect(
      await authorizeMattermostCommandInvocation({
        ...command,
        channelInfo: groupChannel,
        senderId: "trusted-user",
        senderName: "Trusted User",
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
    expect(access.ingress.decision).toBe("block");
    expect(access.ingress.reasonCode).toBe("event_pairing_not_allowed");
  });
});
