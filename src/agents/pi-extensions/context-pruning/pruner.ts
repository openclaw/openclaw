import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { CACHED_MEDIA_MARKER_PREFIX } from "../../../media/media-cache.js";
import { CHARS_PER_TOKEN_ESTIMATE, estimateStringChars } from "../../../utils/cjk-chars.js";
import type { EffectiveContextPruningSettings } from "./settings.js";
import { makeToolPrunablePredicate } from "./tools.js";

const IMAGE_CHAR_ESTIMATE = 8_000;
export const PRUNED_CONTEXT_IMAGE_MARKER = "[image removed during context pruning]";

/**
 * Extract text blocks containing `[media cached: ...]` markers from a tool result
 * so they can be preserved through hard-clear operations.
 */
function extractCachedMediaMarkers(msg: AgentMessage): TextContent[] {
  if (msg.role !== "toolResult") {
    return [];
  }
  const markers: TextContent[] = [];
  for (const block of (msg as unknown as ToolResultMessage).content) {
    if (
      "text" in block &&
      typeof block.text === "string" &&
      block.text.includes(CACHED_MEDIA_MARKER_PREFIX)
    ) {
      markers.push(block);
    }
  }
  return markers;
}

/**
 * Metadata for a media block that was pruned from the context.
 * Used by the extension layer to optionally cache the media to disk.
 */
export interface PrunedMediaRef {
  /** Index of the message in the output array that contains the placeholder */
  messageIndex: number;
  /** The base64 data from the pruned media block */
  data: string;
  /** The MIME type from the pruned media block */
  mimeType: string;
}

function asText(text: string): TextContent {
  return { type: "text", text };
}

function collectTextSegments(content: ReadonlyArray<TextContent | ImageContent>): string[] {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts;
}

function collectPrunableToolResultSegments(
  content: ReadonlyArray<TextContent | ImageContent>,
  onMedia?: (block: ImageContent) => void,
): string[] {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "image") {
      onMedia?.(block);
      parts.push(PRUNED_CONTEXT_IMAGE_MARKER);
    }
  }
  return parts;
}

function estimateJoinedTextLength(parts: string[]): number {
  if (parts.length === 0) {
    return 0;
  }
  let len = 0;
  for (const p of parts) {
    len += p.length;
  }
  // Joined with "\n" separators between blocks.
  len += Math.max(0, parts.length - 1);
  return len;
}

function takeHeadFromJoinedText(parts: string[], maxChars: number): string {
  if (maxChars <= 0 || parts.length === 0) {
    return "";
  }
  let remaining = maxChars;
  let out = "";
  for (let i = 0; i < parts.length && remaining > 0; i++) {
    if (i > 0) {
      out += "\n";
      remaining -= 1;
      if (remaining <= 0) {
        break;
      }
    }
    const p = parts[i];
    if (p.length <= remaining) {
      out += p;
      remaining -= p.length;
    } else {
      out += p.slice(0, remaining);
      remaining = 0;
    }
  }
  return out;
}

function takeTailFromJoinedText(parts: string[], maxChars: number): string {
  if (maxChars <= 0 || parts.length === 0) {
    return "";
  }
  let remaining = maxChars;
  const out: string[] = [];
  for (let i = parts.length - 1; i >= 0 && remaining > 0; i--) {
    const p = parts[i];
    if (p.length <= remaining) {
      out.push(p);
      remaining -= p.length;
    } else {
      out.push(p.slice(p.length - remaining));
      remaining = 0;
      break;
    }
    if (remaining > 0 && i > 0) {
      out.push("\n");
      remaining -= 1;
    }
  }
  out.reverse();
  return out.join("");
}

function hasImageBlocks(content: ReadonlyArray<TextContent | ImageContent>): boolean {
  for (const block of content) {
    if (block.type === "image") {
      return true;
    }
  }
  return false;
}

function estimateWeightedTextChars(text: string): number {
  return estimateStringChars(text);
}

function estimateTextAndImageChars(content: ReadonlyArray<TextContent | ImageContent>): number {
  let chars = 0;
  for (const block of content) {
    if (block.type === "text") {
      chars += estimateWeightedTextChars(block.text);
    }
    if (block.type === "image") {
      chars += IMAGE_CHAR_ESTIMATE;
    }
  }
  return chars;
}

