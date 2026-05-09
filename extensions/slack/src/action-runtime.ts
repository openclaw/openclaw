import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { parseSlackBlocksInput } from "./blocks-input.js";
import {
  createActionGate,
  imageResultFromFile,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
  type OpenClawConfig,
  withNormalizedTimestamp,
} from "./runtime-api.js";
import { parseSlackTarget, resolveSlackChannelId } from "./targets.js";

const messagingActions = new Set([
  "sendMessage",
  "uploadFile",
  "editMessage",
  "deleteMessage",
  "readMessages",
  "downloadFile",
]);

const reactionsActions = new Set(["react", "reactions"]);
const pinActions = new Set(["pinMessage", "unpinMessage", "listPins"]);
const searchActions = new Set(["searchMessages"]);
const channelInfoActions = new Set(["channelInfo", "channelList"]);
const scheduledMessageActions = new Set([
  "scheduleMessage",
  "listScheduledMessages",
  "deleteScheduledMessage",
]);
const ephemeralMessageActions = new Set(["postEphemeral"]);
const fileActions = new Set(["listFiles", "deleteFile"]);
const bookmarkActions = new Set(["bookmarkAdd", "bookmarkEdit", "bookmarkList", "bookmarkRemove"]);
const reminderActions = new Set([
  "reminderAdd",
  "reminderList",
  "reminderInfo",
  "reminderComplete",
  "reminderDelete",
]);
const canvasActions = new Set([
  "canvasCreate",
  "canvasEdit",
  "canvasDelete",
  "canvasSectionLookup",
  "channelCanvasCreate",
]);

function sameSlackChannelTarget(targetChannel: string, currentChannelId: string): boolean {
  const parsedTarget = parseSlackTarget(targetChannel, {
    defaultKind: "channel",
  });
  if (!parsedTarget || parsedTarget.kind !== "channel") {
    return false;
  }
  return (
    normalizeLowercaseStringOrEmpty(parsedTarget.id) ===
    normalizeLowercaseStringOrEmpty(currentChannelId)
  );
}

type SlackActionsRuntimeModule = typeof import("./actions.runtime.js");
type SlackAccountsRuntimeModule = typeof import("./accounts.runtime.js");

let slackActionsRuntimePromise: Promise<SlackActionsRuntimeModule> | undefined;
let slackAccountsRuntimePromise: Promise<SlackAccountsRuntimeModule> | undefined;

function loadSlackActionsRuntime(): Promise<SlackActionsRuntimeModule> {
  slackActionsRuntimePromise ??= import("./actions.runtime.js");
  return slackActionsRuntimePromise;
}

function loadSlackAccountsRuntime(): Promise<SlackAccountsRuntimeModule> {
  slackAccountsRuntimePromise ??= import("./accounts.runtime.js");
  return slackAccountsRuntimePromise;
}

function createLazySlackAction<K extends keyof SlackActionsRuntimeModule>(
  key: K,
): SlackActionsRuntimeModule[K] {
  return (async (...args: unknown[]) => {
    const runtime = await loadSlackActionsRuntime();
    const action = runtime[key] as (...actionArgs: unknown[]) => unknown;
    return action(...args);
  }) as SlackActionsRuntimeModule[K];
}

