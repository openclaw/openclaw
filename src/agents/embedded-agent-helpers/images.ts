import { replaceCompactionReplayOwnerContent } from "../../../packages/ai/src/transports/provider-compaction-checkpoint.js";
import { isOwnedTranscriptPayload } from "../../config/sessions/transcript-json.js";
import { freezeJsonSnapshot, isDeeplyFrozenPlainData } from "../../shared/immutable-data.js";
import type { ImageSanitizationLimits } from "../image-sanitization.js";
import type { AgentMessage, AgentToolResult } from "../runtime/index.js";
import { stripThoughtSignatures } from "../thinking-signatures.js";
import type { ToolCallIdMode } from "../tool-call-id.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "../tool-call-id.js";
import { sanitizeContentBlocksImages } from "../tool-images.js";

type ContentBlock = AgentToolResult<unknown>["content"][number];
export const EMPTY_CONTENT_PLACEHOLDER = "[empty content omitted]";
// Weak content roots survive rebuilt tool-result envelopes without retaining sessions.
// Image outcomes remain owned by tool-images: backend failures must stay retryable.
const imageFreeReplayContent: WeakMap<ContentBlock[], ContentBlock[]>[] = [];

function dropEmptyTextBlocks<T>(content: T[], preserveSignedText = false): T[] {
  return content.filter((block) => {
    const rec = block as { type?: unknown; text?: unknown; textSignature?: unknown };
    return (
      !block ||
      typeof block !== "object" ||
      rec.type !== "text" ||
      typeof rec.text !== "string" ||
      rec.text.trim().length > 0 ||
      (preserveSignedText && typeof rec.textSignature === "string" && rec.textSignature.length > 0)
    );
  });
}

export type ReplayImageOptions = {
  sanitizeMode?: "full" | "images-only";
  sanitizeToolCallIds?: boolean;
  preserveNativeAnthropicToolUseIds?: boolean;
  duplicateToolCallIdStyle?: "openai";
  /**
   * Mode for tool call ID sanitization:
   * - "strict" (alphanumeric only)
   * - "strict9" (alphanumeric only, length 9)
   */
  toolCallIdMode?: ToolCallIdMode;
  preserveSignatures?: boolean;
  sanitizeThoughtSignatures?: {
    allowBase64Only?: boolean;
    includeCamelCase?: boolean;
  };
} & ImageSanitizationLimits;

export function prepareAssistantReplayImageContent<T>(
  content: T[],
  preserveSignatures: boolean,
  options?: ReplayImageOptions,
): T[] {
  return dropEmptyTextBlocks(
    preserveSignatures
      ? content
      : stripThoughtSignatures(content, options?.sanitizeThoughtSignatures),
    true,
  );
}

/** Synchronous half of replay sanitation; media work remains in tool-images. */
export function prepareReplayImageContent(
  message: AgentMessage,
  options?: ReplayImageOptions,
): ContentBlock[] | undefined {
  if (
    !message ||
    typeof message !== "object" ||
    (message.role !== "assistant" && message.role !== "user" && message.role !== "toolResult") ||
    (!Array.isArray(message.content) && message.role !== "toolResult")
  ) {
    return undefined;
  }
  const content = (Array.isArray(message.content) ? message.content : []) as ContentBlock[];
  return message.role === "assistant"
    ? prepareAssistantReplayImageContent(
        content,
        Boolean(options?.preserveSignatures) || message.stopReason === "error",
        options,
      )
    : content;
}

export function finishReplayImageContentWithAdapter<T, B>(
  message: T,
  sanitized: B[],
  adapter: {
    role(message: T): string;
    dropEmpty(content: B[]): B[];
    placeholder(): B;
    hasReplay(message: T): boolean;
    replace(message: T, content: B[]): T;
  },
): T | null {
  const role = adapter.role(message);
  if (role !== "assistant" && role !== "user" && role !== "toolResult") {
    return message;
  }
  let content = role === "user" ? adapter.dropEmpty(sanitized) : sanitized;
  if (role === "user" && content.length === 0) {
    content = [adapter.placeholder()];
  }
  return role === "assistant" && content.length === 0 && !adapter.hasReplay(message)
    ? null
    : adapter.replace(message, content);
}

