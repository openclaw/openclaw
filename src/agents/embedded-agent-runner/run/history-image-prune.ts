import path from "node:path";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { buildInboundMediaNoteProjection } from "../../../auto-reply/media-note.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { prepareFileContextFromMedia } from "../../../media-understanding/file-context.js";
import { resolveFileExtractionLimits } from "../../../media-understanding/file-extraction-limits.js";
import {
  attachRuntimePromptMediaFacts,
  readRuntimePromptImageOrder,
  readPersistedMediaFacts,
  readRuntimePromptMediaFacts,
  stripLegacyMediaContextFields,
  type MediaFact,
} from "../../../media/media-facts.js";
/**
 * Prunes already-processed image payloads from replayed prompt history.
 */
import { buildLateMediaAttachedProjection } from "../../../sessions/user-turn-transcript.js";
import type { AgentMessage } from "../../runtime/index.js";
import { sanitizeImageBlocks } from "../../tool-images.js";
import { getTranscriptPromptText } from "../tool-result-context-guard.js";
import {
  hasNonBlankUserText,
  readFirstUserText,
  resolveUserTranscriptMessages,
  type UserTranscriptContext,
} from "./attempt-history.js";
import { buildPromptImageFailureNotice, hydratePromptMediaMessages } from "./images.js";
import { appendExtractedPromptImages } from "./prompt-image-metadata.js";

/** Replacement text for old image blocks that were already available to the model. */
const PRUNED_HISTORY_IMAGE_MARKER = "[image data removed - already processed by model]";

/** Replacement text for fact-owned late-media projections already processed by the model. */
const PRUNED_HISTORY_MEDIA_REFERENCE_MARKER =
  "[media reference removed - already processed by model]";

// Legacy replay hygiene only: factless pre-MediaFact rows past the prune cutoff
// retain no attachment ownership. Fact-bearing messages never use these patterns.
const LEGACY_MEDIA_ATTACHED_PATTERN = /\[media attached(?:\s+\d+\/\d+)?:\s*[^\]]+\]/gi;
const LEGACY_IMAGE_SOURCE_PATTERN = /\[Image:\s*source:\s*[^\]]+\]/gi;
const LEGACY_INBOUND_MEDIA_URI_PATTERN = /\bmedia:\/\/inbound\/[^\]\s/\\]+/g;

type PrunableContextAgent = {
  transformContext?: (
    messages: AgentMessage[],
    signal?: AbortSignal,
  ) => AgentMessage[] | Promise<AgentMessage[]>;
};

/**
 * Number of most-recent completed turns whose preceding user/toolResult image
 * blocks are kept intact. Counts all completed turns, not just image-bearing
 * ones, so text-only turns consume the window.
 */
const PRESERVE_RECENT_COMPLETED_TURNS = 3;
function resolvePruneBeforeIndex(messages: AgentMessage[]): number {
  const completedTurnStarts: number[] = [];
  let currentTurnStart = -1;
  let currentTurnHasAssistantReply = false;

  for (let i = 0; i < messages.length; i++) {
    const role = messages[i]?.role;
    if (role === "user") {
      if (currentTurnStart >= 0 && currentTurnHasAssistantReply) {
        // The retained window and one older turn are enough to decide pruning.
        if (completedTurnStarts.length > PRESERVE_RECENT_COMPLETED_TURNS) {
          completedTurnStarts.shift();
        }
        completedTurnStarts.push(currentTurnStart);
      }
      currentTurnStart = i;
      currentTurnHasAssistantReply = false;
      continue;
    }
    if (role === "toolResult") {
      if (currentTurnStart < 0) {
        currentTurnStart = i;
      }
      continue;
    }
    if (role === "assistant" && currentTurnStart >= 0) {
      currentTurnHasAssistantReply = true;
    }
  }

  // Only a later user message closes a turn; tool-loop replies must not move
  // the cutoff and rewrite the warm prefix during the active turn.
  if (completedTurnStarts.length <= PRESERVE_RECENT_COMPLETED_TURNS) {
    return -1;
  }
  return completedTurnStarts.at(-PRESERVE_RECENT_COMPLETED_TURNS) ?? -1;
}

function wasStructurallyMediaPruned(message: AgentMessage): boolean {
  return asNonArrayRecord(Reflect.get(message, "__openclaw")).mediaImagePruned === true;
}