export const slackActionRuntime = {
  addSlackBookmark: createLazySlackAction("addSlackBookmark"),
  addSlackReminder: createLazySlackAction("addSlackReminder"),
  completeSlackReminder: createLazySlackAction("completeSlackReminder"),
  createSlackCanvas: createLazySlackAction("createSlackCanvas"),
  createSlackConversationCanvas: createLazySlackAction("createSlackConversationCanvas"),
  deleteSlackMessage: createLazySlackAction("deleteSlackMessage"),
  deleteSlackCanvas: createLazySlackAction("deleteSlackCanvas"),
  deleteSlackFile: createLazySlackAction("deleteSlackFile"),
  deleteSlackReminder: createLazySlackAction("deleteSlackReminder"),
  deleteSlackScheduledMessage: createLazySlackAction("deleteSlackScheduledMessage"),
  downloadSlackFile: createLazySlackAction("downloadSlackFile"),
  editSlackBookmark: createLazySlackAction("editSlackBookmark"),
  editSlackCanvas: createLazySlackAction("editSlackCanvas"),
  editSlackMessage: createLazySlackAction("editSlackMessage"),
  getSlackChannelInfo: createLazySlackAction("getSlackChannelInfo"),
  getSlackMemberInfo: createLazySlackAction("getSlackMemberInfo"),
  getSlackPermalink: createLazySlackAction("getSlackPermalink"),
  getSlackReminderInfo: createLazySlackAction("getSlackReminderInfo"),
  listSlackBookmarks: createLazySlackAction("listSlackBookmarks"),
  listSlackChannels: createLazySlackAction("listSlackChannels"),
  listSlackEmojis: createLazySlackAction("listSlackEmojis"),
  listSlackFiles: createLazySlackAction("listSlackFiles"),
  listSlackPins: createLazySlackAction("listSlackPins"),
  listSlackReactions: createLazySlackAction("listSlackReactions"),
  listSlackReminders: createLazySlackAction("listSlackReminders"),
  listSlackScheduledMessages: createLazySlackAction("listSlackScheduledMessages"),
  lookupSlackCanvasSection: createLazySlackAction("lookupSlackCanvasSection"),
  parseSlackBlocksInput,
  pinSlackMessage: createLazySlackAction("pinSlackMessage"),
  postSlackEphemeral: createLazySlackAction("postSlackEphemeral"),
  reactSlackMessage: createLazySlackAction("reactSlackMessage"),
  readSlackMessages: createLazySlackAction("readSlackMessages"),
  removeOwnSlackReactions: createLazySlackAction("removeOwnSlackReactions"),
  removeSlackBookmark: createLazySlackAction("removeSlackBookmark"),
  removeSlackReaction: createLazySlackAction("removeSlackReaction"),
  scheduleSlackMessage: createLazySlackAction("scheduleSlackMessage"),
  searchSlackMessages: createLazySlackAction("searchSlackMessages"),
  sendSlackMessage: createLazySlackAction("sendSlackMessage"),
  unpinSlackMessage: createLazySlackAction("unpinSlackMessage"),
};

export type SlackActionContext = {
  /** Current channel ID for auto-threading. */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading. */
  currentThreadTs?: string;
  /** Reply-to mode for auto-threading. */
  replyToMode?: "off" | "first" | "all" | "batched";
  /** Mutable ref to track if a reply was sent for single-use reply modes. */
  hasRepliedRef?: { value: boolean };
  /** Allowed local media directories for file uploads. */
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
};

/**
 * Resolve threadTs for a Slack message based on context and replyToMode.
 * - "all": always inject threadTs
 * - "first"/"batched": inject only for the first eligible message (updates hasRepliedRef)
 * - "off": never auto-inject
 */
function resolveThreadTsFromContext(
  explicitThreadTs: string | undefined,
  targetChannel: string,
  context: SlackActionContext | undefined,
): string | undefined {
  // Agent explicitly provided threadTs - use it
  if (explicitThreadTs) {
    return explicitThreadTs;
  }
  // No context or missing required fields
  if (!context?.currentThreadTs || !context?.currentChannelId) {
    return undefined;
  }

  // Different channel - don't inject
  if (!sameSlackChannelTarget(targetChannel, context.currentChannelId)) {
    return undefined;
  }

  // Check replyToMode
  if (context.replyToMode === "all") {
    return context.currentThreadTs;
  }
  if (
    isSingleUseReplyToMode(context.replyToMode ?? "off") &&
    context.hasRepliedRef &&
    !context.hasRepliedRef.value
  ) {
    context.hasRepliedRef.value = true;
    return context.currentThreadTs;
  }
  return undefined;
}

