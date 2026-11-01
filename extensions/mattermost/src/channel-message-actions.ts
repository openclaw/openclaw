import {
  jsonResult,
  readPositiveIntegerParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk/channel-contract";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import { listEnabledMattermostAccounts, loadMattermostChannelRuntime } from "./channel-shared.js";
import {
  resolveDefaultMattermostAccountId,
  resolveMattermostAccount,
} from "./mattermost/accounts.js";
import {
  MATTERMOST_EXTENDED_ACTIONS,
  MATTERMOST_GATED_ACTIONS,
  resolveMattermostActionGate,
} from "./mattermost/action-gates.js";
import { normalizeMattermostEmojiName } from "./mattermost/emoji.js";
import { normalizeMattermostMessagingTarget } from "./normalize.js";

const MATTERMOST_READ_AUTHORITY_ACTIONS: ChannelMessageActionName[] = [
  "read",
  "list-pins",
  "search",
  "member-info",
  "channel-info",
  "emoji-list",
  "download-file",
];

export const mattermostMessageActions: ChannelMessageActionAdapter = {
  providerOwnedReadGates: MATTERMOST_READ_AUTHORITY_ACTIONS,
  readAuthorityActions: MATTERMOST_READ_AUTHORITY_ACTIONS,
  describeMessageTool({ cfg, accountId }) {
    const enabledAccounts = listEnabledMattermostAccounts({ cfg, accountId });

    const actions: ChannelMessageActionName[] = [];

    if (enabledAccounts.length > 0) {
      actions.push("send");
    }

    for (const [gate, defaultEnabled, gatedActions] of MATTERMOST_GATED_ACTIONS) {
      const enabled = enabledAccounts.some(
        (account) => account.config.actions?.[gate] ?? defaultEnabled,
      );
      if (enabled) {
        actions.push(...gatedActions);
      }
    }

    return {
      actions,
      capabilities: enabledAccounts.length > 0 ? ["presentation"] : [],
    };
  },
  extractToolSend({ args }) {
    if (normalizeOptionalString(args.action) !== "send") {
      return null;
    }
    const to = normalizeOptionalString(args.to) ?? normalizeOptionalString(args.target);
    if (!to) {
      return null;
    }
    const threadId =
      normalizeOptionalString(args.threadId) ??
      normalizeOptionalString(args.replyToId) ??
      normalizeOptionalString(args.replyTo);
    const threadSuppressed = args.topLevel === true || args.threadId === null;
    return {
      to,
      accountId: normalizeOptionalString(args.accountId),
      ...(threadId ? { threadId } : {}),
      ...(!threadId && !threadSuppressed ? { threadImplicit: true } : {}),
      ...(threadSuppressed ? { threadSuppressed: true } : {}),
    };
  },
  prepareSendPayload: ({ ctx, payload }) => {
    if (ctx.action !== "send") {
      return null;
    }
    const mediaUrls = resolveMattermostSendAttachmentMedia(ctx.params);
    const attachmentText =
      typeof ctx.params.attachmentText === "string" ? ctx.params.attachmentText : undefined;
    const existingMattermostData = asOptionalRecord(payload.channelData?.mattermost);
    return {
      ...payload,
      ...(mediaUrls.length ? { mediaUrl: mediaUrls[0], mediaUrls } : {}),
      ...(attachmentText !== undefined
        ? {
            channelData: {
              ...payload.channelData,
              mattermost: {
                ...existingMattermostData,
                attachmentText,
              },
            },
          }
        : {}),
    };
  },
  supportsAction: ({ action }) =>
    action === "react" || action === "read" || MATTERMOST_EXTENDED_ACTIONS.has(action),
  handleAction: async ({
    action,
    params,
    cfg,
    accountId,
    conversationReadOrigin,
    requesterAccountId,
    requesterSenderId,
    toolContext,
    assertDirectAdapterHandoff,
    mediaAccess,
    mediaLocalRoots,
    mediaReadFile,
  }) => {
    if (action !== "read" && action !== "react" && !MATTERMOST_EXTENDED_ACTIONS.has(action)) {
      throw new Error(`Unsupported Mattermost action: ${action}`);
    }
    const resolvedAccountId = accountId ?? resolveDefaultMattermostAccountId(cfg);
    const account = resolveMattermostAccount({ cfg, accountId: resolvedAccountId });
    if (!account.enabled) {
      throw new Error(`Mattermost account "${resolvedAccountId}" is disabled`);
    }
    // `read` and `react` keep their original, more specific gate messages below.
    const gate =
      action === "read" || action === "react" ? undefined : resolveMattermostActionGate(action);
    if (gate) {
      const [gateName, defaultEnabled] = gate;
      const enabled = account.config.actions?.[gateName] ?? defaultEnabled;
      if (!enabled) {
        throw new Error(`Mattermost ${action} is disabled in config (actions.${gateName})`);
      }
    }
    if (MATTERMOST_EXTENDED_ACTIONS.has(action)) {
      return await (
        await loadMattermostChannelRuntime()
      ).runMattermostMessageAction({
        action,
        params,
        cfg,
        accountId: resolvedAccountId,
        context: {
          conversationReadOrigin,
          requesterAccountId,
          requesterSenderId,
          toolContext,
          assertDirectAdapterHandoff,
        },
        mediaLocalRoots: mediaLocalRoots ?? mediaAccess?.localRoots,
        mediaReadFile: mediaReadFile ?? mediaAccess?.readFile,
        workspaceDir: mediaAccess?.workspaceDir,
      });
    }
    if (action === "read") {
      const messagesEnabled = account.config.actions?.messages ?? false;
      if (!messagesEnabled) {
        throw new Error("Mattermost message reads are disabled in config");
      }

      const rawTarget =
        readStringParam(params, "to") ??
        readStringParam(params, "channelId") ??
        readStringParam(params, "target");
      if (!rawTarget) {
        throw new Error("Mattermost read requires target, to, or channelId.");
      }
      const normalizedTarget = normalizeMattermostMessagingTarget(rawTarget);
      const channelId = normalizedTarget?.startsWith("channel:")
        ? normalizedTarget.slice("channel:".length).trim()
        : !rawTarget.includes(":")
          ? rawTarget
          : "";
      if (!channelId) {
        throw new Error("Mattermost read requires a channel target.");
      }

      const before = readStringParam(params, "before");
      const after = readStringParam(params, "after");
      if (before && after) {
        throw new Error("Mattermost read accepts either before or after, not both.");
      }
      const result = await (
        await loadMattermostChannelRuntime()
      ).readMattermostMessages({
        cfg,
        channelId,
        limit: readPositiveIntegerParam(params, "limit", {
          message: "limit must be a positive integer.",
        }),
        before,
        after,
        accountId: resolvedAccountId,
        context: {
          conversationReadOrigin,
          requesterAccountId,
          toolContext,
          assertDirectAdapterHandoff,
        },
      });
      return jsonResult({
        ok: true,
        channelId,
        messages: result.messages,
        hasMore: result.hasMore,
      });
    }

    const reactionsEnabled = account.config.actions?.reactions ?? true;
    if (!reactionsEnabled) {
      throw new Error("Mattermost reactions are disabled in config");
    }

    const postId =
      normalizeOptionalString(params.messageId) ?? normalizeOptionalString(params.postId);
    if (!postId) {
      throw new Error("Mattermost react requires messageId (post id)");
    }

    const emojiName = normalizeMattermostEmojiName(normalizeOptionalString(params.emoji));
    if (!emojiName) {
      throw new Error("Mattermost react requires emoji");
    }

    const remove = params.remove === true;
    // The runner preserves the caller's spelling in `target` and puts the
    // directory-resolved provider destination in `to` before dispatch.
    const authorizedTarget = normalizeOptionalString(params.to);
    const runtime = await loadMattermostChannelRuntime();
    const mutateReaction = remove
      ? runtime.removeMattermostReaction
      : runtime.addMattermostReaction;
    const result = await mutateReaction({
      cfg,
      postId,
      emojiName,
      accountId: resolvedAccountId,
      authorizedTarget,
      conversationReadOrigin,
      assertDirectAdapterHandoff,
    });
    if (!result.ok) {
      throw new Error(result.error);
    }

    return textResult(
      remove
        ? `Removed reaction :${emojiName}: from ${postId}`
        : `Reacted with :${emojiName}: on ${postId}`,
      {},
    );
  },
};

function hasUnsupportedMattermostAttachmentPayload(record: Record<string, unknown>): boolean {
  return ["buffer", "base64"].some((key) => {
    const value = record[key];
    return typeof value === "string" ? Boolean(value.trim()) : value != null;
  });
}

function resolveMattermostSendAttachmentMedia(params: Record<string, unknown>): string[] {
  const sourceKeys = ["media", "mediaUrl", "path", "filePath", "fileUrl"];
  const candidates = sourceKeys.map((key) => readStringParam(params, key));
  candidates.push(...(readStringArrayParam(params, "mediaUrls") ?? []));

  let hasUnsupportedAttachmentPayload = hasUnsupportedMattermostAttachmentPayload(params);
  if (Array.isArray(params.attachments)) {
    for (const attachment of params.attachments) {
      const record = asOptionalRecord(attachment);
      if (!record) {
        continue;
      }
      candidates.push(...sourceKeys.map((key) => readStringParam(record, key)));
      candidates.push(readStringParam(record, "url"));
      hasUnsupportedAttachmentPayload ||= hasUnsupportedMattermostAttachmentPayload(record);
    }
  }

  if (hasUnsupportedAttachmentPayload) {
    throw new Error(
      "Mattermost send attachments require media, mediaUrl, path, filePath, fileUrl, mediaUrls, or attachments[] with one of those fields; buffer/base64 payloads are not supported.",
    );
  }
  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))];
}
