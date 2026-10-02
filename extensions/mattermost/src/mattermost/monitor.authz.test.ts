import "./monitor-helpers.test-support.js";
import "./monitor-onchar.test-support.js";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it } from "vitest";
import { setMattermostRuntime } from "../runtime.js";
import type { ResolvedMattermostAccount } from "./accounts.js";
import {
  authorizeMattermostCommandInvocation,
  resolveMattermostMonitorInboundAccess,
} from "./monitor-auth.js";

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
    { senderId: "trusted-user", result: { ok: true, commandAuthorized: true } },
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
