import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { FeishuPermissionError } from "./bot-sender-name.js";
import type { FeishuMediaInfo, FeishuMessageContext } from "./types.js";

const MAX_MENTION_CONTEXT_NAME_LENGTH = 80;

function formatMentionNameForAgentContext(name: string): string {
  const stripped = Array.from(name, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || char === "[" || char === "]" ? " " : char;
  }).join("");
  const normalized = stripped.replace(/\s+/g, " ").trim();
  const bounded =
    normalized.length > MAX_MENTION_CONTEXT_NAME_LENGTH
      ? `${truncateUtf16Safe(normalized, MAX_MENTION_CONTEXT_NAME_LENGTH - 3)}...`
      : normalized;
  return JSON.stringify(bounded || "unknown");
}

function inferAttachmentKind(placeholder: string | undefined): string {
  if (!placeholder) return "file";
  const match = /^<media:([^>]+)>$/.exec(placeholder);
  return match ? match[1] : "file";
}

function formatAttachmentsBlock(mediaList: readonly FeishuMediaInfo[]): string {
  const lines: string[] = ["<attachments>"];
  for (const media of mediaList) {
    if (!media?.path) continue;
    lines.push(`- path: ${media.path}`);
    lines.push(`  kind: ${inferAttachmentKind(media.placeholder)}`);
    if (media.contentType) {
      lines.push(`  contentType: ${media.contentType}`);
    }
  }
  lines.push("</attachments>");
  // Only emit the block if at least one attachment produced a path entry.
  return lines.length > 2 ? lines.join("\n") : "";
}

export function buildFeishuAgentBody(params: {
  ctx: Pick<
    FeishuMessageContext,
    "content" | "senderName" | "senderOpenId" | "mentionTargets" | "messageId" | "hasAnyMention"
  >;
  quotedContent?: string;
  permissionErrorForAgent?: FeishuPermissionError;
  botOpenId?: string;
  mediaList?: readonly FeishuMediaInfo[];
}): string {
  const { ctx, quotedContent, permissionErrorForAgent, botOpenId, mediaList } = params;
  let messageBody = ctx.content;
  if (quotedContent) {
    messageBody = `[Replying to: "${quotedContent}"]\n\n${ctx.content}`;
  }

  messageBody = `${ctx.senderName ?? ctx.senderOpenId}: ${messageBody}`;

  if (ctx.hasAnyMention) {
    const botIdHint = botOpenId?.trim();
    messageBody +=
      `\n\n[System: The content may include mention tags in the form <at user_id="...">name</at>. ` +
      `Treat these as real mentions of Feishu entities (users or bots).]`;
    if (botIdHint) {
      messageBody += `\n[System: If user_id is "${botIdHint}", that mention refers to you.]`;
    }
  }

  if (ctx.mentionTargets && ctx.mentionTargets.length > 0) {
    const targetNames = ctx.mentionTargets
      .map((target) => formatMentionNameForAgentContext(target.name))
      .join(", ");
    messageBody += `\n\n[System: Feishu users mentioned in the incoming message, for context only: ${targetNames}. Do not notify or mention these users solely because they are listed here.]`;
  }

  messageBody = `[message_id: ${ctx.messageId}]\n${messageBody}`;
  if (permissionErrorForAgent) {
    const grantUrl = permissionErrorForAgent.grantUrl ?? "";
    messageBody += `\n\n[System: The bot encountered a Feishu API permission error. Please inform the user about this issue and provide the permission grant URL for the admin to authorize. Permission grant URL: ${grantUrl}]`;
  }
  if (mediaList && mediaList.length > 0) {
    // Persist a durable, machine-readable reference to each downloaded attachment
    // so follow-up turns can locate the file even when the inline preview was
    // truncated (see #108534).
    const attachmentsBlock = formatAttachmentsBlock(mediaList);
    if (attachmentsBlock) {
      messageBody += `\n\n${attachmentsBlock}`;
    }
  }
  return messageBody;
}
