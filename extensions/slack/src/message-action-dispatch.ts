import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import {
  normalizeInteractiveReply,
  normalizeMessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import { readNumberParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
import {
  buildSlackInteractiveBlocks,
  buildSlackPresentationBlocks,
  resolveSlackInteractiveBlockOffsets,
} from "./blocks-render.js";

type SlackActionInvoke = (
  action: Record<string, unknown>,
  cfg: ChannelMessageActionContext["cfg"],
  toolContext?: ChannelMessageActionContext["toolContext"],
) => Promise<AgentToolResult<unknown>>;

function readMessageContentParam(params: Record<string, unknown>, label: string): string {
  const content =
    readStringParam(params, "message", { allowEmpty: true }) ??
    readStringParam(params, "content", { allowEmpty: true });
  if (content == null) {
    throw new Error(`${label} requires message or content.`);
  }
  return content;
}

/** Translate generic channel action requests into Slack-specific tool invocations and payload shapes. */
export async function handleSlackMessageAction(params: {
  providerId: string;
  ctx: ChannelMessageActionContext;
  invoke: SlackActionInvoke;
  normalizeChannelId?: (channelId: string) => string;
  includeReadThreadId?: boolean;
}): Promise<AgentToolResult<unknown>> {
  const { providerId, ctx, invoke, normalizeChannelId, includeReadThreadId = false } = params;
  const { action, cfg, params: actionParams } = ctx;
  const accountId = ctx.accountId ?? undefined;
  const resolveChannelId = () => {
    const channelId =
      readStringParam(actionParams, "channelId") ??
      readStringParam(actionParams, "to", { required: true });
    return normalizeChannelId ? normalizeChannelId(channelId) : channelId;
  };

  if (action === "send") {
    const to = readStringParam(actionParams, "to", { required: true });
    const content = readStringParam(actionParams, "message", {
      required: false,
      allowEmpty: true,
    });
    const mediaUrl = readStringParam(actionParams, "media", { trim: false });
    const presentation = normalizeMessagePresentation(actionParams.presentation);
    const interactive = normalizeInteractiveReply(actionParams.interactive);
    const presentationBlocks = presentation
      ? buildSlackPresentationBlocks(presentation)
      : undefined;
    const interactiveBlocks = interactive
      ? buildSlackInteractiveBlocks(
          interactive,
          resolveSlackInteractiveBlockOffsets(presentationBlocks),
        )
      : undefined;
    const mergedBlocks = [...(presentationBlocks ?? []), ...(interactiveBlocks ?? [])];
    const blocks = mergedBlocks.length > 0 ? mergedBlocks : undefined;
    if (!content && !mediaUrl && !blocks) {
      throw new Error("Slack send requires message, blocks, or media.");
    }
    const threadId = readStringParam(actionParams, "threadId");
    const replyTo = readStringParam(actionParams, "replyTo");
    return await invoke(
      {
        action: "sendMessage",
        to,
        content: content ?? "",
        mediaUrl: mediaUrl ?? undefined,
        accountId,
        threadTs: threadId ?? replyTo ?? undefined,
        replyBroadcast:
          typeof actionParams.replyBroadcast === "boolean"
            ? actionParams.replyBroadcast
            : undefined,
        unfurlLinks:
          typeof actionParams.unfurlLinks === "boolean" ? actionParams.unfurlLinks : undefined,
        unfurlMedia:
          typeof actionParams.unfurlMedia === "boolean" ? actionParams.unfurlMedia : undefined,
        ...(blocks ? { blocks } : {}),
      },
      cfg,
      ctx.toolContext,
    );
  }

  if (action === "react") {
    const messageId = readStringParam(actionParams, "messageId", {
      required: true,
    });
    const emoji = readStringParam(actionParams, "emoji", { allowEmpty: true });
    const remove = typeof actionParams.remove === "boolean" ? actionParams.remove : undefined;
    return await invoke(
      {
        action: "react",
        channelId: resolveChannelId(),
        messageId,
        emoji,
        remove,
        accountId,
      },
      cfg,
    );
  }

  if (action === "reactions") {
    const messageId = readStringParam(actionParams, "messageId", {
      required: true,
    });
    const limit = readNumberParam(actionParams, "limit", { integer: true });
    return await invoke(
      {
        action: "reactions",
        channelId: resolveChannelId(),
        messageId,
        limit,
        accountId,
      },
      cfg,
    );
  }

  if (action === "read") {
    const limit = readNumberParam(actionParams, "limit", { integer: true });
    const readAction: Record<string, unknown> = {
      action: "readMessages",
      channelId: resolveChannelId(),
      limit,
      before: readStringParam(actionParams, "before"),
      after: readStringParam(actionParams, "after"),
      messageId: readStringParam(actionParams, "messageId"),
      accountId,
    };
    if (includeReadThreadId) {
      readAction.threadId = readStringParam(actionParams, "threadId");
    }
    return await invoke(readAction, cfg);
  }

  if (action === "edit") {
    const messageId = readStringParam(actionParams, "messageId", {
      required: true,
    });
    const content = readStringParam(actionParams, "message", { allowEmpty: true });
    const presentation = normalizeMessagePresentation(actionParams.presentation);
    const blocks = presentation ? buildSlackPresentationBlocks(presentation) : undefined;
    if (!content && !blocks) {
      throw new Error("Slack edit requires message or blocks.");
    }
    return await invoke(
      {
        action: "editMessage",
        channelId: resolveChannelId(),
        messageId,
        content: content ?? "",
        blocks,
        accountId,
      },
      cfg,
    );
  }

  if (action === "delete") {
    const messageId = readStringParam(actionParams, "messageId", {
      required: true,
    });
    return await invoke(
      {
        action: "deleteMessage",
        channelId: resolveChannelId(),
        messageId,
        accountId,
      },
      cfg,
    );
  }

  if (action === "pin" || action === "unpin" || action === "list-pins") {
    const messageId =
      action === "list-pins"
        ? undefined
        : readStringParam(actionParams, "messageId", { required: true });
    return await invoke(
      {
        action: action === "pin" ? "pinMessage" : action === "unpin" ? "unpinMessage" : "listPins",
        channelId: resolveChannelId(),
        messageId,
        accountId,
      },
      cfg,
    );
  }

  if (action === "member-info") {
    const userId = readStringParam(actionParams, "userId", { required: true });
    return await invoke({ action: "memberInfo", userId, accountId }, cfg);
  }

  if (action === "emoji-list") {
    const limit = readNumberParam(actionParams, "limit", { integer: true });
    return await invoke({ action: "emojiList", limit, accountId }, cfg);
  }

  if (action === "download-file") {
    const fileId = readStringParam(actionParams, "fileId", { required: true });
    const channelId =
      readStringParam(actionParams, "channelId") ?? readStringParam(actionParams, "to");
    const threadId =
      readStringParam(actionParams, "threadId") ?? readStringParam(actionParams, "replyTo");
    return await invoke(
      {
        action: "downloadFile",
        fileId,
        channelId: channelId ?? undefined,
        threadId: threadId ?? undefined,
        accountId,
      },
      cfg,
    );
  }

  if (action === "upload-file") {
    const to = readStringParam(actionParams, "to") ?? resolveChannelId();
    const filePath =
      readStringParam(actionParams, "filePath", { trim: false }) ??
      readStringParam(actionParams, "path", { trim: false }) ??
      readStringParam(actionParams, "media", { trim: false });
    if (!filePath) {
      throw new Error("upload-file requires filePath, path, or media");
    }
    const threadId =
      readStringParam(actionParams, "threadId") ?? readStringParam(actionParams, "replyTo");
    return await invoke(
      {
        action: "uploadFile",
        to,
        filePath,
        initialComment:
          readStringParam(actionParams, "initialComment", { allowEmpty: true }) ??
          readStringParam(actionParams, "message", { allowEmpty: true }) ??
          "",
        filename: readStringParam(actionParams, "filename"),
        title: readStringParam(actionParams, "title"),
        threadTs: threadId ?? undefined,
        accountId,
      },
      cfg,
      ctx.toolContext,
    );
  }

  if (action === "search") {
    return await invoke(
      {
        action: "searchMessages",
        query: readStringParam(actionParams, "query", { required: true }),
        limit: readNumberParam(actionParams, "limit", { integer: true }),
        page: readNumberParam(actionParams, "page", { integer: true }),
        sort: readStringParam(actionParams, "sort"),
        sortDir: readStringParam(actionParams, "sortDir"),
        accountId,
      },
      cfg,
    );
  }

  if (action === "channel-info") {
    return await invoke(
      {
        action: "channelInfo",
        channelId: resolveChannelId(),
        accountId,
      },
      cfg,
    );
  }

  if (action === "channel-list") {
    return await invoke(
      {
        action: "channelList",
        limit: readNumberParam(actionParams, "limit", { integer: true }),
        pageToken: readStringParam(actionParams, "pageToken"),
        cursor: readStringParam(actionParams, "cursor"),
        types: readStringParam(actionParams, "types") ?? readStringParam(actionParams, "kind"),
        excludeArchived:
          typeof actionParams.excludeArchived === "boolean"
            ? actionParams.excludeArchived
            : undefined,
        accountId,
      },
      cfg,
    );
  }

  if (action === "get-permalink") {
    return await invoke(
      {
        action: "getPermalink",
        channelId: resolveChannelId(),
        messageId: readStringParam(actionParams, "messageId", { required: true }),
        accountId,
      },
      cfg,
    );
  }

  if (action === "post-ephemeral") {
    return await invoke(
      {
        action: "postEphemeral",
        channelId: resolveChannelId(),
        userId: readStringParam(actionParams, "userId", { required: true }),
        content: readMessageContentParam(actionParams, "post-ephemeral"),
        threadTs:
          readStringParam(actionParams, "threadId") ?? readStringParam(actionParams, "replyTo"),
        accountId,
      },
      cfg,
    );
  }

  if (action === "schedule-message") {
    return await invoke(
      {
        action: "scheduleMessage",
        channelId: resolveChannelId(),
        content: readMessageContentParam(actionParams, "schedule-message"),
        postAt: actionParams.postAt ?? actionParams.time ?? actionParams.startTime,
        threadTs:
          readStringParam(actionParams, "threadId") ?? readStringParam(actionParams, "replyTo"),
        replyBroadcast:
          typeof actionParams.replyBroadcast === "boolean"
            ? actionParams.replyBroadcast
            : undefined,
        unfurlLinks:
          typeof actionParams.unfurlLinks === "boolean" ? actionParams.unfurlLinks : undefined,
        unfurlMedia:
          typeof actionParams.unfurlMedia === "boolean" ? actionParams.unfurlMedia : undefined,
        accountId,
      },
      cfg,
    );
  }

  if (action === "scheduled-list") {
    return await invoke(
      {
        action: "listScheduledMessages",
        channelId:
          readStringParam(actionParams, "channelId") ?? readStringParam(actionParams, "to"),
        limit: readNumberParam(actionParams, "limit", { integer: true }),
        pageToken: readStringParam(actionParams, "pageToken"),
        before: readStringParam(actionParams, "before"),
        after: readStringParam(actionParams, "after"),
        accountId,
      },
      cfg,
    );
  }

  if (action === "delete-scheduled") {
    return await invoke(
      {
        action: "deleteScheduledMessage",
        channelId: resolveChannelId(),
        scheduledMessageId: readStringParam(actionParams, "scheduledMessageId", {
          required: true,
        }),
        accountId,
      },
      cfg,
    );
  }

  if (action === "file-list") {
    return await invoke(
      {
        action: "listFiles",
        channelId:
          readStringParam(actionParams, "channelId") ?? readStringParam(actionParams, "to"),
        limit: readNumberParam(actionParams, "limit", { integer: true }),
        page: readNumberParam(actionParams, "page", { integer: true }),
        after: readStringParam(actionParams, "after"),
        before: readStringParam(actionParams, "before"),
        types: readStringParam(actionParams, "types"),
        userId: readStringParam(actionParams, "userId"),
        accountId,
      },
      cfg,
    );
  }

  if (action === "file-delete") {
    return await invoke(
      {
        action: "deleteFile",
        fileId: readStringParam(actionParams, "fileId", { required: true }),
        accountId,
      },
      cfg,
    );
  }

  if (
    action === "bookmark-add" ||
    action === "bookmark-edit" ||
    action === "bookmark-list" ||
    action === "bookmark-remove"
  ) {
    return await invoke(
      {
        action:
          action === "bookmark-add"
            ? "bookmarkAdd"
            : action === "bookmark-edit"
              ? "bookmarkEdit"
              : action === "bookmark-remove"
                ? "bookmarkRemove"
                : "bookmarkList",
        channelId: resolveChannelId(),
        bookmarkId:
          readStringParam(actionParams, "bookmarkId") ?? readStringParam(actionParams, "id"),
        title: readStringParam(actionParams, "title"),
        url: readStringParam(actionParams, "url"),
        link: readStringParam(actionParams, "link"),
        type: readStringParam(actionParams, "type"),
        emoji: readStringParam(actionParams, "emoji"),
        entityId: readStringParam(actionParams, "entityId"),
        accountId,
      },
      cfg,
    );
  }

  if (
    action === "reminder-add" ||
    action === "reminder-list" ||
    action === "reminder-info" ||
    action === "reminder-complete" ||
    action === "reminder-delete"
  ) {
    return await invoke(
      {
        action:
          action === "reminder-add"
            ? "reminderAdd"
            : action === "reminder-info"
              ? "reminderInfo"
              : action === "reminder-complete"
                ? "reminderComplete"
                : action === "reminder-delete"
                  ? "reminderDelete"
                  : "reminderList",
        reminderId:
          readStringParam(actionParams, "reminderId") ?? readStringParam(actionParams, "id"),
        content:
          readStringParam(actionParams, "message", { allowEmpty: true }) ??
          readStringParam(actionParams, "content", { allowEmpty: true }),
        time: readStringParam(actionParams, "time") ?? readStringParam(actionParams, "startTime"),
        userId: readStringParam(actionParams, "userId"),
        accountId,
      },
      cfg,
    );
  }

  if (
    action === "canvas-create" ||
    action === "canvas-edit" ||
    action === "canvas-delete" ||
    action === "canvas-section-lookup" ||
    action === "channel-canvas-create"
  ) {
    return await invoke(
      {
        action:
          action === "canvas-create"
            ? "canvasCreate"
            : action === "canvas-edit"
              ? "canvasEdit"
              : action === "canvas-delete"
                ? "canvasDelete"
                : action === "canvas-section-lookup"
                  ? "canvasSectionLookup"
                  : "channelCanvasCreate",
        channelId:
          action === "channel-canvas-create"
            ? (readStringParam(actionParams, "channelId") ?? readStringParam(actionParams, "to"))
            : undefined,
        canvasId: readStringParam(actionParams, "canvasId") ?? readStringParam(actionParams, "id"),
        title: readStringParam(actionParams, "title"),
        content:
          readStringParam(actionParams, "message", { allowEmpty: true }) ??
          readStringParam(actionParams, "content", { allowEmpty: true }),
        changes: actionParams.changes,
        criteria: actionParams.criteria,
        accountId,
      },
      cfg,
    );
  }

  throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
}