function estimateMessageChars(message: AgentMessage): number {
  if (message.role === "user") {
    const content = message.content;
    if (typeof content === "string") {
      return estimateWeightedTextChars(content);
    }
    return estimateTextAndImageChars(content);
  }

  if (message.role === "assistant") {
    let chars = 0;
    for (const b of message.content) {
      if (!b || typeof b !== "object") {
        continue;
      }
      if (b.type === "text" && typeof b.text === "string") {
        chars += estimateWeightedTextChars(b.text);
      }
      if (b.type === "thinking" && typeof b.thinking === "string") {
        chars += estimateWeightedTextChars(b.thinking);
      }
      if (b.type === "toolCall") {
        try {
          chars += JSON.stringify(b.arguments ?? {}).length;
        } catch {
          chars += 128;
        }
      }
    }
    return chars;
  }

  if (message.role === "toolResult") {
    return estimateTextAndImageChars(message.content);
  }

  return 256;
}

function estimateContextChars(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageChars(m), 0);
}

function findAssistantCutoffIndex(
  messages: AgentMessage[],
  keepLastAssistants: number,
): number | null {
  // keepLastAssistants <= 0 => everything is potentially prunable.
  if (keepLastAssistants <= 0) {
    return messages.length;
  }

  let remaining = keepLastAssistants;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") {
      continue;
    }
    remaining--;
    if (remaining === 0) {
      return i;
    }
  }

  // Not enough assistant messages to establish a protected tail.
  return null;
}

function findFirstUserIndex(messages: AgentMessage[]): number | null {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") {
      return i;
    }
  }
  return null;
}

function softTrimToolResultMessage(params: {
  msg: ToolResultMessage;
  settings: EffectiveContextPruningSettings;
  onMedia?: (block: ImageContent) => void;
}): ToolResultMessage | null {
  const { msg, settings } = params;
  const hasImages = hasImageBlocks(msg.content);
  const parts = hasImages
    ? collectPrunableToolResultSegments(msg.content, params.onMedia)
    : collectTextSegments(msg.content);
  const rawLen = estimateJoinedTextLength(parts);
  if (rawLen <= settings.softTrim.maxChars) {
    if (!hasImages) {
      return null;
    }
    return { ...msg, content: [asText(parts.join("\n"))] };
  }

  const headChars = Math.max(0, settings.softTrim.headChars);
  const tailChars = Math.max(0, settings.softTrim.tailChars);
  if (headChars + tailChars >= rawLen) {
    if (!hasImages) {
      return null;
    }
    return { ...msg, content: [asText(parts.join("\n"))] };
  }

  const head = takeHeadFromJoinedText(parts, headChars);
  const tail = takeTailFromJoinedText(parts, tailChars);
  const trimmed = `${head}
...
${tail}`;

  const note = `

[Tool result trimmed: kept first ${headChars} chars and last ${tailChars} chars of ${rawLen} chars.]`;

  return { ...msg, content: [asText(trimmed + note)] };
}