function replaceLegacyFactlessMediaText(text: string): string {
  return text
    .replace(LEGACY_MEDIA_ATTACHED_PATTERN, PRUNED_HISTORY_MEDIA_REFERENCE_MARKER)
    .replace(LEGACY_IMAGE_SOURCE_PATTERN, PRUNED_HISTORY_MEDIA_REFERENCE_MARKER)
    .replace(LEGACY_INBOUND_MEDIA_URI_PATTERN, PRUNED_HISTORY_MEDIA_REFERENCE_MARKER);
}

function normalizeMarkerIdentity(identity: string): string {
  return identity.replaceAll("\\", "/");
}

function resolveWorkspaceRelativeMarkerAliases(fact: MediaFact): string[] {
  if (
    !fact.path ||
    !fact.workspaceDir ||
    !path.isAbsolute(fact.path) ||
    !path.isAbsolute(fact.workspaceDir)
  ) {
    return [];
  }
  const relativePath = path.relative(fact.workspaceDir, fact.path);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return [];
  }
  const normalizedRelativePath = normalizeMarkerIdentity(relativePath);
  return [normalizedRelativePath, `./${normalizedRelativePath}`];
}

function factOwnsMarkerIdentity(identity: string, media: MediaFact[]): boolean {
  const normalizedIdentity = normalizeMarkerIdentity(identity);
  return media.some((fact) => {
    // Persistence anchors sandbox paths for browser previews, while existing
    // prompt marker text remains relative. Derive aliases only from an
    // explicitly recorded workspace so unrelated absolute facts stay distinct.
    const aliases = [fact.path, fact.url, ...resolveWorkspaceRelativeMarkerAliases(fact)];
    return aliases.some((alias) => alias && normalizeMarkerIdentity(alias) === normalizedIdentity);
  });
}

