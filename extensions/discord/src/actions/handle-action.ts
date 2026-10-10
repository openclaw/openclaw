import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import {
  readPositiveIntegerParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/agent-runtime";
import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import { resolveReactionMessageId } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import {
  adaptMessagePresentationForChannel,
  normalizeLegacyInteractiveReply,
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
} from "openclaw/plugin-sdk/interactive-runtime";
import {
  asOptionalRecord,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { handleDiscordAction } from "../../action-runtime-api.js";
import {
  notifyDiscordActiveTurnThreadCreated,
  notifyDiscordActiveTurnThreadReplyDelivered,
} from "../active-turn-thread-route.js";
import { coerceDiscordComponentParam } from "../components.js";
import { discordInboundEventDelivery } from "../inbound-event-delivery.js";
import { withDiscordRequestAuthority } from "../internal/request-authority.js";
import { matchesDiscordToolContextTarget } from "../normalize.js";
import {
  DISCORD_PRESENTATION_CAPABILITIES,
  isDiscordComponentSpecWithinMessageLimit,
} from "../outbound-components.js";
import {
  buildDiscordInteractiveComponents,
  buildDiscordPresentationComponents,
} from "../shared-interactive.js";
import { parseDiscordTarget, resolveDiscordChannelId } from "../targets.js";
import { tryHandleDiscordMessageActionGuildAdmin } from "./handle-action.guild-admin.js";
import type { DiscordMessagingActionOptions } from "./runtime.messaging.shared.js";
import { readDiscordAutoArchiveDurationParam } from "./runtime.shared.js";

const providerId = "discord";

function readCurrentDiscordTarget(
  toolContext: Pick<ChannelMessageActionContext, "toolContext">["toolContext"],
): string | undefined {
  const provider = toolContext?.currentChannelProvider?.trim().toLowerCase();
  if (provider && provider !== providerId) {
    return undefined;
  }
  const target = toolContext?.currentChannelId?.trim();
  return target || undefined;
}

type DiscordMessageActionContext = Pick<
  ChannelMessageActionContext,
  | "action"
  | "params"
  | "cfg"
  | "accountId"
  | "requesterAccountId"
  | "requesterSenderId"
  | "senderIsOwner"
  | "toolContext"
  | "mediaAccess"
  | "mediaLocalRoots"
  | "mediaReadFile"
  | "sessionKey"
  | "inboundEventKind"
  | "conversationReadOrigin"
  | "reply"
  | "progressSnapshot"
  | "assertDirectAdapterHandoff"
>;

export async function handleDiscordMessageAction(
  ctx: DiscordMessageActionContext,
): Promise<AgentToolResult<unknown>> {
  ctx.assertDirectAdapterHandoff?.();
  return await withDiscordRequestAuthority(ctx.assertDirectAdapterHandoff, () =>
    dispatchDiscordMessageAction(ctx),
  );
}

async function dispatchDiscordMessageAction(
  ctx: DiscordMessageActionContext,
): Promise<AgentToolResult<unknown>> {
  const { action, params, cfg } = ctx;
  const accountId = ctx.accountId ?? readStringParam(params, "accountId");
  const readContext =
    ctx.requesterAccountId &&
    ctx.toolContext?.currentChannelProvider &&
    ctx.toolContext.currentChannelId
      ? {
          requesterAccountId: ctx.requesterAccountId,
          currentChannelProvider: ctx.toolContext.currentChannelProvider,
          currentChannelId: ctx.toolContext.currentChannelId,
          currentChatType: ctx.toolContext.currentChatType,
          currentMessagingTarget: ctx.toolContext.currentMessagingTarget,
        }
      : undefined;
  const readPolicyOptions: DiscordMessagingActionOptions | undefined =
    ctx.conversationReadOrigin || readContext
      ? {
          ...(ctx.conversationReadOrigin
            ? { conversationReadOrigin: ctx.conversationReadOrigin }
            : {}),
          ...(readContext ? { readContext } : {}),
        }
      : undefined;
  const actionOptions = {
    mediaAccess: ctx.mediaAccess,
    mediaLocalRoots: ctx.mediaLocalRoots,
    mediaReadFile: ctx.mediaReadFile,
    ...(ctx.reply ? { reply: ctx.reply } : {}),
    ...(ctx.progressSnapshot ? { progressSnapshot: ctx.progressSnapshot } : {}),
    ...readPolicyOptions,
  } as const;
  const runAction = (payload: { action: string; [key: string]: unknown }) =>
    handleDiscordAction({ accountId, ...payload }, cfg, actionOptions);
  const completeOutbound = (
    result: AgentToolResult<unknown>,
    to: string,
    fallbackSessionKey?: string,
  ) => {
    const details = asOptionalRecord(result.details);
    // Resolved failures are not delivery receipts; clearing room history would
    // otherwise permanently discard context without any visible reply.
    if (details?.ok !== true) {
      return result;
    }
    discordInboundEventDelivery.notify({
      sessionKey: ctx.sessionKey ?? fallbackSessionKey ?? undefined,
      to,
      accountId,
      inboundEventKind: ctx.inboundEventKind,
    });
    if (action !== "send" && action !== "upload-file" && action !== "thread-reply") {
      return result;
    }
    let target;
    try {
      target = parseDiscordTarget(to, { defaultKind: "channel" });
    } catch {
      // Route classification runs after delivery and must not turn a
      // successfully resolved Discord target into a failed tool result.
      return result;
    }
    if (
      target?.kind === "channel" &&
      notifyDiscordActiveTurnThreadReplyDelivered({
        sessionKey: ctx.sessionKey ?? fallbackSessionKey,
        accountId,
        threadId: target.id,
      })
    ) {
      return { ...result, details: { ...details, sourceReplyRoute: "current-source" } };
    }
    return result;
  };

  const readTarget = ([firstKey, secondKey]: readonly [string, string] = ["channelId", "to"]) => {
    const target =
      readStringParam(params, firstKey) ??
      readStringParam(params, secondKey) ??
      readCurrentDiscordTarget(ctx.toolContext);
    if (!target) {
      throw new Error("Discord channel target is required (use channel:<id>).");
    }
    return target;
  };
  const resolveChannelId = () => resolveDiscordChannelId(readTarget());

  if (action === "send" || action === "upload-file") {
    const to = readTarget(["to", "target"]);
    const asVoice = action === "send" ? readBooleanParam(params, "asVoice") === true : undefined;
    const [firstMediaKey, lastMediaKey] =
      action === "send" ? (["media", "filePath"] as const) : (["filePath", "media"] as const);
    const mediaUrl =
      readStringParam(params, firstMediaKey, { trim: false }) ??
      readStringParam(params, "path", { trim: false }) ??
      readStringParam(params, lastMediaKey, { trim: false });
    if (action === "upload-file" && !mediaUrl) {
      // Buffer attachments are send-only; upload-file covers existing file/media sources.
      if (readStringParam(params, "buffer", { trim: false })) {
        throw new Error(
          'Use action: "send" for base64 buffer attachments; upload-file requires filePath, path, or media.',
        );
      }
      throw new Error("upload-file requires filePath, path, or media.");
    }
    const content =
      readStringParam(params, "message", { allowEmpty: true, trim: false }) ??
      (action === "upload-file"
        ? (readStringParam(params, "content", { allowEmpty: true, trim: false }) ??
          readStringParam(params, "caption", { allowEmpty: true, trim: false }) ??
          "")
        : undefined);
    const explicitComponents =
      action === "send" ? coerceDiscordComponentParam(params.components) : undefined;
    const presentation =
      action === "send" && explicitComponents == null
        ? normalizeMessagePresentation(params.presentation)
        : undefined;
    const adaptedPresentation = presentation
      ? adaptMessagePresentationForChannel({
          presentation,
          capabilities: DISCORD_PRESENTATION_CAPABILITIES,
        })
      : undefined;
    const generatedPresentationComponents = buildDiscordPresentationComponents(adaptedPresentation);
    const presentationComponents =
      generatedPresentationComponents &&
      isDiscordComponentSpecWithinMessageLimit({
        spec: generatedPresentationComponents,
        fallbackText: content,
        includesMedia: Boolean(mediaUrl),
      })
        ? generatedPresentationComponents
        : undefined;
    const presentationFellBack = Boolean(
      generatedPresentationComponents && !presentationComponents,
    );
    const rawComponents =
      action !== "send" || presentationFellBack
        ? undefined
        : (explicitComponents ??
          presentationComponents ??
          buildDiscordInteractiveComponents(normalizeLegacyInteractiveReply(params.interactive)));
    const hasComponents =
      Boolean(rawComponents) &&
      (typeof rawComponents === "function" || typeof rawComponents === "object");
    const components = hasComponents ? rawComponents : undefined;
    const rawEmbeds = action === "send" ? params.embeds : undefined;
    const embeds = Array.isArray(rawEmbeds) ? rawEmbeds : undefined;
    const deliveryContent =
      presentationFellBack && presentation
        ? renderMessagePresentationFallbackText({
            text: content,
            presentation,
          })
        : content;
    const filename = readStringParam(params, "filename");
    const replyTo = readStringParam(params, "replyTo");
    const silent = readBooleanParam(params, "silent") === true;
    const suppressEmbeds = readBooleanParam(params, "suppressEmbeds");
    const sessionKey = readStringParam(params, "__sessionKey");
    const agentId = readStringParam(params, "__agentId");
    const threadName = action === "send" ? readStringParam(params, "threadName") : undefined;
    const result = await runAction({
      action: "sendMessage",
      to,
      content: deliveryContent,
      ...(threadName ? { threadName } : {}),
      mediaUrl: mediaUrl ?? undefined,
      filename: filename ?? undefined,
      replyTo: replyTo ?? undefined,
      ...(action === "send" ? { components, embeds, asVoice } : {}),
      silent,
      ...(suppressEmbeds === undefined ? {} : { suppressEmbeds }),
      __sessionKey: sessionKey ?? undefined,
      __agentId: agentId ?? undefined,
    });
    return completeOutbound(result, to, sessionKey);
  }

  if (action === "react") {
    const messageIdRaw = resolveReactionMessageId({ args: params, toolContext: ctx.toolContext });
    const messageId = normalizeOptionalStringifiedId(messageIdRaw) ?? "";
    if (!messageId) {
      throw new Error(
        "messageId required. Provide messageId explicitly or react to the current inbound message.",
      );
    }
    const emoji = readStringParam(params, "emoji", { allowEmpty: true });
    const remove = readBooleanParam(params, "remove");
    return await runAction({
      action: "react",
      channelId: readTarget(),
      messageId,
      emoji,
      remove,
    });
  }

  if (action === "reactions") {
    const messageId = readStringParam(params, "messageId", { required: true });
    const limit = readPositiveIntegerParam(params, "limit");
    return await runAction({
      action: "reactions",
      channelId: readTarget(),
      messageId,
      limit,
    });
  }

  if (action === "read") {
    const limit = readPositiveIntegerParam(params, "limit");
    return await runAction({
      action: "readMessages",
      channelId: resolveChannelId(),
      limit,
      before: readStringParam(params, "before"),
      after: readStringParam(params, "after"),
      around: readStringParam(params, "around"),
      messageId: readStringParam(params, "messageId"),
    });
  }

  if (action === "edit" || action === "delete") {
    const messageId = readStringParam(params, "messageId", { required: true });
    const target = readTarget();
    const currentDmChannel =
      action === "edit" &&
      ctx.progressSnapshot &&
      ctx.toolContext?.currentChatType === "direct" &&
      parseDiscordTarget(target, { defaultKind: "channel" })?.kind === "user" &&
      matchesDiscordToolContextTarget({ target, toolContext: ctx.toolContext })
        ? readCurrentDiscordTarget(ctx.toolContext)
        : undefined;
    return await runAction({
      action: action === "edit" ? "editMessage" : "deleteMessage",
      channelId: resolveDiscordChannelId(currentDmChannel ?? target),
      messageId,
      ...(action === "edit" ? { content: params.message } : {}),
    });
  }

  if (action === "pin" || action === "unpin" || action === "list-pins") {
    const messageId =
      action === "list-pins" ? undefined : readStringParam(params, "messageId", { required: true });
    return await runAction({
      action: action === "pin" ? "pinMessage" : action === "unpin" ? "unpinMessage" : "listPins",
      channelId: resolveChannelId(),
      messageId,
    });
  }

  if (action === "permissions") {
    return await runAction({
      action: "permissions",
      channelId: resolveChannelId(),
    });
  }

  if (action === "thread-create") {
    const name = readStringParam(params, "threadName", { required: true });
    const messageId = readStringParam(params, "messageId");
    const content = readStringParam(params, "message", { trim: false });
    const autoArchiveMinutes = readDiscordAutoArchiveDurationParam(params, "autoArchiveMin");
    const appliedTags = readStringArrayParam(params, "appliedTags");
    const result = await runAction({
      action: "threadCreate",
      channelId: resolveChannelId(),
      name,
      messageId,
      content,
      autoArchiveMinutes,
      appliedTags: appliedTags ?? undefined,
    });
    const details =
      result.details && typeof result.details === "object" && !Array.isArray(result.details)
        ? (result.details as { ok?: unknown; thread?: { id?: unknown } })
        : undefined;
    if (details?.ok === true) {
      const threadId = typeof details.thread?.id === "string" ? details.thread.id : undefined;
      await notifyDiscordActiveTurnThreadCreated({
        sessionKey: ctx.sessionKey,
        accountId,
        sourceChannelId: resolveChannelId(),
        sourceMessageId: messageId,
        threadId,
      });
    }
    return completeOutbound(result, resolveChannelId());
  }

  if (action === "sticker") {
    const to = readStringParam(params, "to", { required: true });
    const stickerIds =
      readStringArrayParam(params, "stickerId", {
        required: true,
        label: "sticker-id",
      }) ?? [];
    const result = await runAction({
      action: "sticker",
      to,
      stickerIds,
      content: readStringParam(params, "message", { trim: false }),
      ...(readBooleanParam(params, "silent") === true ? { silent: true } : {}),
    });
    return completeOutbound(result, to);
  }

  if (action === "set-presence") {
    return await runAction({
      action: "setPresence",
      status: readStringParam(params, "status"),
      activityType: readStringParam(params, "activityType"),
      activityName: readStringParam(params, "activityName"),
      activityUrl: readStringParam(params, "activityUrl"),
      activityState: readStringParam(params, "activityState"),
    });
  }

  const adminResult = await tryHandleDiscordMessageActionGuildAdmin({
    ctx,
    resolveChannelId,
    readPolicyOptions,
    actionOptions,
  });
  if (adminResult !== undefined) {
    if (action === "thread-reply") {
      const threadId = readStringParam(params, "threadId") ?? readTarget();
      return completeOutbound(adminResult, threadId);
    }
    return adminResult;
  }

  throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
}