export function pruneContextMessages(params: {
  messages: AgentMessage[];
  settings: EffectiveContextPruningSettings;
  ctx: Pick<ExtensionContext, "model">;
  isToolPrunable?: (toolName: string) => boolean;
  contextWindowTokensOverride?: number;
}): AgentMessage[] {
  const { messages, settings, ctx } = params;
  const contextWindowTokens =
    typeof params.contextWindowTokensOverride === "number" &&
    Number.isFinite(params.contextWindowTokensOverride) &&
    params.contextWindowTokensOverride > 0
      ? params.contextWindowTokensOverride
      : ctx.model?.contextWindow;
  if (!contextWindowTokens || contextWindowTokens <= 0) {
    return messages;
  }

  const charWindow = contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE;
  if (charWindow <= 0) {
    return messages;
  }

  const cutoffIndex = findAssistantCutoffIndex(messages, settings.keepLastAssistants);
  if (cutoffIndex === null) {
    return messages;
  }

  // Bootstrap safety: never prune anything before the first user message. This protects initial
  // "identity" reads (SOUL.md, USER.md, etc.) which typically happen before the first inbound user
  // message exists in the session transcript.
  const firstUserIndex = findFirstUserIndex(messages);
  const pruneStartIndex = firstUserIndex === null ? messages.length : firstUserIndex;

  const isToolPrunable = params.isToolPrunable ?? makeToolPrunablePredicate(settings.tools);

  const totalCharsBefore = estimateContextChars(messages);
  let totalChars = totalCharsBefore;
  let ratio = totalChars / charWindow;
  if (ratio < settings.softTrimRatio) {
    return messages;
  }

  const prunableToolIndexes: number[] = [];
  let next: AgentMessage[] | null = null;

  for (let i = pruneStartIndex; i < cutoffIndex; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }
    if (!isToolPrunable(msg.toolName)) {
      continue;
    }
    prunableToolIndexes.push(i);

    const updated = softTrimToolResultMessage({
      msg: msg as unknown as ToolResultMessage,
      settings,
    });
    if (!updated) {
      continue;
    }

    const beforeChars = estimateMessageChars(msg);
    const afterChars = estimateMessageChars(updated as unknown as AgentMessage);
    totalChars += afterChars - beforeChars;
    if (!next) {
      next = messages.slice();
    }
    next[i] = updated as unknown as AgentMessage;
  }

  const outputAfterSoftTrim = next ?? messages;
  ratio = totalChars / charWindow;
  if (ratio < settings.hardClearRatio) {
    return outputAfterSoftTrim;
  }
  if (!settings.hardClear.enabled) {
    return outputAfterSoftTrim;
  }

  let prunableToolChars = 0;
  for (const i of prunableToolIndexes) {
    const msg = outputAfterSoftTrim[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }
    prunableToolChars += estimateMessageChars(msg);
  }
  if (prunableToolChars < settings.minPrunableToolChars) {
    return outputAfterSoftTrim;
  }

  for (const i of prunableToolIndexes) {
    if (ratio < settings.hardClearRatio) {
      break;
    }
    const msg = (next ?? messages)[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }

    const beforeChars = estimateMessageChars(msg);
    const cachedMarkers = extractCachedMediaMarkers(msg);
    const clearedContent: TextContent[] = [asText(settings.hardClear.placeholder)];
    if (cachedMarkers.length > 0) {
      clearedContent.push(...cachedMarkers);
    }
    const cleared: ToolResultMessage = {
      ...msg,
      content: clearedContent,
    };
    if (!next) {
      next = messages.slice();
    }
    next[i] = cleared as unknown as AgentMessage;
    const afterChars = estimateMessageChars(cleared as unknown as AgentMessage);
    totalChars += afterChars - beforeChars;
    ratio = totalChars / charWindow;
  }

  return next ?? messages;
}

/**
 * Like {@link pruneContextMessages}, but also collects metadata about pruned media blocks
 * so the caller can optionally cache them to disk.
 */