function extractMediaAttachedIdentity(marker: string): string {
  const content = marker.replace(/^\[media attached(?:\s+\d+\/\d+)?:\s*/i, "").slice(0, -1);
  const mimeIndex = content.lastIndexOf(" (");
  const urlIndex = content.indexOf(" | ");
  const endIndexes = [mimeIndex, urlIndex].filter((index) => index >= 0);
  const endIndex = endIndexes.length > 0 ? Math.min(...endIndexes) : content.length;
  return content.slice(0, endIndex).trim();
}

function replaceOwnedLegacyMediaMarkers(text: string, media: MediaFact[]): string {
  return text
    .replace(LEGACY_MEDIA_ATTACHED_PATTERN, (marker) =>
      factOwnsMarkerIdentity(extractMediaAttachedIdentity(marker), media)
        ? PRUNED_HISTORY_MEDIA_REFERENCE_MARKER
        : marker,
    )
    .replace(LEGACY_IMAGE_SOURCE_PATTERN, (marker) => {
      const identity = marker
        .replace(/^\[Image:\s*source:\s*/i, "")
        .slice(0, -1)
        .trim();
      return factOwnsMarkerIdentity(identity, media)
        ? PRUNED_HISTORY_MEDIA_REFERENCE_MARKER
        : marker;
    });
}

function replaceOwnedMediaProjection(text: string, media: MediaFact[]): string {
  if (media.length === 0) {
    return text;
  }
  const projectionLines = new Set<string>();
  for (const facts of [media, ...media.map((fact) => [fact])]) {
    const projection = buildInboundMediaNoteProjection({ media: facts }).text;
    for (const line of projection?.split("\n") ?? []) {
      if (line) {
        projectionLines.add(line);
      }
    }
  }
  let redacted = text;
  for (const line of projectionLines) {
    redacted = redacted.replaceAll(line, PRUNED_HISTORY_MEDIA_REFERENCE_MARKER);
  }
  for (const fact of media) {
    for (const alias of [fact.path, fact.url].filter((value): value is string => Boolean(value))) {
      redacted = redacted
        .replaceAll(`[Image: source: ${alias}]`, PRUNED_HISTORY_MEDIA_REFERENCE_MARKER)
        .replaceAll(`[media attached: ${alias}]`, PRUNED_HISTORY_MEDIA_REFERENCE_MARKER);
    }
  }
  return replaceOwnedLegacyMediaMarkers(redacted, media);
}

function cloneMessageWithContent(
  message: Extract<AgentMessage, { role: "user" | "toolResult" }>,
  content: typeof message.content,
  dropMedia = false,
  dropImageMetadata = dropMedia,
): AgentMessage {
  const clone = { ...message, content } as AgentMessage & Record<string, unknown>;
  if (dropMedia) {
    delete clone.media;
    stripLegacyMediaContextFields(clone);
  }
  if (dropImageMetadata) {
    const nextMeta = { ...asNonArrayRecord(clone["__openclaw"]) };
    delete nextMeta.mediaImageBlockFactIndexes;
    delete nextMeta.mediaImageLayout;
    if (dropMedia) {
      delete nextMeta.media;
      nextMeta.mediaImagePruned = true;
    }
    if (Object.keys(nextMeta).length > 0) {
      clone["__openclaw"] = nextMeta;
    } else {
      delete clone["__openclaw"];
    }
  }
  return clone;
}

/** Prunes old image payloads and references before later LLM-boundary synthesis. */
export function pruneProcessedHistoryImages(messages: AgentMessage[]): AgentMessage[] | null {
  const pruneBeforeIndex = resolvePruneBeforeIndex(messages);
  if (pruneBeforeIndex < 0) {
    return null;
  }

  let prunedMessages: AgentMessage[] | null = null;
  for (let i = 0; i < pruneBeforeIndex; i++) {
    const message = messages[i];
    if (!message || (message.role !== "user" && message.role !== "toolResult")) {
      continue;
    }
    const media =
      message.role === "user"
        ? (readRuntimePromptMediaFacts(message) ?? readPersistedMediaFacts(message) ?? [])
        : [];
    const hasOwnedMedia = media.length > 0;
    const structuredMediaWasPruned = wasStructurallyMediaPruned(message);
    const pruneText = (text: string) =>
      hasOwnedMedia
        ? replaceOwnedMediaProjection(text, media)
        : structuredMediaWasPruned
          ? text
          : replaceLegacyFactlessMediaText(text);

    // Materialize blank marked turns here so this earlier boundary still prunes stale paths.
    const lateMediaProjection =
      message.role === "user" && !hasNonBlankUserText(message.content)
        ? buildLateMediaAttachedProjection(message)
        : undefined;
    const lateMediaText = lateMediaProjection?.media
      .map(() => PRUNED_HISTORY_MEDIA_REFERENCE_MARKER)
      .join("\n");
    const content = lateMediaText
      ? Array.isArray(message.content)
        ? ([{ type: "text", text: lateMediaText }, ...message.content] as typeof message.content)
        : lateMediaText
      : message.content;

    if (typeof content === "string") {
      const nextText = pruneText(content);
      if (nextText !== message.content || hasOwnedMedia) {
        prunedMessages ??= messages.slice();
        prunedMessages[i] = cloneMessageWithContent(message, nextText, hasOwnedMedia);
      }
      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    // Metadata-only projections still own a fresh array for downstream transforms.
    const contentLength = content.length;
    let nextContent = hasOwnedMedia || lateMediaText ? content.slice(0, contentLength) : undefined;
    let prunedImageBlock = false;
    for (let index = 0; index < contentLength; index += 1) {
      if (!(index in content)) {
        continue;
      }
      const block = content[index];
      let nextBlock: (typeof content)[number] | undefined;
      if (block?.type === "text" && typeof block.text === "string") {
        const text = pruneText(block.text);
        if (text !== block.text) {
          nextBlock = { ...block, text };
        }
      } else if (block?.type === "image") {
        prunedImageBlock = true;
        nextBlock = { type: "text", text: PRUNED_HISTORY_IMAGE_MARKER };
      }
      if (nextBlock !== undefined) {
        nextContent ??= content.slice(0, contentLength);
        nextContent[index] = nextBlock;
      }
    }
    if (nextContent) {
      prunedMessages ??= messages.slice();
      prunedMessages[i] = cloneMessageWithContent(
        message,
        nextContent,
        hasOwnedMedia,
        hasOwnedMedia || prunedImageBlock,
      );
    }
  }

  return prunedMessages;
}

/** Installs an agent context transform that prunes old image/media history before model input. */
export function installHistoryImagePruneContextTransform(
  agent: PrunableContextAgent,
  mediaOptions?: Parameters<typeof hydratePromptMediaMessages>[1] & {
    config?: OpenClawConfig;
    channelId?: string;
    accountId?: string;
    assertCurrent?: () => void;
    getUserTranscriptContexts?: () => readonly UserTranscriptContext[] | undefined;
  },
): () => void {
  const originalTransformContext = agent.transformContext;
  // Attempt-owned projections keep randomized untrusted wrappers and file bytes
  // fixed during tool loops. Pruned messages never reach extraction; teardown
  // releases the cache rather than persisting enrichment in canonical history.
  const documents = new Map<string, Awaited<ReturnType<typeof prepareFileContextFromMedia>>>();
  let active = true;
  agent.transformContext = async (messages: AgentMessage[], signal?: AbortSignal) => {
    const assertCurrent = () => {
      signal?.throwIfAborted();
      mediaOptions?.assertCurrent?.();
      if (!active) {
        throw new Error("History media projection is no longer active");
      }
    };
    assertCurrent();
    const liveTranscripts = resolveUserTranscriptMessages(
      messages,
      mediaOptions?.getUserTranscriptContexts?.(),
      undefined,
    );
    const prunedInput = pruneProcessedHistoryImages(messages) ?? messages;
    let documentInput = prunedInput;
    const retainedDocumentKeys = new Set<string>();
    if (mediaOptions) {
      const config = mediaOptions.config ?? {};
      for (const [index, message] of prunedInput.entries()) {
        const liveTranscript = liveTranscripts?.[index];
        // Live prompt preparation already owns enrichment. Its structural marker
        // survives clones; never infer ownership from user-supplied file markup.
        if (
          message.role !== "user" ||
          getTranscriptPromptText(message) !== undefined ||
          (liveTranscript?.role === "user" &&
            readFirstUserText(message.content) !== readFirstUserText(liveTranscript.content))
        ) {
          continue;
        }
        const media =
          readRuntimePromptMediaFacts(message) ?? readPersistedMediaFacts(message) ?? [];
        if (!media.length) {
          continue;
        }
        const key = JSON.stringify([message.timestamp, media]);
        retainedDocumentKeys.add(key);
        let files = documents.get(key);
        if (!files) {
          files = await prepareFileContextFromMedia({
            media,
            config,
            workspaceDir: mediaOptions.workspaceDir,
            channelId: mediaOptions.channelId,
            accountId: mediaOptions.accountId,
            maxChars: resolveFileExtractionLimits(config).maxChars,
            assertCurrent,
          });
          assertCurrent();
          documents.set(key, files);
        }
        if (!files.text && !files.images.length) {
          continue;
        }
        const content = Array.isArray(message.content)
          ? message.content.slice()
          : [{ type: "text" as const, text: message.content }];
        if (files.text) {
          content.push({ type: "text", text: files.text });
        }
        let projected: Extract<AgentMessage, { role: "user" }> = { ...message, content };
        let extractedPageMedia: MediaFact[] | undefined;
        if (files.images.length) {
          if (mediaOptions.model.input?.includes("image")) {
            const pages = [];
            let dropped = 0;
            for (const page of files.images) {
              const sanitized = await sanitizeImageBlocks([page], "history:files", mediaOptions);
              assertCurrent();
              dropped += sanitized.dropped;
              pages.push(
                ...sanitized.images.map((image) => ({ image, factIndex: page.attachmentIndex })),
              );
            }
            if (dropped) {
              content.push({ type: "text", text: buildPromptImageFailureNotice(dropped) });
            }
            projected = appendExtractedPromptImages(projected, media, pages);
            extractedPageMedia = readPersistedMediaFacts(projected);
          } else {
            content.push({
              type: "text",
              text: "[Attachment images omitted: this model does not support image input]",
            });
          }
        }
        const runtimeMedia = readRuntimePromptMediaFacts(message);
        if (runtimeMedia) {
          attachRuntimePromptMediaFacts(
            projected,
            extractedPageMedia ?? runtimeMedia,
            readRuntimePromptImageOrder(message),
          );
        }
        if (documentInput === prunedInput) {
          documentInput = prunedInput.slice();
        }
        documentInput[index] = projected;
      }
    }
    for (const key of documents.keys()) {
      if (!retainedDocumentKeys.has(key)) {
        documents.delete(key);
      }
    }
    const hydratedInput = mediaOptions
      ? await hydratePromptMediaMessages(documentInput, { ...mediaOptions, signal })
      : prunedInput;
    assertCurrent();
    const transformed = originalTransformContext
      ? await originalTransformContext.call(agent, hydratedInput, signal)
      : hydratedInput;
    assertCurrent();
    const sourceMessages = Array.isArray(transformed) ? transformed : hydratedInput;
    return pruneProcessedHistoryImages(sourceMessages) ?? sourceMessages;
  };
  return () => {
    active = false;
    documents.clear();
    agent.transformContext = originalTransformContext;
  };
}
