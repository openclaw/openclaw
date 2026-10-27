import fs from "node:fs";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";

function expectedDiscordActions(omitted: string[] = []): string[] {
  return [
    "send",
    "poll",
    "react",
    "reactions",
    "emoji-list",
    "upload-file",
    "read",
    "edit",
    "delete",
    "pin",
    "unpin",
    "list-pins",
    "permissions",
    "thread-create",
    "thread-list",
    "thread-reply",
    "search",
    "sticker",
    "member-info",
    "role-info",
    "emoji-upload",
    "sticker-upload",
    "channel-info",
    "channel-list",
    "channel-create",
    "channel-edit",
    "channel-delete",
    "channel-move",
    "category-create",
    "category-edit",
    "category-delete",
    "voice-status",
    "event-list",
    "event-create",
  ].filter((action) => !omitted.includes(action));
}

const handleDiscordMessageActionMock = vi.hoisted(() =>
  vi.fn(async () => ({ content: [], details: { ok: true } })),
);

const handleActionModule = await import("./actions/handle-action.js");
vi.spyOn(handleActionModule, "handleDiscordMessageAction").mockImplementation(
  handleDiscordMessageActionMock,
);
const { discordMessageActions } = await import("./channel-actions.js");

type DiscordDiscovery = ReturnType<NonNullable<typeof discordMessageActions.describeMessageTool>>;
const discordCfg = (
  discord: NonNullable<OpenClawConfig["channels"]>["discord"],
): OpenClawConfig => ({ channels: { discord } });
type PrepareInput = Parameters<NonNullable<typeof discordMessageActions.prepareSendPayload>>[0];
function prepareSend(
  params: ChannelMessageActionContext["params"],
  payload: PrepareInput["payload"] = { text: "hello" },
  ctx: Pick<ChannelMessageActionContext, "sessionKey" | "inboundEventKind"> = {},
) {
  return discordMessageActions.prepareSendPayload?.({
    ctx: { channel: "discord", action: "send", cfg: {}, params, ...ctx },
    to: "channel:123",
    payload,
  });
}
function schemaForAction(discovery: DiscordDiscovery, action: string) {
  const schema = discovery?.schema;
  return (Array.isArray(schema) ? schema : schema ? [schema] : []).find((entry) =>
    entry.actions?.some((candidate) => candidate === action),
  );
}

