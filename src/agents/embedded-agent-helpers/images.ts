import { replaceCompactionReplayOwnerContent } from "@openclaw/ai/transports";
import { isOwnedTranscriptPayload } from "../../config/sessions/transcript-json.js";
import { freezeJsonSnapshot, isDeeplyFrozenPlainData } from "../../shared/immutable-data.js";
import type { ImageSanitizationLimits } from "../image-sanitization.js";
import type { AgentMessage, AgentToolResult } from "../runtime/index.js";
import type { ToolCallIdMode } from "../tool-call-id.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "../tool-call-id.js";
import { sanitizeContentBlocksImages } from "../tool-images.js";
import { stripThoughtSignatures } from "./bootstrap.js";

type ContentBlock = AgentToolResult<unknown>["content"][number];
const EMPTY_CONTENT_PLACEHOLDER = "[empty content omitted]";
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

export async function sanitizeSessionMessagesImages(
  messages: AgentMessage[],
  label: string,
  options?: {
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
  } & ImageSanitizationLimits,
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
    const policy =
      msg.role === "assistant" ? assistantPolicy | (msg.stopReason === "error" ? 2 : 0) : 0;
    const cache = (imageFreeReplayContent[policy] ??= new WeakMap());
    let nextContent = cache.get(content);
    if (!nextContent) {
      if (msg.role === "assistant") {
        const stripped =
          policy & 2
            ? content
            : stripThoughtSignatures(content, options?.sanitizeThoughtSignatures);
        // Signed empty Responses text still occupies an ordered provider input item.
        nextContent = await sanitizeImages(dropEmptyTextBlocks(stripped, true));
      } else {
        nextContent = dropEmptyTextBlocks(await sanitizeImages(content));
      }
      if (msg.role !== "assistant" && nextContent.length === 0) {
        nextContent = [{ type: "text", text: EMPTY_CONTENT_PLACEHOLDER }];
      }
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
    if (msg.role === "assistant") {
      const finalContent = nextContent as typeof msg.content;
      if (finalContent.length > 0 || msg.providerReplay) {
        out.push(
          finalContent === msg.content && !msg.providerReplay
            ? msg
            : replaceCompactionReplayOwnerContent(msg, finalContent),
        );
      }
    } else {
      out.push(nextContent === msg.content ? msg : { ...msg, content: nextContent });
    }
  }
  return out;
}