export function finishReplayImageContent(
  message: AgentMessage,
  sanitized: ContentBlock[],
): AgentMessage | null {
  return finishReplayImageContentWithAdapter(message, sanitized, {
    role: (row) => row.role,
    dropEmpty: dropEmptyTextBlocks,
    placeholder: (): ContentBlock => ({ type: "text", text: EMPTY_CONTENT_PLACEHOLDER }),
    hasReplay: (row) => row.role === "assistant" && Boolean(row.providerReplay),
    replace: (row, sanitizedContent) => {
      let content = sanitizedContent;
      if (row.role !== "assistant" && row.role !== "user" && row.role !== "toolResult") {
        return row;
      }
      if (
        Array.isArray(row.content) &&
        content.length === row.content.length &&
        content.every((block, index) => block === row.content[index])
      ) {
        content = row.content as ContentBlock[];
      }
      if (row.role === "assistant") {
        return content === row.content && !row.providerReplay
          ? row
          : replaceCompactionReplayOwnerContent(row, content as typeof row.content);
      }
      return content === row.content ? row : { ...row, content };
    },
  });
}

/** Caller may collect this result immediately when its content contains no image blocks. */
export function sanitizeImageFreeReplayMessage(
  message: AgentMessage,
  options?: ReplayImageOptions,
): AgentMessage | null {
  const content = prepareReplayImageContent(message, options);
  return content === undefined ? message : finishReplayImageContent(message, content);
}

export async function sanitizeSessionMessagesImages(
  messages: AgentMessage[],
  label: string,
  options?: ReplayImageOptions,
): Promise<AgentMessage[]> {
  const imageSanitization = {
    maxDimensionPx: options?.maxDimensionPx,
    maxBytes: options?.maxBytes,
    // Replay does not rewrite stored images, even after a successful reply.
    verifyDecodability: true,
  };
  const sanitizeImages = (content: ContentBlock[]) =>
    sanitizeContentBlocksImages(content, label, imageSanitization);
  const sanitizedIds =
    options?.sanitizeToolCallIds === true
      ? sanitizeToolCallIdsForCloudCodeAssist(messages, options.toolCallIdMode, {
          preserveNativeAnthropicToolUseIds: options?.preserveNativeAnthropicToolUseIds,
          duplicateToolCallIdStyle: options?.duplicateToolCallIdStyle,
        })
      : messages;
  const assistantPolicy =
    1 |
    (options?.preserveSignatures ? 2 : 0) |
    (options?.sanitizeThoughtSignatures?.allowBase64Only ? 4 : 0) |
    (options?.sanitizeThoughtSignatures?.includeCamelCase ? 8 : 0);
  const out: AgentMessage[] = [];
  for (const msg of sanitizedIds) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    if (msg.role !== "toolResult" && msg.role !== "user" && msg.role !== "assistant") {
      out.push(msg);
      continue;
    }
    if (!Array.isArray(msg.content) && msg.role !== "toolResult") {
      out.push(msg);
      continue;
    }
    const content = (Array.isArray(msg.content) ? msg.content : []) as ContentBlock[];
    // User and tool results can share frozen content, but only user text gets a placeholder.
    const policy =
      msg.role === "assistant"
        ? assistantPolicy | (msg.stopReason === "error" ? 2 : 0)
        : msg.role === "toolResult"
          ? 16
          : 0;
    const cache = (imageFreeReplayContent[policy] ??= new WeakMap());
    let nextContent = cache.get(content);
    if (!nextContent) {
      const prepared = prepareReplayImageContent(msg, options) ?? [];
      const sanitized = await sanitizeImages(prepared);
      const finished = finishReplayImageContent(msg, sanitized);
      nextContent =
        finished && "content" in finished && Array.isArray(finished.content)
          ? (finished.content as ContentBlock[])
          : [];
      if (
        nextContent.length === content.length &&
        nextContent.every((block, index) => block === content[index])
      ) {
        nextContent = content;
      }
      if (
        (isOwnedTranscriptPayload(content) || isDeeplyFrozenPlainData(content)) &&
        !content.some((block) => block?.type === "image")
      ) {
        cache.set(content, nextContent === content ? content : freezeJsonSnapshot(nextContent));
      }
    }
    const finished = finishReplayImageContent(msg, nextContent);
    if (finished) {
      out.push(finished);
    }
  }
  return out;
}
