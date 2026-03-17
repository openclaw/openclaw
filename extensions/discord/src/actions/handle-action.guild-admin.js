import {
  parseAvailableTags,
  readNumberParam,
  readStringArrayParam,
  readStringParam
} from "../../../../src/agents/tools/common.js";
import {
  isDiscordModerationAction,
  readDiscordModerationCommand
} from "../../../../src/agents/tools/discord-actions-moderation-shared.js";
import { handleDiscordAction } from "../../../../src/agents/tools/discord-actions.js";
async function tryHandleDiscordMessageActionGuildAdmin(params) {
  const { ctx, resolveChannelId, readParentIdParam } = params;
  const { action, params: actionParams, cfg } = ctx;
  const accountId = ctx.accountId ?? readStringParam(actionParams, "accountId");
  if (action === "member-info") {
    const userId = readStringParam(actionParams, "userId", { required: true });
    const guildId = readStringParam(actionParams, "guildId", {
      required: true
    });
    return await handleDiscordAction(
      { action: "memberInfo", accountId: accountId ?? void 0, guildId, userId },
      cfg
    );
  }
  if (action === "role-info") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true
    });
    return await handleDiscordAction(
      { action: "roleInfo", accountId: accountId ?? void 0, guildId },
      cfg
    );
  }
  if (action === "emoji-list") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true
    });
    return await handleDiscordAction(
      { action: "emojiList", accountId: accountId ?? void 0, guildId },
      cfg
    );
  }
  if (action === "emoji-upload") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true
    });
    const name = readStringParam(actionParams, "emojiName", { required: true });
    const mediaUrl = readStringParam(actionParams, "media", {
      required: true,
      trim: false
    });
    const roleIds = readStringArrayParam(actionParams, "roleIds");
    return await handleDiscordAction(
      {
        action: "emojiUpload",
        accountId: accountId ?? void 0,
        guildId,
        name,
        mediaUrl,
        roleIds
      },
      cfg
    );
  }
  if (action === "sticker-upload") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true
    });
    const name = readStringParam(actionParams, "stickerName", {
      required: true
    });
    const description = readStringParam(actionParams, "stickerDesc", {
      required: true
    });
    const tags = readStringParam(actionParams, "stickerTags", {
      required: true
    });
    const mediaUrl = readStringParam(actionParams, "media", {
      required: true,
      trim: false
    });
    return await handleDiscordAction(
      {
        action: "stickerUpload",
        accountId: accountId ?? void 0,
        guildId,
        name,
        description,
        tags,
        mediaUrl
      },
      cfg
    );
  }
  if (action === "role-add" || action === "role-remove") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true
    });
    const userId = readStringParam(actionParams, "userId", { required: true });
    const roleId = readStringParam(actionParams, "roleId", { required: true });
    return await handleDiscordAction(
      {
        action: action === "role-add" ? "roleAdd" : "roleRemove",
        accountId: accountId ?? void 0,
        guildId,
        userId,
        roleId
      },
      cfg
    );
  }
  if (action === "channel-info") {
    const channelId = readStringParam(actionParams, "channelId", {
      required: true
    });
    return await handleDiscordAction(
      { action: "channelInfo", accountId: accountId ?? void 0, channelId },
      cfg
    );
  }
  if (action === "channel-list") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true
    });
    return await handleDiscordAction(
      { action: "channelList", accountId: accountId ?? void 0, guildId },
      cfg
    );
  }
  if (action === "channel-create") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true
    });
    const name = readStringParam(actionParams, "name", { required: true });
    const type = readNumberParam(actionParams, "type", { integer: true });
    const parentId = readParentIdParam(actionParams);
    const topic = readStringParam(actionParams, "topic");
    const position = readNumberParam(actionParams, "position", {
      integer: true
    });
    const nsfw = typeof actionParams.nsfw === "boolean" ? actionParams.nsfw : void 0;
    return await handleDiscordAction(
      {
        action: "channelCreate",
        accountId: accountId ?? void 0,
        guildId,
        name,
        type: type ?? void 0,
        parentId: parentId ?? void 0,
        topic: topic ?? void 0,
        position: position ?? void 0,
        nsfw
      },
      cfg
    );
  }
  if (action === "channel-edit") {
    const channelId = readStringParam(actionParams, "channelId", {
      required: true
    });
    const name = readStringParam(actionParams, "name");
    const topic = readStringParam(actionParams, "topic");
    const position = readNumberParam(actionParams, "position", {
      integer: true
    });
    const parentId = readParentIdParam(actionParams);
    const nsfw = typeof actionParams.nsfw === "boolean" ? actionParams.nsfw : void 0;
    const rateLimitPerUser = readNumberParam(actionParams, "rateLimitPerUser", {
      integer: true
    });
    const archived = typeof actionParams.archived === "boolean" ? actionParams.archived : void 0;
    const locked = typeof actionParams.locked === "boolean" ? actionParams.locked : void 0;
    const autoArchiveDuration = readNumberParam(actionParams, "autoArchiveDuration", {
      integer: true
    });
    const availableTags = parseAvailableTags(actionParams.availableTags);
    return await handleDiscordAction(
      {
        action: "channelEdit",
        accountId: accountId ?? void 0,
        channelId,
        name: name ?? void 0,
        topic: topic ?? void 0,
        position: position ?? void 0,
        parentId: parentId === void 0 ? void 0 : parentId,
        nsfw,
        rateLimitPerUser: rateLimitPerUser ?? void 0,
        archived,
        locked,
        autoArchiveDuration: autoArchiveDuration ?? void 0,
        availableTags
      },
      cfg
    );
  }
  if (action === "channel-delete") {
    const channelId = readStringParam(actionParams, "channelId", {
      required: true
    });
    return await handleDiscordAction(
      { action: "channelDelete", accountId: accountId ?? void 0, channelId },
      cfg
    );
  }
  if (action === "channel-move") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true
    });
    const channelId = readStringParam(actionParams, "channelId", {
      required: true
    });
    const parentId = readParentIdParam(actionParams);
    const position = readNumberParam(actionParams, "position", {
      integer: true
    });
    return await handleDiscordAction(
      {
        action: "channelMove",
        accountId: accountId ?? void 0,
        guildId,
        channelId,
        parentId: parentId === void 0 ? void 0 : parentId,
        position: position ?? void 0
      },
      cfg
    );
  }
  if (action === "category-create") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true
    });
    const name = readStringParam(actionParams, "name", { required: true });
    const position = readNumberParam(actionParams, "position", {
      integer: true
    });
    return await handleDiscordAction(
      {
        action: "categoryCreate",
        accountId: accountId ?? void 0,
        guildId,
        name,
        position: position ?? void 0
      },
      cfg
    );
  }
  if (action === "category-edit") {
    const categoryId = readStringParam(actionParams, "categoryId", {
      required: true
    });
    const name = readStringParam(actionParams, "name");
    const position = readNumberParam(actionParams, "position", {
      integer: true
    });
    return await handleDiscordAction(
      {
        action: "categoryEdit",
        accountId: accountId ?? void 0,
        categoryId,
        name: name ?? void 0,
        position: position ?? void 0
      },
      cfg
    );
  }
  if (action === "category-delete") {
    const categoryId = readStringParam(actionParams, "categoryId", {
      required: true
    });
    return await handleDiscordAction(
      { action: "categoryDelete", accountId: accountId ?? void 0, categoryId },
      cfg
    );
  }
  if (action === "voice-status") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true
    });
    const userId = readStringParam(actionParams, "userId", { required: true });
    return await handleDiscordAction(
      { action: "voiceStatus", accountId: accountId ?? void 0, guildId, userId },
      cfg
    );
  }
  if (action === "event-list") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true
    });
    return await handleDiscordAction(
      { action: "eventList", accountId: accountId ?? void 0, guildId },
      cfg
    );
  }
  if (action === "event-create") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true
    });
    const name = readStringParam(actionParams, "eventName", { required: true });
    const startTime = readStringParam(actionParams, "startTime", {
      required: true
    });
    const endTime = readStringParam(actionParams, "endTime");
    const description = readStringParam(actionParams, "desc");
    const channelId = readStringParam(actionParams, "channelId");
    const location = readStringParam(actionParams, "location");
    const entityType = readStringParam(actionParams, "eventType");
    return await handleDiscordAction(
      {
        action: "eventCreate",
        accountId: accountId ?? void 0,
        guildId,
        name,
        startTime,
        endTime,
        description,
        channelId,
        location,
        entityType
      },
      cfg
    );
  }
  if (isDiscordModerationAction(action)) {
    const moderation = readDiscordModerationCommand(action, {
      ...actionParams,
      durationMinutes: readNumberParam(actionParams, "durationMin", { integer: true }),
      deleteMessageDays: readNumberParam(actionParams, "deleteDays", {
        integer: true
      })
    });
    const senderUserId = ctx.requesterSenderId?.trim() || void 0;
    return await handleDiscordAction(
      {
        action: moderation.action,
        accountId: accountId ?? void 0,
        guildId: moderation.guildId,
        userId: moderation.userId,
        durationMinutes: moderation.durationMinutes,
        until: moderation.until,
        reason: moderation.reason,
        deleteMessageDays: moderation.deleteMessageDays,
        senderUserId
      },
      cfg
    );
  }
  if (action === "thread-list") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true
    });
    const channelId = readStringParam(actionParams, "channelId");
    const includeArchived = typeof actionParams.includeArchived === "boolean" ? actionParams.includeArchived : void 0;
    const before = readStringParam(actionParams, "before");
    const limit = readNumberParam(actionParams, "limit", { integer: true });
    return await handleDiscordAction(
      {
        action: "threadList",
        accountId: accountId ?? void 0,
        guildId,
        channelId,
        includeArchived,
        before,
        limit
      },
      cfg
    );
  }
  if (action === "thread-reply") {
    const content = readStringParam(actionParams, "message", {
      required: true
    });
    const mediaUrl = readStringParam(actionParams, "media", { trim: false });
    const replyTo = readStringParam(actionParams, "replyTo");
    const threadId = readStringParam(actionParams, "threadId");
    const channelId = threadId ?? resolveChannelId();
    return await handleDiscordAction(
      {
        action: "threadReply",
        accountId: accountId ?? void 0,
        channelId,
        content,
        mediaUrl: mediaUrl ?? void 0,
        replyTo: replyTo ?? void 0
      },
      cfg
    );
  }
  if (action === "search") {
    const guildId = readStringParam(actionParams, "guildId", {
      required: true
    });
    const query = readStringParam(actionParams, "query", { required: true });
    return await handleDiscordAction(
      {
        action: "searchMessages",
        accountId: accountId ?? void 0,
        guildId,
        content: query,
        channelId: readStringParam(actionParams, "channelId"),
        channelIds: readStringArrayParam(actionParams, "channelIds"),
        authorId: readStringParam(actionParams, "authorId"),
        authorIds: readStringArrayParam(actionParams, "authorIds"),
        limit: readNumberParam(actionParams, "limit", { integer: true })
      },
      cfg
    );
  }
  return void 0;
}
export {
  tryHandleDiscordMessageActionGuildAdmin
};
