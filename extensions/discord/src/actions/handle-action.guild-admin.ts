import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import {
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/param-readers";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { handleDiscordAction } from "../../action-runtime-api.js";
import { isTrustedRequesterGuildAdminAction } from "../trusted-requester-actions.js";
import type { DiscordMessagingActionOptions } from "./runtime.messaging.shared.js";
import {
  isDiscordModerationAction,
  readDiscordModerationCommand,
} from "./runtime.moderation-shared.js";
import {
  readDiscordChannelCreateParams,
  readDiscordChannelEditParams,
  readDiscordChannelMoveParams,
} from "./runtime.shared.js";

type Ctx = Pick<
  ChannelMessageActionContext,
  | "action"
  | "params"
  | "cfg"
  | "accountId"
  | "requesterAccountId"
  | "requesterSenderId"
  | "senderIsOwner"
  | "toolContext"
  | "assertDirectAdapterHandoff"
>;

const guildMetadataReads: Partial<
  Record<Ctx["action"], { action: string; requiredParams: string[] }>
> = {
  "member-info": { action: "memberInfo", requiredParams: ["userId", "guildId"] },
  "role-info": { action: "roleInfo", requiredParams: ["guildId"] },
  "channel-info": { action: "channelInfo", requiredParams: ["channelId"] },
  "channel-list": { action: "channelList", requiredParams: ["guildId"] },
  "voice-status": { action: "voiceStatus", requiredParams: ["guildId", "userId"] },
  "event-list": { action: "eventList", requiredParams: ["guildId"] },
};

const channelMutation = {
  "channel-create": { action: "channelCreate", read: readDiscordChannelCreateParams },
  "channel-edit": { action: "channelEdit", read: readDiscordChannelEditParams },
  "channel-move": { action: "channelMove", read: readDiscordChannelMoveParams },
};

function readDiscordRequesterSenderId(ctx: Ctx): string | undefined {
  const currentProvider = normalizeOptionalString(ctx.toolContext?.currentChannelProvider);
  if (currentProvider?.toLowerCase() === "discord") {
    return normalizeOptionalString(ctx.requesterSenderId);
  }
  // The host binds a source-less scheduled edit to its saved native requester.
  // The handoff guards that admitted invocation; requester fields never come from params.
  if (
    ctx.action === "channel-edit" &&
    !currentProvider &&
    ctx.senderIsOwner === false &&
    ctx.assertDirectAdapterHandoff &&
    ctx.accountId &&
    ctx.requesterAccountId === ctx.accountId
  ) {
    ctx.assertDirectAdapterHandoff();
    const requester = normalizeOptionalString(ctx.requesterSenderId);
    if (requester) {
      return requester;
    }
  }
  if (
    isTrustedRequesterGuildAdminAction(ctx.action) &&
    (currentProvider || ctx.senderIsOwner !== true)
  ) {
    throw new Error(
      "Discord guild admin actions require a trusted Discord sender identity." +
        (ctx.action === "channel-edit" && !currentProvider
          ? " Recreate an automation without recorded execution authorization from a fresh authenticated Discord turn that can manage automations."
          : ""),
    );
  }
  return undefined;
}

export async function tryHandleDiscordMessageActionGuildAdmin(params: {
  ctx: Ctx;
  resolveChannelId: () => string;
  readPolicyOptions?: DiscordMessagingActionOptions;
  actionOptions: DiscordMessagingActionOptions;
}): Promise<AgentToolResult<unknown> | undefined> {
  const { ctx, resolveChannelId, readPolicyOptions, actionOptions } = params;
  const { action, params: actionParams, cfg } = ctx;
  const accountId = ctx.accountId ?? readStringParam(actionParams, "accountId");
  const senderUserId = readDiscordRequesterSenderId(ctx);
  const sender = senderUserId ? { senderUserId } : {};
  const runAction = (
    runtimeAction: string,
    values: Record<string, unknown>,
    options?: DiscordMessagingActionOptions,
  ) =>
    handleDiscordAction(
      { action: runtimeAction, accountId: accountId ?? undefined, ...values },
      cfg,
      options,
    );

  const metadataRead = guildMetadataReads[action];
  if (metadataRead) {
    const values = Object.fromEntries(
      metadataRead.requiredParams.map((key) => [
        key,
        readStringParam(actionParams, key, { required: true }),
      ]),
    );
    return await runAction(metadataRead.action, values, readPolicyOptions);
  }

  if (action === "emoji-list") {
    const guildId = readStringParam(actionParams, "guildId");
    const limit = readPositiveIntegerParam(actionParams, "limit");
    return await runAction(
      "emojiList",
      {
        ...(guildId ? { guildId } : { channelId: resolveChannelId() }),
        ...(limit ? { limit } : {}),
      },
      readPolicyOptions,
    );
  }

  if (action === "emoji-upload" || action === "sticker-upload") {
    const emoji = action === "emoji-upload";
    return await runAction(
      emoji ? "emojiUpload" : "stickerUpload",
      {
        guildId: readStringParam(actionParams, "guildId", { required: true }),
        name: readStringParam(actionParams, emoji ? "emojiName" : "stickerName", {
          required: true,
        }),
        ...(emoji
          ? {}
          : {
              description: readStringParam(actionParams, "stickerDesc", { required: true }),
              tags: readStringParam(actionParams, "stickerTags", { required: true }),
            }),
        mediaUrl: readStringParam(actionParams, "media", { required: true, trim: false }),
        ...(emoji ? { roleIds: readStringArrayParam(actionParams, "roleIds") } : {}),
        ...sender,
      },
      actionOptions,
    );
  }

  if (action === "role-add" || action === "role-remove") {
    return await runAction(action === "role-add" ? "roleAdd" : "roleRemove", {
      guildId: readStringParam(actionParams, "guildId", { required: true }),
      userId: readStringParam(actionParams, "userId", { required: true }),
      roleId: readStringParam(actionParams, "roleId", { required: true }),
      ...sender,
    });
  }

  if (action === "channel-create" || action === "channel-edit" || action === "channel-move") {
    const mutation = channelMutation[action];
    return await runAction(mutation.action, {
      ...mutation.read(actionParams),
      ...sender,
    });
  }

  if (action === "channel-delete") {
    return await runAction("channelDelete", {
      channelId: readStringParam(actionParams, "channelId", { required: true }),
      ...sender,
    });
  }

  if (action === "category-create" || action === "category-edit" || action === "category-delete") {
    const creating = action === "category-create";
    const categoryId = readStringParam(actionParams, creating ? "guildId" : "categoryId", {
      required: true,
    });
    const fields =
      action === "category-delete"
        ? {}
        : {
            name: readStringParam(actionParams, "name", { required: creating }),
            position: readNonNegativeIntegerParam(actionParams, "position"),
          };
    return await runAction(
      creating ? "categoryCreate" : action === "category-edit" ? "categoryEdit" : "categoryDelete",
      {
        ...(creating ? { guildId: categoryId } : { categoryId }),
        ...fields,
        ...sender,
      },
    );
  }

  if (action === "event-create") {
    return await runAction(
      "eventCreate",
      {
        guildId: readStringParam(actionParams, "guildId", { required: true }),
        name: readStringParam(actionParams, "eventName", { required: true }),
        startTime: readStringParam(actionParams, "startTime", { required: true }),
        endTime: readStringParam(actionParams, "endTime"),
        description: readStringParam(actionParams, "desc"),
        channelId: readStringParam(actionParams, "channelId"),
        location: readStringParam(actionParams, "location"),
        entityType: readStringParam(actionParams, "eventType"),
        image: readStringParam(actionParams, "image", { trim: false }),
        ...sender,
      },
      actionOptions,
    );
  }

  if (isDiscordModerationAction(action)) {
    const moderation = readDiscordModerationCommand(action, {
      ...actionParams,
      durationMinutes: readNonNegativeIntegerParam(actionParams, "durationMin"),
      deleteMessageDays: readNonNegativeIntegerParam(actionParams, "deleteDays", {
        max: 7,
        message: "deleteDays must be an integer from 0 to 7",
      }),
    });
    return await runAction(moderation.action, { ...moderation, senderUserId });
  }

  if (action === "thread-list") {
    return await runAction(
      "threadList",
      {
        guildId: readStringParam(actionParams, "guildId", { required: true }),
        channelId: readStringParam(actionParams, "channelId"),
        includeArchived:
          typeof actionParams.includeArchived === "boolean"
            ? actionParams.includeArchived
            : undefined,
        before: readStringParam(actionParams, "before"),
        limit: readPositiveIntegerParam(actionParams, "limit"),
      },
      readPolicyOptions,
    );
  }

  if (action === "thread-reply") {
    const content = readStringParam(actionParams, "message", {
      required: true,
      trim: false,
    });
    const mediaUrl =
      readStringParam(actionParams, "media", { trim: false }) ??
      readStringParam(actionParams, "path", { trim: false }) ??
      readStringParam(actionParams, "filePath", { trim: false });
    const replyTo = readStringParam(actionParams, "replyTo");

    // `message.thread-reply` (tool) uses `threadId`, while the CLI historically used `to`/`channelId`.
    // Prefer `threadId` when present to avoid accidentally replying in the parent channel.
    const threadId = readStringParam(actionParams, "threadId");
    const channelId = threadId ?? resolveChannelId();

    return await runAction(
      "threadReply",
      {
        channelId,
        content,
        mediaUrl: mediaUrl ?? undefined,
        replyTo: replyTo ?? undefined,
        ...(readBooleanParam(actionParams, "silent") === true ? { silent: true } : {}),
      },
      actionOptions,
    );
  }

  if (action === "search") {
    const guildId = readStringParam(actionParams, "guildId");
    const query =
      readStringParam(actionParams, "query") ?? readStringParam(actionParams, "content");
    if (!query) {
      throw new Error("Discord search requires query text. Provide query or content.");
    }
    // Fall back to the current session channel when no explicit channelId,
    // channelIds, or guildId is provided. This lets the runtime resolve
    // guildId from the channel without broadening explicitly-filtered or
    // explicitly guild-scoped searches.
    const explicitChannelIds = readStringArrayParam(actionParams, "channelIds");
    const channelId =
      readStringParam(actionParams, "channelId") ??
      (!guildId &&
      !explicitChannelIds?.length &&
      ctx.toolContext?.currentChannelProvider?.trim().toLowerCase() === "discord"
        ? ctx.toolContext?.currentChannelId?.trim() || undefined
        : undefined);
    return await runAction(
      "searchMessages",
      {
        ...(guildId ? { guildId } : {}),
        content: query,
        channelId,
        channelIds: explicitChannelIds,
        authorId: readStringParam(actionParams, "authorId"),
        authorIds: readStringArrayParam(actionParams, "authorIds"),
        limit: readPositiveIntegerParam(actionParams, "limit"),
      },
      readPolicyOptions,
    );
  }

  return undefined;
}
