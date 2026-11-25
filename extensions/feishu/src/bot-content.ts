import type { ClawdbotConfig } from "../runtime-api.js";
import {
  buildFeishuConversationId,
  resolveConfiguredFeishuGroupSessionScope,
} from "./conversation-id.js";
import { normalizeFeishuExternalKey } from "./external-keys.js";
import { saveMessageResourceFeishu } from "./media.js";
import { parsePostContent } from "./post.js";
import type { FeishuChatType, FeishuConfig, FeishuMediaInfo } from "./types.js";

type FeishuGroupSessionConfig = Pick<
  FeishuConfig,
  "groupSessionScope" | "topicSessionMode" | "replyInThread"
>;

export function resolveFeishuGroupSession(params: {
  chatId: string;
  senderOpenId: string;
  messageId: string;
  rootId?: string;
  threadId?: string;
  chatType?: FeishuChatType;
  groupConfig?: FeishuGroupSessionConfig;
  feishuCfg?: FeishuGroupSessionConfig;
}) {
  const { chatId, senderOpenId, messageId, rootId, threadId, chatType, groupConfig, feishuCfg } =
    params;
  const normalizedThreadId = threadId?.trim();
  const normalizedRootId = rootId?.trim();
  const threadReply = Boolean(normalizedThreadId || normalizedRootId);
  const replyInThread =
    (groupConfig?.replyInThread ?? feishuCfg?.replyInThread ?? "disabled") === "enabled" ||
    threadReply;
  const groupSessionScope = resolveConfiguredFeishuGroupSessionScope({ groupConfig, feishuCfg });
  const normalizedTopicGroupThreadId =
    chatType === "topic_group" ? (normalizedThreadId ?? normalizedRootId) : undefined;
  const topicScope =
    groupSessionScope === "group_topic" || groupSessionScope === "group_topic_sender"
      ? (normalizedTopicGroupThreadId ??
        normalizedRootId ??
        normalizedThreadId ??
        (replyInThread ? messageId : null))
      : null;

  const peerId =
    groupSessionScope === "group_sender" || groupSessionScope === "group_topic_sender" || topicScope
      ? buildFeishuConversationId({
          chatId,
          scope: groupSessionScope,
          senderOpenId,
          topicId: topicScope ?? undefined,
        })
      : chatId;

  return {
    peerId,
    parentPeer: topicScope ? { kind: "group" as const, id: chatId } : null,
    groupSessionScope,
    replyInThread,
    threadReply,
  };
}

function parseMediaResource(
  content: string,
  messageType: string,
): { key?: string; fileName?: string } {
  try {
    const parsed = JSON.parse(content);
    const imageKey = normalizeFeishuExternalKey(parsed.image_key);
    const fileKey = normalizeFeishuExternalKey(parsed.file_key);
    const key =
      messageType === "image"
        ? imageKey
        : messageType === "video" || messageType === "media"
          ? fileKey || imageKey
          : fileKey;
    return { key, fileName: parsed.file_name };
  } catch {
    return {};
  }
}

function resolveFeishuMediaKind(messageType: string): FeishuMediaInfo["kind"] {
  switch (messageType) {
    case "image":
      return "image";
    case "file":
      return "document";
    case "audio":
      return "audio";
    case "video":
    case "media":
      return "video";
    default:
      return "document";
  }
}

export async function resolveFeishuMediaList(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  messageType: string;
  content: string;
  maxBytes: number;
  log?: (msg: string) => void;
  accountId?: string;
}): Promise<FeishuMediaInfo[]> {
  const { cfg, messageId, messageType, content, maxBytes, log, accountId } = params;
  // Sticker keys are reusable, but Feishu does not expose their resource bytes.
  const mediaTypes = ["image", "file", "audio", "video", "media", "post"];
  if (!mediaTypes.includes(messageType)) {
    return [];
  }

  const resources: Array<{
    key: string;
    type: "image" | "file";
    fileName?: string;
    kind: FeishuMediaInfo["kind"];
    label: string;
  }> = [];
  if (messageType === "post") {
    const { attachments } = parsePostContent(content);
    if (attachments.length === 0) {
      return [];
    }
    log?.(`feishu: post message contains ${attachments.length} embedded attachment(s)`);
    const seenAttachments = new Set<string>();
    for (const attachment of attachments) {
      const identity = `${attachment.kind}:${attachment.key}`;
      if (seenAttachments.has(identity)) {
        continue;
      }
      seenAttachments.add(identity);
      resources.push({
        key: attachment.key,
        type: attachment.kind,
        fileName: attachment.kind === "file" ? attachment.fileName : undefined,
        kind:
          attachment.kind === "image"
            ? "image"
            : attachment.origin === "top-level"
              ? "document"
              : "video",
        label: `embedded ${attachment.kind} ${attachment.key}`,
      });
    }
  } else {
    const resource = parseMediaResource(content, messageType);
    if (!resource.key) {
      return [{ kind: resolveFeishuMediaKind(messageType) }];
    }
    resources.push({
      key: resource.key,
      type: messageType === "image" ? "image" : "file",
      fileName: resource.fileName,
      kind: resolveFeishuMediaKind(messageType),
      label: `${messageType} media`,
    });
  }

  const out: FeishuMediaInfo[] = [];
  for (const resource of resources) {
    try {
      const saved = await saveMessageResourceFeishu({
        cfg,
        messageId,
        fileKey: resource.key,
        type: resource.type,
        accountId,
        maxBytes,
        originalFilename: resource.fileName,
      });
      out.push({ path: saved.path, contentType: saved.contentType, kind: resource.kind });
      log?.(`feishu: downloaded ${resource.label}, saved to ${saved.path}`);
    } catch (err) {
      out.push({ kind: resource.kind });
      log?.(`feishu: failed to download ${resource.label}: ${String(err)}`);
    }
  }
  return out;
}