function readSlackBlocksParam(params: Record<string, unknown>) {
  return slackActionRuntime.parseSlackBlocksInput(params.blocks);
}

function isImageContentType(value: string | undefined): boolean {
  return value?.trim().toLowerCase().startsWith("image/") === true;
}

function readBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  return typeof value === "boolean" ? value : undefined;
}

function readPositiveIntegerParam(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = readNumberParam(params, key, { integer: true });
  return value != null && value > 0 ? value : undefined;
}

function readEpochSecondsParam(params: Record<string, unknown>, key: string): number {
  const numberValue = readNumberParam(params, key, { integer: true });
  if (numberValue != null) {
    return numberValue;
  }
  const raw = readStringParam(params, key, { required: true });
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be a Unix timestamp in seconds or a parseable date string.`);
  }
  return Math.floor(parsed / 1000);
}

function readObjectParam(params: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = params[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readNonEmptyArrayParam(
  params: Record<string, unknown>,
  key: string,
): [unknown, ...unknown[]] {
  const value = params[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${key} must be a non-empty array.`);
  }
  return value as [unknown, ...unknown[]];
}

export async function handleSlackAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  context?: SlackActionContext,
): Promise<AgentToolResult<unknown>> {
  const resolveChannelId = () =>
    resolveSlackChannelId(
      readStringParam(params, "channelId", {
        required: true,
      }),
    );
  const action = readStringParam(params, "action", { required: true });
  const accountId = readStringParam(params, "accountId");
  const { resolveSlackAccount } = await loadSlackAccountsRuntime();
  const account = resolveSlackAccount({ cfg, accountId });
  const actionConfig = account.actions ?? cfg.channels?.slack?.actions;
  const isActionEnabled = createActionGate(actionConfig);
  const userToken = account.userToken;
  const botToken = account.botToken?.trim();
  const allowUserWrites = account.config.userTokenReadOnly === false;

  // Choose the most appropriate token for Slack read/write operations.
  const getTokenForOperation = (operation: "read" | "write") => {
    if (operation === "read") {
      return userToken ?? botToken;
    }
    if (!allowUserWrites) {
      return botToken;
    }
    return botToken ?? userToken;
  };

  const buildActionOpts = (operation: "read" | "write") => {
    const token = getTokenForOperation(operation);
    const tokenOverride = token && token !== botToken ? token : undefined;
    return {
      cfg,
      ...(accountId ? { accountId } : {}),
      ...(tokenOverride ? { token: tokenOverride } : {}),
    };
  };

  const readOpts = buildActionOpts("read");
  const writeOpts = buildActionOpts("write");

  if (reactionsActions.has(action)) {
    if (!isActionEnabled("reactions")) {
      throw new Error("Slack reactions are disabled.");
    }
    const channelId = resolveChannelId();
    const messageId = readStringParam(params, "messageId", { required: true });
    if (action === "react") {
      const { emoji, remove, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove a Slack reaction.",
      });
      if (remove) {
        if (writeOpts) {
          await slackActionRuntime.removeSlackReaction(channelId, messageId, emoji, writeOpts);
        } else {
          await slackActionRuntime.removeSlackReaction(channelId, messageId, emoji);
        }
        return jsonResult({ ok: true, removed: emoji });
      }
      if (isEmpty) {
        const removed = writeOpts
          ? await slackActionRuntime.removeOwnSlackReactions(channelId, messageId, writeOpts)
          : await slackActionRuntime.removeOwnSlackReactions(channelId, messageId);
        return jsonResult({ ok: true, removed });
      }
      if (writeOpts) {
        await slackActionRuntime.reactSlackMessage(channelId, messageId, emoji, writeOpts);
      } else {
        await slackActionRuntime.reactSlackMessage(channelId, messageId, emoji);
      }
      return jsonResult({ ok: true, added: emoji });
    }
    const reactions = readOpts
      ? await slackActionRuntime.listSlackReactions(channelId, messageId, readOpts)
      : await slackActionRuntime.listSlackReactions(channelId, messageId);
    return jsonResult({ ok: true, reactions });
  }

  if (messagingActions.has(action)) {
    if (!isActionEnabled("messages")) {
      throw new Error("Slack messages are disabled.");
    }
    switch (action) {
      case "sendMessage": {
        const to = readStringParam(params, "to", { required: true });
        const content = readStringParam(params, "content", {
          allowEmpty: true,
        });
        const mediaUrl = readStringParam(params, "mediaUrl");
        const blocks = readSlackBlocksParam(params);
        if (!content && !mediaUrl && !blocks) {
          throw new Error("Slack sendMessage requires content, blocks, or mediaUrl.");
        }
        const threadTs = resolveThreadTsFromContext(
          readStringParam(params, "threadTs"),
          to,
          context,
        );
        const sendOpts = {
          ...writeOpts,
          mediaLocalRoots: context?.mediaLocalRoots,
          mediaReadFile: context?.mediaReadFile,
          threadTs: threadTs ?? undefined,
          replyBroadcast: readBooleanParam(params, "replyBroadcast"),
          unfurlLinks: readBooleanParam(params, "unfurlLinks"),
          unfurlMedia: readBooleanParam(params, "unfurlMedia"),
        };
        const result =
          mediaUrl && blocks
            ? await (async () => {
                await slackActionRuntime.sendSlackMessage(to, "", {
                  ...sendOpts,
                  mediaUrl,
                });
                return await slackActionRuntime.sendSlackMessage(to, content ?? "", {
                  ...sendOpts,
                  blocks,
                });
              })()
            : await slackActionRuntime.sendSlackMessage(to, content ?? "", {
                ...sendOpts,
                mediaUrl: mediaUrl ?? undefined,
                blocks,
              });

        // Keep "first" mode consistent even when the agent explicitly provided
        // threadTs: once we send a message to the current channel, consider the
        // first reply "used" so later tool calls don't auto-thread again.
        if (context?.hasRepliedRef && context.currentChannelId) {
          if (sameSlackChannelTarget(to, context.currentChannelId)) {
            context.hasRepliedRef.value = true;
          }
        }

        return jsonResult({ ok: true, result });
      }
      case "uploadFile": {
        const to = readStringParam(params, "to", { required: true });
        const filePath = readStringParam(params, "filePath", {
          required: true,
          trim: false,
        });
        const initialComment = readStringParam(params, "initialComment", {
          allowEmpty: true,
        });
        const filename = readStringParam(params, "filename");
        const title = readStringParam(params, "title");
        const threadTs = resolveThreadTsFromContext(
          readStringParam(params, "threadTs"),
          to,
          context,
        );
        const result = await slackActionRuntime.sendSlackMessage(to, initialComment ?? "", {
          ...writeOpts,
          mediaUrl: filePath,
          mediaLocalRoots: context?.mediaLocalRoots,
          mediaReadFile: context?.mediaReadFile,
          threadTs: threadTs ?? undefined,
          ...(filename ? { uploadFileName: filename } : {}),
          ...(title ? { uploadTitle: title } : {}),
        });

        if (context?.hasRepliedRef && context.currentChannelId) {
          if (sameSlackChannelTarget(to, context.currentChannelId)) {
            context.hasRepliedRef.value = true;
          }
        }

        return jsonResult({ ok: true, result });
      }
      case "editMessage": {
        const channelId = resolveChannelId();
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        const content = readStringParam(params, "content", {
          allowEmpty: true,
        });
        const blocks = readSlackBlocksParam(params);
        if (!content && !blocks) {
          throw new Error("Slack editMessage requires content or blocks.");
        }
        if (writeOpts) {
          await slackActionRuntime.editSlackMessage(channelId, messageId, content ?? "", {
            ...writeOpts,
            blocks,
          });
        } else {
          await slackActionRuntime.editSlackMessage(channelId, messageId, content ?? "", {
            blocks,
          });
        }
        return jsonResult({ ok: true });
      }
      case "deleteMessage": {
        const channelId = resolveChannelId();
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        if (writeOpts) {
          await slackActionRuntime.deleteSlackMessage(channelId, messageId, writeOpts);
        } else {
          await slackActionRuntime.deleteSlackMessage(channelId, messageId);
        }
        return jsonResult({ ok: true });
      }
      case "readMessages": {
        const channelId = resolveChannelId();
        const limitRaw = params.limit;
        const limit =
          typeof limitRaw === "number" && Number.isFinite(limitRaw) ? limitRaw : undefined;
        const before = readStringParam(params, "before");
        const after = readStringParam(params, "after");
        const threadId = readStringParam(params, "threadId");
        const messageId = readStringParam(params, "messageId");
        const result = await slackActionRuntime.readSlackMessages(channelId, {
          ...readOpts,
          limit,
          before: before ?? undefined,
          after: after ?? undefined,
          threadId: threadId ?? undefined,
          messageId: messageId ?? undefined,
        });
        const messages = result.messages.map((message) =>
          withNormalizedTimestamp(
            message as Record<string, unknown>,
            (message as { ts?: unknown }).ts,
          ),
        );
        return jsonResult({ ok: true, messages, hasMore: result.hasMore });
      }
      case "downloadFile": {
        const fileId = readStringParam(params, "fileId", { required: true });
        const channelTarget = readStringParam(params, "channelId") ?? readStringParam(params, "to");
        const channelId = channelTarget ? resolveSlackChannelId(channelTarget) : undefined;
        const threadId = readStringParam(params, "threadId") ?? readStringParam(params, "replyTo");
        const maxBytes = account.config?.mediaMaxMb
          ? account.config.mediaMaxMb * 1024 * 1024
          : 20 * 1024 * 1024;
        const readToken = getTokenForOperation("read");
        const downloaded = await slackActionRuntime.downloadSlackFile(fileId, {
          ...readOpts,
          ...(readToken && !readOpts?.token ? { token: readToken } : {}),
          maxBytes,
          channelId,
          threadId: threadId ?? undefined,
        });
        if (!downloaded) {
          return jsonResult({
            ok: false,
            error: "File could not be downloaded (not found, too large, or inaccessible).",
          });
        }
        if (!isImageContentType(downloaded.contentType)) {
          return jsonResult({
            ok: true,
            fileId,
            path: downloaded.path,
            contentType: downloaded.contentType,
            placeholder: downloaded.placeholder,
            media: {
              mediaUrl: downloaded.path,
              ...(downloaded.contentType ? { contentType: downloaded.contentType } : {}),
            },
          });
        }
        return await imageResultFromFile({
          label: "slack-file",
          path: downloaded.path,
          extraText: downloaded.placeholder,
          details: {
            fileId,
            path: downloaded.path,
            ...(downloaded.contentType ? { contentType: downloaded.contentType } : {}),
          },
        });
      }
      default:
        break;
    }
  }

  if (pinActions.has(action)) {
    if (!isActionEnabled("pins")) {
      throw new Error("Slack pins are disabled.");
    }
    const channelId = resolveChannelId();
    if (action === "pinMessage") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      if (writeOpts) {
        await slackActionRuntime.pinSlackMessage(channelId, messageId, writeOpts);
      } else {
        await slackActionRuntime.pinSlackMessage(channelId, messageId);
      }
      return jsonResult({ ok: true });
    }
    if (action === "unpinMessage") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      if (writeOpts) {
        await slackActionRuntime.unpinSlackMessage(channelId, messageId, writeOpts);
      } else {
        await slackActionRuntime.unpinSlackMessage(channelId, messageId);
      }
      return jsonResult({ ok: true });
    }
    const pins = writeOpts
      ? await slackActionRuntime.listSlackPins(channelId, readOpts)
      : await slackActionRuntime.listSlackPins(channelId);
    const normalizedPins = pins.map((pin) => {
      const message = pin.message
        ? withNormalizedTimestamp(
            pin.message as Record<string, unknown>,
            (pin.message as { ts?: unknown }).ts,
          )
        : pin.message;
      return message ? Object.assign({}, pin, { message }) : pin;
    });
    return jsonResult({ ok: true, pins: normalizedPins });
  }

  if (searchActions.has(action)) {
    if (!isActionEnabled("search", false)) {
      throw new Error("Slack search is disabled.");
    }
    if (!userToken && !readOpts.token) {
      throw new Error("Slack search requires channels.slack.userToken with search:read.");
    }
    const query = readStringParam(params, "query", { required: true });
    const result = await slackActionRuntime.searchSlackMessages(query, {
      ...readOpts,
      count: readPositiveIntegerParam(params, "limit") ?? readPositiveIntegerParam(params, "count"),
      page: readPositiveIntegerParam(params, "page"),
      sort: readStringParam(params, "sort"),
      sortDir: readStringParam(params, "sortDir"),
    });
    return jsonResult({ ok: true, result });
  }

  if (channelInfoActions.has(action)) {
    if (!isActionEnabled(action === "channelList" ? "channels" : "channelInfo", false)) {
      throw new Error("Slack channel info is disabled.");
    }
    if (action === "channelInfo") {
      const channelId = resolveChannelId();
      const result = await slackActionRuntime.getSlackChannelInfo(channelId, {
        ...readOpts,
        includeLocale: readBooleanParam(params, "includeLocale"),
        includeNumMembers: readBooleanParam(params, "includeNumMembers"),
      });
      return jsonResult({ ok: true, result });
    }
    const result = await slackActionRuntime.listSlackChannels({
      ...readOpts,
      limit: readPositiveIntegerParam(params, "limit"),
      cursor: readStringParam(params, "pageToken") ?? readStringParam(params, "cursor"),
      types: readStringParam(params, "types") ?? readStringParam(params, "kind"),
      excludeArchived: readBooleanParam(params, "excludeArchived"),
    });
    return jsonResult({ ok: true, result });
  }

  if (action === "getPermalink") {
    if (!isActionEnabled("messages")) {
      throw new Error("Slack messages are disabled.");
    }
    const result = await slackActionRuntime.getSlackPermalink(
      resolveChannelId(),
      readStringParam(params, "messageId", { required: true }),
      readOpts,
    );
    return jsonResult({ ok: true, result });
  }

  if (scheduledMessageActions.has(action)) {
    if (!isActionEnabled("scheduledMessages", false)) {
      throw new Error("Slack scheduled messages are disabled.");
    }
    if (action === "scheduleMessage") {
      const channelId = resolveChannelId();
      const content = readStringParam(params, "content", { required: true, allowEmpty: true });
      const result = await slackActionRuntime.scheduleSlackMessage(
        channelId,
        content,
        readEpochSecondsParam(params, "postAt"),
        {
          ...writeOpts,
          threadTs: readStringParam(params, "threadTs") ?? readStringParam(params, "replyTo"),
          blocks: readSlackBlocksParam(params),
          replyBroadcast: readBooleanParam(params, "replyBroadcast"),
          unfurlLinks: readBooleanParam(params, "unfurlLinks"),
          unfurlMedia: readBooleanParam(params, "unfurlMedia"),
        },
      );
      return jsonResult({ ok: true, result });
    }
    if (action === "deleteScheduledMessage") {
      const result = await slackActionRuntime.deleteSlackScheduledMessage(
        resolveChannelId(),
        readStringParam(params, "scheduledMessageId", { required: true }),
        writeOpts,
      );
      return jsonResult({ ok: true, result });
    }
    const channelTarget = readStringParam(params, "channelId") ?? readStringParam(params, "to");
    const result = await slackActionRuntime.listSlackScheduledMessages({
      ...readOpts,
      channelId: channelTarget ? resolveSlackChannelId(channelTarget) : undefined,
      cursor: readStringParam(params, "pageToken") ?? readStringParam(params, "cursor"),
      latest: readStringParam(params, "before") ?? readStringParam(params, "latest"),
      limit: readPositiveIntegerParam(params, "limit"),
      oldest: readStringParam(params, "after") ?? readStringParam(params, "oldest"),
    });
    return jsonResult({ ok: true, result });
  }

  if (ephemeralMessageActions.has(action)) {
    if (!isActionEnabled("ephemeralMessages", false)) {
      throw new Error("Slack ephemeral messages are disabled.");
    }
    const result = await slackActionRuntime.postSlackEphemeral(
      resolveChannelId(),
      readStringParam(params, "userId", { required: true }),
      readStringParam(params, "content", { required: true, allowEmpty: true }),
      {
        ...writeOpts,
        threadTs: readStringParam(params, "threadTs") ?? readStringParam(params, "replyTo"),
        blocks: readSlackBlocksParam(params),
      },
    );
    return jsonResult({ ok: true, result });
  }

  if (fileActions.has(action)) {
    if (!isActionEnabled("files", false)) {
      throw new Error("Slack files are disabled.");
    }
    if (action === "deleteFile") {
      const result = await slackActionRuntime.deleteSlackFile(
        readStringParam(params, "fileId", { required: true }),
        writeOpts,
      );
      return jsonResult({ ok: true, result });
    }
    const channelTarget = readStringParam(params, "channelId") ?? readStringParam(params, "to");
    const result = await slackActionRuntime.listSlackFiles({
      ...readOpts,
      channelId: channelTarget ? resolveSlackChannelId(channelTarget) : undefined,
      count:
        readPositiveIntegerParam(params, "limit") ??
        readPositiveIntegerParam(params, "count") ??
        readPositiveIntegerParam(params, "pageSize"),
      page: readPositiveIntegerParam(params, "page"),
      tsFrom: readStringParam(params, "after") ?? readStringParam(params, "tsFrom"),
      tsTo: readStringParam(params, "before") ?? readStringParam(params, "tsTo"),
      types: readStringParam(params, "types"),
      userId: readStringParam(params, "userId"),
    });
    return jsonResult({ ok: true, result });
  }

  if (bookmarkActions.has(action)) {
    if (!isActionEnabled("bookmarks", false)) {
      throw new Error("Slack bookmarks are disabled.");
    }
    const channelId = resolveChannelId();
    if (action === "bookmarkList") {
      const result = await slackActionRuntime.listSlackBookmarks(channelId, readOpts);
      return jsonResult({ ok: true, result });
    }
    const bookmarkId = readStringParam(params, "bookmarkId");
    if (action === "bookmarkRemove") {
      const result = await slackActionRuntime.removeSlackBookmark(
        channelId,
        bookmarkId ?? readStringParam(params, "id", { required: true }),
        writeOpts,
      );
      return jsonResult({ ok: true, result });
    }
    if (action === "bookmarkEdit") {
      const result = await slackActionRuntime.editSlackBookmark(
        channelId,
        bookmarkId ?? readStringParam(params, "id", { required: true }),
        {
          ...writeOpts,
          title: readStringParam(params, "title"),
          link: readStringParam(params, "url") ?? readStringParam(params, "link"),
          emoji: readStringParam(params, "emoji"),
          entityId: readStringParam(params, "entityId"),
        },
      );
      return jsonResult({ ok: true, result });
    }
    const result = await slackActionRuntime.addSlackBookmark(channelId, {
      ...writeOpts,
      title: readStringParam(params, "title", { required: true }),
      type: readStringParam(params, "type") ?? "link",
      link: readStringParam(params, "url") ?? readStringParam(params, "link"),
      emoji: readStringParam(params, "emoji"),
      entityId: readStringParam(params, "entityId"),
    });
    return jsonResult({ ok: true, result });
  }

  if (reminderActions.has(action)) {
    if (!isActionEnabled("reminders", false)) {
      throw new Error("Slack reminders are disabled.");
    }
    if (action === "reminderList") {
      const result = await slackActionRuntime.listSlackReminders(readOpts);
      return jsonResult({ ok: true, result });
    }
    const reminderId = readStringParam(params, "reminderId") ?? readStringParam(params, "id");
    if (action === "reminderInfo") {
      const result = await slackActionRuntime.getSlackReminderInfo(
        reminderId ?? readStringParam(params, "id", { required: true }),
        readOpts,
      );
      return jsonResult({ ok: true, result });
    }
    if (action === "reminderComplete") {
      const result = await slackActionRuntime.completeSlackReminder(
        reminderId ?? readStringParam(params, "id", { required: true }),
        writeOpts,
      );
      return jsonResult({ ok: true, result });
    }
    if (action === "reminderDelete") {
      const result = await slackActionRuntime.deleteSlackReminder(
        reminderId ?? readStringParam(params, "id", { required: true }),
        writeOpts,
      );
      return jsonResult({ ok: true, result });
    }
    const result = await slackActionRuntime.addSlackReminder(
      readStringParam(params, "content", { required: true }),
      readStringParam(params, "time", { required: true }),
      { ...writeOpts, userId: readStringParam(params, "userId") },
    );
    return jsonResult({ ok: true, result });
  }

  if (canvasActions.has(action)) {
    if (!isActionEnabled("canvases", false)) {
      throw new Error("Slack canvases are disabled.");
    }
    if (action === "canvasCreate") {
      const result = await slackActionRuntime.createSlackCanvas({
        ...writeOpts,
        title: readStringParam(params, "title"),
        documentContent: readStringParam(params, "content", { allowEmpty: true }),
      });
      return jsonResult({ ok: true, result });
    }
    if (action === "channelCanvasCreate") {
      const result = await slackActionRuntime.createSlackConversationCanvas(resolveChannelId(), {
        ...writeOpts,
        title: readStringParam(params, "title"),
        documentContent: readStringParam(params, "content", { allowEmpty: true }),
      });
      return jsonResult({ ok: true, result });
    }
    const canvasId = readStringParam(params, "canvasId", { required: true });
    if (action === "canvasDelete") {
      const result = await slackActionRuntime.deleteSlackCanvas(canvasId, writeOpts);
      return jsonResult({ ok: true, result });
    }
    if (action === "canvasSectionLookup") {
      const result = await slackActionRuntime.lookupSlackCanvasSection(
        canvasId,
        readObjectParam(params, "criteria"),
        readOpts,
      );
      return jsonResult({ ok: true, result });
    }
    const result = await slackActionRuntime.editSlackCanvas(
      canvasId,
      readNonEmptyArrayParam(params, "changes"),
      writeOpts,
    );
    return jsonResult({ ok: true, result });
  }

  if (action === "memberInfo") {
    if (!isActionEnabled("memberInfo")) {
      throw new Error("Slack member info is disabled.");
    }
    const userId = readStringParam(params, "userId", { required: true });
    const info = writeOpts
      ? await slackActionRuntime.getSlackMemberInfo(userId, readOpts)
      : await slackActionRuntime.getSlackMemberInfo(userId);
    return jsonResult({ ok: true, info });
  }

  if (action === "emojiList") {
    if (!isActionEnabled("emojiList")) {
      throw new Error("Slack emoji list is disabled.");
    }
    const result = readOpts
      ? await slackActionRuntime.listSlackEmojis(readOpts)
      : await slackActionRuntime.listSlackEmojis();
    const limit = readNumberParam(params, "limit", { integer: true });
    if (limit != null && limit > 0 && result.emoji != null) {
      const entries = Object.entries(result.emoji).toSorted(([a], [b]) => a.localeCompare(b));
      if (entries.length > limit) {
        return jsonResult({
          ok: true,
          emojis: {
            ...result,
            emoji: Object.fromEntries(entries.slice(0, limit)),
          },
        });
      }
    }
    return jsonResult({ ok: true, emojis: result });
  }

  throw new Error(`Unknown action: ${action}`);
}