export function pruneContextMessagesWithMediaCollection(params: {
  messages: AgentMessage[];
  settings: EffectiveContextPruningSettings;
  ctx: Pick<ExtensionContext, "model">;
  isToolPrunable?: (toolName: string) => boolean;
  contextWindowTokensOverride?: number;
}): { messages: AgentMessage[]; prunedMedia: PrunedMediaRef[] } {
  const { messages, settings, ctx } = params;
  const prunedMedia: PrunedMediaRef[] = [];

  const contextWindowTokens =
    typeof params.contextWindowTokensOverride === "number" &&
    Number.isFinite(params.contextWindowTokensOverride) &&
    params.contextWindowTokensOverride > 0
      ? params.contextWindowTokensOverride
      : ctx.model?.contextWindow;
  if (!contextWindowTokens || contextWindowTokens <= 0) {
    return { messages, prunedMedia };
  }

  const charWindow = contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE;
  if (charWindow <= 0) {
    return { messages, prunedMedia };
  }

  const cutoffIndex = findAssistantCutoffIndex(messages, settings.keepLastAssistants);
  if (cutoffIndex === null) {
    return { messages, prunedMedia };
  }

  const firstUserIndex = findFirstUserIndex(messages);
  const pruneStartIndex = firstUserIndex === null ? messages.length : firstUserIndex;

  const isToolPrunable = params.isToolPrunable ?? makeToolPrunablePredicate(settings.tools);

  const totalCharsBefore = estimateContextChars(messages);
  let totalChars = totalCharsBefore;
  let ratio = totalChars / charWindow;
  if (ratio < settings.softTrimRatio) {
    return { messages, prunedMedia };
  }

  const prunableToolIndexes: number[] = [];
  let next: AgentMessage[] | null = null;

  // Track which message indexes already had their media collected during soft-trim
  const softTrimmedIndexes = new Set<number>();

  for (let i = pruneStartIndex; i < cutoffIndex; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }
    if (!isToolPrunable(msg.toolName)) {
      continue;
    }
    prunableToolIndexes.push(i);

    const updated = softTrimToolResultMessage({
      msg: msg as unknown as ToolResultMessage,
      settings,
      onMedia: (block) => {
        prunedMedia.push({
          messageIndex: i,
          data: block.data,
          mimeType: block.mimeType,
        });
        softTrimmedIndexes.add(i);
      },
    });
    if (!updated) {
      continue;
    }

    const beforeChars = estimateMessageChars(msg);
    const afterChars = estimateMessageChars(updated as unknown as AgentMessage);
    totalChars += afterChars - beforeChars;
    if (!next) {
      next = messages.slice();
    }
    next[i] = updated as unknown as AgentMessage;
  }

  const outputAfterSoftTrim = next ?? messages;
  ratio = totalChars / charWindow;
  if (ratio < settings.hardClearRatio) {
    return { messages: outputAfterSoftTrim, prunedMedia };
  }
  if (!settings.hardClear.enabled) {
    return { messages: outputAfterSoftTrim, prunedMedia };
  }

  let prunableToolChars = 0;
  for (const i of prunableToolIndexes) {
    const msg = outputAfterSoftTrim[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }
    prunableToolChars += estimateMessageChars(msg);
  }
  if (prunableToolChars < settings.minPrunableToolChars) {
    return { messages: outputAfterSoftTrim, prunedMedia };
  }

  for (const i of prunableToolIndexes) {
    if (ratio < settings.hardClearRatio) {
      break;
    }
    const msg = (next ?? messages)[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }

    // Collect any remaining media blocks from the original message if they weren't
    // already collected during soft-trim. Insert PRUNED_CONTEXT_IMAGE_MARKER into
    // the cleared content so writePrunedMediaCaches can replace them with
    // [media cached:] markers later.
    const hardClearMediaMarkers: TextContent[] = [];
    if (!softTrimmedIndexes.has(i)) {
      const originalMsg = messages[i];
      if (originalMsg?.role === "toolResult") {
        for (const block of (originalMsg as unknown as ToolResultMessage).content) {
          if (block.type === "image") {
            prunedMedia.push({
              messageIndex: i,
              data: block.data,
              mimeType: block.mimeType,
            });
            hardClearMediaMarkers.push(asText(PRUNED_CONTEXT_IMAGE_MARKER));
          }
        }
      }
    } else {
      // Re-emit marker slots for soft-trimmed messages so they survive hard-clear.
      // The soft-trim path already collected media refs; we just need to preserve
      // the PRUNED_CONTEXT_IMAGE_MARKER placeholders that writePrunedMediaCaches
      // will replace with [media cached:] markers.
      const softTrimmedMsg = (next ?? messages)[i];
      if (softTrimmedMsg?.role === "toolResult") {
        for (const block of (softTrimmedMsg as unknown as ToolResultMessage).content) {
          if ("text" in block && typeof block.text === "string") {
            let remaining = block.text;
            while (remaining.includes(PRUNED_CONTEXT_IMAGE_MARKER)) {
              hardClearMediaMarkers.push(asText(PRUNED_CONTEXT_IMAGE_MARKER));
              remaining = remaining.replace(PRUNED_CONTEXT_IMAGE_MARKER, "");
            }
          }
        }
      }
    }

    const beforeChars = estimateMessageChars(msg);
    const cachedMarkers = extractCachedMediaMarkers(msg);
    const clearedContent: TextContent[] = [asText(settings.hardClear.placeholder)];
    if (cachedMarkers.length > 0) {
      clearedContent.push(...cachedMarkers);
    }
    if (hardClearMediaMarkers.length > 0) {
      clearedContent.push(...hardClearMediaMarkers);
    }
    const cleared: ToolResultMessage = {
      ...msg,
      content: clearedContent,
    };
    if (!next) {
      next = messages.slice();
    }
    next[i] = cleared as unknown as AgentMessage;
    const afterChars = estimateMessageChars(cleared as unknown as AgentMessage);
    totalChars += afterChars - beforeChars;
    ratio = totalChars / charWindow;
  }

  return { messages: next ?? messages, prunedMedia };
}