describe("discordMessageActions", () => {
  it("returns no tool actions when no token-sourced Discord accounts are enabled", () => {
    withEnv({ DISCORD_BOT_TOKEN: undefined }, () => {
      const discovery = discordMessageActions.describeMessageTool?.({
        cfg: discordCfg({ enabled: true }),
      });

      expect(discovery).toEqual({
        actions: [],
        capabilities: [],
        schema: null,
      });
    });
  });

  it("describes actions when the Discord token is an unresolved SecretRef", () => {
    const discovery = discordMessageActions.describeMessageTool?.({
      cfg: discordCfg({
        token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
        actions: { polls: true, reactions: true },
      }),
    });

    expect(discovery?.capabilities).toEqual(["presentation"]);
    expect(discovery?.actions).toEqual(expectedDiscordActions());
  });

  it("requires trusted requester sender for privileged guild admin actions from tool contexts", () => {
    type TrustedInput = Parameters<
      NonNullable<typeof discordMessageActions.requiresTrustedRequesterSender>
    >[0];
    const requiresTrusted = (
      action: TrustedInput["action"],
      toolContext?: TrustedInput["toolContext"],
    ) => discordMessageActions.requiresTrustedRequesterSender?.({ action, toolContext });
    for (const action of ["channel-delete", "timeout", "kick", "ban"] as const) {
      expect(requiresTrusted(action, { currentChannelProvider: "discord" })).toBe(true);
      expect(requiresTrusted(action)).toBe(false);
    }
    expect(requiresTrusted("channel-delete", { currentChannelProvider: "telegram" })).toBe(true);
    expect(requiresTrusted("read", { currentChannelProvider: "discord" })).toBe(false);
  });

  it("honors account-scoped action gates during discovery", () => {
    const cfg = discordCfg({
      token: "Bot token-main",
      actions: { reactions: false, polls: true },
      accounts: { work: { token: "Bot token-work", actions: { reactions: true, polls: false } } },
    });

    const defaultDiscovery = discordMessageActions.describeMessageTool?.({
      cfg,
      accountId: "default",
    });
    const workDiscovery = discordMessageActions.describeMessageTool?.({
      cfg,
      accountId: "work",
    });

    expect(defaultDiscovery?.actions).toEqual(
      expectedDiscordActions(["react", "reactions", "emoji-list"]),
    );
    expect(workDiscovery?.actions).toEqual(expectedDiscordActions(["poll"]));
    for (const discovery of [defaultDiscovery, workDiscovery]) {
      expect(schemaForAction(discovery, "send")).toMatchObject({
        actions: ["send"],
        properties: {
          components: { description: expect.stringContaining("Discord Components V2") },
        },
      });
    }
    expect(schemaForAction(workDiscovery, "react")).toMatchObject({
      actions: expect.arrayContaining(["react", "reactions"]),
      properties: {
        emoji: { description: expect.stringContaining('action:"emoji-list"') },
      },
    });
    expect(schemaForAction(workDiscovery, "send")).toMatchObject({
      visibility: "all-configured",
    });
  });

  it("declares every Gateway-executed action in the manifest", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    );
    const discovery = discordMessageActions.describeMessageTool?.({
      cfg: discordCfg({
        token: "Bot token-main",
        actions: { roles: true, moderation: true, presence: true },
      }),
    });
    const gatewayActions = (discovery?.actions ?? []).filter(
      (action) => discordMessageActions.resolveExecutionMode?.({ action }) === "gateway",
    );

    expect(manifest.channelConfigs.discord.gatewayMessageActions).toEqual(gatewayActions);
  });

  it("keeps sticker-upload on local execution mode", () => {
    expect(discordMessageActions.resolveExecutionMode?.({ action: "sticker-upload" })).toBe(
      "local",
    );
  });

  it("extracts send targets for message and thread reply actions", () => {
    const extract = (args: Record<string, unknown>) =>
      discordMessageActions.extractToolSend?.({ args });
    expect(extract({ action: "sendMessage", to: "channel:123" })).toEqual({ to: "channel:123" });
    expect(extract({ action: "threadReply", channelId: "987" })).toEqual({ to: "channel:987" });
    expect(extract({ action: "threadReply", channelId: "   " })).toBeNull();
  });

  it("proves only the exact current Discord thread-reply target", () => {
    const spec = discordMessageActions.messageActionTargetAliases?.["thread-reply"];
    const matches = (args: Record<string, unknown>, messagingTarget = true) =>
      spec?.matchesCurrentConversation?.({
        args,
        accountId: "default",
        toolContext: {
          currentChannelProvider: "discord",
          currentChannelId: "123456",
          ...(messagingTarget ? { currentMessagingTarget: "channel:123456" } : {}),
        },
      });

    expect(spec?.resolveDeliveryTarget?.({ args: { threadId: "123456" } })).toBe("channel:123456");
    for (const args of [
      { target: "123456" },
      { to: "123456" },
      { channelId: "123456" },
      { target: "channel:123456" },
      { threadId: "123456", target: "parent" },
      { threadId: "123456", to: "parent" },
      { threadId: "123456", channelId: "parent" },
    ]) {
      expect(spec?.resolveDeliveryTarget?.({ args })).toBeUndefined();
    }
    for (const args of [
      { threadId: "123456" },
      { target: "123456" },
      { to: "123456" },
      { channelId: "123456" },
      { target: "channel:123456" },
      { to: "channel:123456" },
      { channelId: "123456" },
    ]) {
      expect(matches(args)).toBe(true);
    }
    expect(matches({ threadId: "123456", target: "channel:999999", to: "channel:999999" })).toBe(
      true,
    );
    expect(matches({ threadId: "999999" })).toBe(false);
    expect(matches({}, false)).toBe(false);
  });

  it("prepares Discord send payload channel data for durable core delivery", async () => {
    const components = {
      text: "Choose",
      blocks: [{ type: "actions", buttons: [{ label: "Yes", callbackData: "yes" }] }],
    };
    const prepared = await prepareSend(
      {
        components: JSON.stringify(components),
        embeds: undefined,
        filename: "photo.png",
      },
      { text: "hello", mediaUrl: "/tmp/photo.png" },
    );

    expect(prepared).toEqual({
      text: "hello",
      mediaUrl: "/tmp/photo.png",
      channelData: {
        discord: {
          components,
          filename: "photo.png",
        },
      },
    });
  });

  it("prepares inbound event delivery metadata for durable core sends", async () => {
    const delivery = {
      sessionKey: "agent:main:discord:channel:c1",
      inboundEventKind: "room_event" as const,
    };
    const prepared = await prepareSend({}, { text: "hello" }, delivery);

    expect(prepared).toEqual({
      text: "hello",
      channelData: {
        discord: {
          __openclawInboundEventDelivery: delivery,
        },
      },
    });
  });

  it("keeps non-serializable Discord component sends on the legacy action path", async () => {
    expect(await prepareSend({ components: () => [] })).toBeNull();
  });

  it("delegates action handling to the Discord action handler", async () => {
    const cfg = discordCfg({ token: "Bot token-main" });
    const mediaReadFile = vi.fn(async () => Buffer.from("image"));
    const mediaAccess: NonNullable<ChannelMessageActionContext["mediaAccess"]> = {
      localRoots: ["/tmp/media"],
      readFile: mediaReadFile,
    };
    const mediaLocalRoots = ["/tmp/media"];
    const reply = {
      source: "implicit" as const,
      replyToId: "source-message-1",
      mode: "first" as const,
    };

    const forwarded: Omit<ChannelMessageActionContext, "channel"> = {
      action: "send",
      params: { to: "channel:123", message: "hello" },
      cfg,
      accountId: "ops",
      requesterAccountId: "ops",
      requesterSenderId: "user-1",
      senderIsOwner: true,
      toolContext: { currentChannelProvider: "discord" },
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      conversationReadOrigin: "delegated",
      reply,
    };
    await discordMessageActions.handleAction?.({ channel: "discord", ...forwarded });
    expect(handleDiscordMessageActionMock).toHaveBeenCalledWith(forwarded);
  });
});
