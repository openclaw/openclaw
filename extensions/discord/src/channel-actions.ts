import { createUnionActionGate } from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
} from "openclaw/plugin-sdk/channel-contract";
import type { DiscordActionConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { Type } from "typebox";
import { inspectDiscordAccount } from "./account-inspect.js";
import { createDiscordActionGate, listDiscordAccountIds } from "./accounts.js";
import { coerceDiscordComponentParam, readDiscordComponentSpec } from "./components.js";
import { withDiscordInboundEventDeliveryMetadata } from "./inbound-event-delivery.js";
import { matchesDiscordToolContextTarget, normalizeDiscordMessagingTarget } from "./normalize.js";
import { isTrustedRequesterGuildAdminAction } from "./trusted-requester-actions.js";

const localExecutionActions = new Set<ChannelMessageActionName>([
  "send",
  "poll",
  "upload-file",
  "thread-reply",
  "sticker",
  "emoji-upload",
  "sticker-upload",
  "event-create",
]);

function resolveDiscordActionExecutionMode({ action }: { action: ChannelMessageActionName }) {
  return localExecutionActions.has(action) ? "local" : "gateway";
}

function resolveDiscordThreadReplyDeliveryAlias(args: Record<string, unknown>): string | undefined {
  if (
    normalizeOptionalString(args.target) ||
    normalizeOptionalString(args.to) ||
    normalizeOptionalString(args.channelId)
  ) {
    return undefined;
  }
  const threadId = normalizeOptionalString(args.threadId);
  return threadId ? normalizeDiscordMessagingTarget(`channel:${threadId}`) : undefined;
}

function resolveDiscordThreadReplyTarget(args: Record<string, unknown>): string | undefined {
  const threadId = normalizeOptionalString(args.threadId);
  const target =
    threadId !== undefined
      ? `channel:${threadId}`
      : (normalizeOptionalString(args.channelId) ??
        normalizeOptionalString(args.to) ??
        normalizeOptionalString(args.target));
  return target ? normalizeDiscordMessagingTarget(target) : undefined;
}

function matchesCurrentDiscordThread(params: {
  args: Record<string, unknown>;
  toolContext: {
    currentChannelId?: string;
    currentMessagingTarget?: string;
  };
}): boolean {
  const requestedTarget = resolveDiscordThreadReplyTarget(params.args);
  if (!requestedTarget) {
    return false;
  }
  return matchesDiscordToolContextTarget({
    target: requestedTarget,
    toolContext: params.toolContext,
  });
}

const loadDiscordChannelActionsRuntime = createLazyRuntimeModule(
  () => import("./channel-actions.runtime.js"),
);

const discordActionGroups: ReadonlyArray<{
  gate: keyof DiscordActionConfig;
  actions: readonly ChannelMessageActionName[];
  defaultEnabled?: false;
}> = [
  { gate: "polls", actions: ["poll"] },
  { gate: "reactions", actions: ["react", "reactions", "emoji-list"] },
  { gate: "messages", actions: ["upload-file", "read", "edit", "delete"] },
  { gate: "pins", actions: ["pin", "unpin", "list-pins"] },
  { gate: "permissions", actions: ["permissions"] },
  { gate: "threads", actions: ["thread-create", "thread-list", "thread-reply"] },
  { gate: "search", actions: ["search"] },
  { gate: "stickers", actions: ["sticker"] },
  { gate: "memberInfo", actions: ["member-info"] },
  { gate: "roleInfo", actions: ["role-info"] },
  { gate: "emojiUploads", actions: ["emoji-upload"] },
  { gate: "stickerUploads", actions: ["sticker-upload"] },
  { gate: "roles", actions: ["role-add", "role-remove"], defaultEnabled: false },
  { gate: "channelInfo", actions: ["channel-info", "channel-list"] },
  {
    gate: "channels",
    actions: [
      "channel-create",
      "channel-edit",
      "channel-delete",
      "channel-move",
      "category-create",
      "category-edit",
      "category-delete",
    ],
  },
  { gate: "voiceStatus", actions: ["voice-status"] },
  { gate: "events", actions: ["event-list", "event-create"] },
  { gate: "moderation", actions: ["timeout", "kick", "ban"], defaultEnabled: false },
  { gate: "presence", actions: ["set-presence"], defaultEnabled: false },
];

function describeDiscordMessageTool({
  cfg,
  accountId,
}: Parameters<
  NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>
>[0]): ChannelMessageToolDiscovery {
  const accounts = (accountId ? [accountId] : listDiscordAccountIds(cfg))
    .map((id) => inspectDiscordAccount({ cfg, accountId: id }))
    .filter((account) => account.enabled && account.configured);
  if (accounts.length === 0) {
    return {
      actions: [],
      capabilities: [],
      schema: null,
    };
  }
  const isEnabled = createUnionActionGate(accounts, (account) =>
    createDiscordActionGate({ cfg, accountId: account.accountId }),
  );
  const actions = new Set<ChannelMessageActionName>(["send"]);
  for (const group of discordActionGroups) {
    if (isEnabled(group.gate, group.defaultEnabled ?? true)) {
      for (const action of group.actions) {
        actions.add(action);
      }
    }
  }
  const schema: ChannelMessageToolSchemaContribution[] = [];
  if (actions.has("react")) {
    schema.push({
      actions: ["react", "reactions"],
      properties: {
        emoji: Type.Optional(
          Type.String({
            description: `Unicode emoji or custom name:id (also <:name:id> / <a:name:id>).${actions.has("emoji-list") ? ' Use action:"emoji-list" for server emojis.' : ""}`,
          }),
        ),
      },
    });
  }
  if (actions.has("send")) {
    schema.push({
      actions: ["send"],
      visibility: "all-configured",
      properties: {
        components: Type.Optional(
          Type.Object(
            {
              blocks: Type.Optional(
                Type.Array(Type.Unknown(), {
                  description:
                    "Discord Components V2 blocks such as text, buttons, selects, media, containers, and separators.",
                }),
              ),
              modal: Type.Optional(
                Type.Object(
                  {},
                  {
                    additionalProperties: true,
                    description: "Optional Discord modal triggered by generated components.",
                  },
                ),
              ),
            },
            {
              additionalProperties: true,
              description:
                "Discord Components V2 payload for send actions. Accepts the same object consumed by the Discord components adapter.",
            },
          ),
        ),
      },
    });
  }
  return {
    actions: Array.from(actions),
    capabilities: ["presentation"],
    schema,
  };
}

export const discordMessageActions: ChannelMessageActionAdapter = {
  providerOwnedReadGates: true,
  readAuthorityActions: [
    "read",
    "search",
    "reactions",
    "list-pins",
    "thread-list",
    "channel-info",
    "permissions",
    "member-info",
    "role-info",
    "emoji-list",
    "channel-list",
    "voice-status",
    "event-list",
  ],
  writeAuthorityActions: ["channel-edit", "delete", "edit", "pin", "unpin"],
  // Credential-only Discord actions run in the gateway when one is available.
  // Send/file-style actions stay local because core owns their thread, media,
  // component, and client-local payload semantics.
  resolveExecutionMode: resolveDiscordActionExecutionMode,
  describeMessageTool: describeDiscordMessageTool,
  supportsAction: ({ action }) => action !== "poll",
  messageActionTargetAliases: {
    "thread-reply": {
      aliases: ["threadId"],
      deliveryTargetAliases: ["threadId"],
      resolveDeliveryTarget: ({ args }) => resolveDiscordThreadReplyDeliveryAlias(args),
      matchesCurrentConversation: ({ args, toolContext }) =>
        matchesCurrentDiscordThread({ args, toolContext }),
    },
  },
  requiresTrustedRequesterSender: ({ action, toolContext }) =>
    Boolean(toolContext) && isTrustedRequesterGuildAdminAction(action),
  extractToolSend: ({ args }) => {
    const action = normalizeOptionalString(args.action) ?? "";
    if (action === "sendMessage") {
      return extractToolSend(args, "sendMessage");
    }
    if (action === "threadReply") {
      const channelId = normalizeOptionalString(args.channelId) ?? "";
      return channelId ? { to: `channel:${channelId}` } : null;
    }
    return null;
  },
  prepareSendPayload: ({ ctx, payload }) => {
    if (ctx.action !== "send") {
      return null;
    }
    const payloadWithDeliveryMetadata = withDiscordInboundEventDeliveryMetadata(payload, {
      sessionKey: ctx.sessionKey,
      inboundEventKind: ctx.inboundEventKind,
    });
    const rawComponents = coerceDiscordComponentParam(ctx.params.components);
    if (typeof rawComponents === "function") {
      return null;
    }
    const componentSpec =
      rawComponents && typeof rawComponents === "object" && !Array.isArray(rawComponents)
        ? readDiscordComponentSpec(rawComponents)
        : undefined;
    const nativeComponents = Array.isArray(rawComponents) ? rawComponents : undefined;
    const embeds = Array.isArray(ctx.params.embeds) ? ctx.params.embeds : undefined;
    if ((componentSpec || nativeComponents) && embeds?.length) {
      return null;
    }
    const filename = normalizeOptionalString(ctx.params.filename);
    if (!componentSpec && !nativeComponents && !embeds?.length && !filename) {
      return payloadWithDeliveryMetadata;
    }
    const discordData =
      payloadWithDeliveryMetadata.channelData?.discord &&
      typeof payloadWithDeliveryMetadata.channelData.discord === "object" &&
      !Array.isArray(payloadWithDeliveryMetadata.channelData.discord)
        ? (payloadWithDeliveryMetadata.channelData.discord as Record<string, unknown>)
        : {};
    return {
      ...payloadWithDeliveryMetadata,
      channelData: {
        ...payloadWithDeliveryMetadata.channelData,
        discord: {
          ...discordData,
          ...(componentSpec ? { components: componentSpec } : {}),
          ...(nativeComponents ? { components: nativeComponents } : {}),
          ...(embeds?.length ? { embeds } : {}),
          ...(filename ? { filename } : {}),
        },
      },
    };
  },
  handleAction: async ({
    action,
    params,
    cfg,
    accountId,
    requesterAccountId,
    requesterSenderId,
    senderIsOwner,
    toolContext,
    mediaAccess,
    mediaLocalRoots,
    mediaReadFile,
    sessionKey,
    inboundEventKind,
    conversationReadOrigin,
    reply,
    progressSnapshot,
    assertDirectAdapterHandoff,
    onDeliveryResult,
  }) => {
    return await (
      await loadDiscordChannelActionsRuntime()
    ).handleDiscordMessageAction({
      action,
      params,
      cfg,
      accountId,
      requesterSenderId,
      senderIsOwner,
      toolContext,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      ...(sessionKey ? { sessionKey } : {}),
      ...(inboundEventKind ? { inboundEventKind } : {}),
      ...(requesterAccountId ? { requesterAccountId } : {}),
      ...(conversationReadOrigin ? { conversationReadOrigin } : {}),
      ...(reply ? { reply } : {}),
      ...(progressSnapshot ? { progressSnapshot } : {}),
      ...(assertDirectAdapterHandoff ? { assertDirectAdapterHandoff } : {}),
      ...(onDeliveryResult ? { onDeliveryResult } : {}),
    });
  },
};
