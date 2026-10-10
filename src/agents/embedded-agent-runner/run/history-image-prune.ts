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
import { readModelPromptProjection } from "../../../sessions/user-turn-transcript.message.js";
import { collectTextContentBlocks } from "../../content-blocks.js";
import type { AgentMessage } from "../../runtime/index.js";
import { sanitizeImageBlocks } from "../../tool-images.js";
import {
  hasNonBlankUserText,
  resolveUserTranscriptMessages,
  type UserTranscriptContext,
} from "./attempt-history.js";
import { buildPromptImageFailureNotice, hydratePromptMediaMessages } from "./images.js";
import {
  appendExtractedPromptImages,
  collectPreparedDocumentImageFactIndexes,
  readPersistedImageBlockFactIndexes,
} from "./prompt-image-metadata.js";

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

// Start cleanup after three completed turns; subsequent cuts retire eight turns at once.
// Derive the boundary from canonical history so replay after a restart keeps the same bytes.
const PRESERVE_RECENT_COMPLETED_TURNS = 3;
const PRUNE_TURN_BATCH = 8;
function resolvePruneBeforeIndex(messages: AgentMessage[]): number {
  const completedTurns: number[] = [];
  let turnStart = -1;
  let hasAssistantReply = false;
  for (const [index, message] of messages.entries()) {
    if (message.role === "user") {
      // Only a later user closes a turn; an active tool loop never advances the boundary.
      if (turnStart >= 0 && hasAssistantReply) {
        completedTurns.push(turnStart);
      }
      turnStart = index;
      hasAssistantReply = false;
    } else if (message.role === "toolResult" && turnStart < 0) {
      turnStart = index;
    } else if (message.role === "assistant" && turnStart >= 0) {
      hasAssistantReply = true;
    }
  }
  const eligible = completedTurns.length - PRESERVE_RECENT_COMPLETED_TURNS;
  const pruneCount = 1 + Math.floor((eligible - 1) / PRUNE_TURN_BATCH) * PRUNE_TURN_BATCH;
  return eligible > 0 ? completedTurns[pruneCount]! : -1;
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
    const structuredMediaWasPruned =
      asNonArrayRecord(Reflect.get(message, "__openclaw")).mediaImagePruned === true;
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
      let nextBlock = block;
      if (block?.type === "text" && typeof block.text === "string") {
        const text = pruneText(block.text);
        nextBlock = text === block.text ? block : { ...block, text };
      } else if (block?.type === "image") {
        prunedImageBlock = true;
        nextBlock = { type: "text", text: PRUNED_HISTORY_IMAGE_MARKER };
      }
      if (nextBlock !== undefined && nextBlock !== block) {
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

function readReplayText(content: unknown): string {
  return typeof content === "string" ? content : collectTextContentBlocks(content).join("\n\n");
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
  onPruned?: (messages: ReadonlyMap<number, AgentMessage>) => void,
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
    const pruned = new Map<number, AgentMessage>();
    const prune = (source: AgentMessage[]) => {
      const projected = pruneProcessedHistoryImages(source);
      projected?.forEach((message, index) => {
        const original = source[index];
        if (original && message !== original) {
          pruned.set(index, original);
        }
      });
      return projected ?? source;
    };
    const prunedInput = prune(messages);
    let documentInput = prunedInput;
    const retainedDocumentKeys = new Set<string>();
    if (mediaOptions) {
      const config = mediaOptions.config ?? {};
      const maxChars = resolveFileExtractionLimits(config).maxChars;
      for (const [index, message] of prunedInput.entries()) {
        if (message.role !== "user") {
          continue;
        }
        const liveTranscript = liveTranscripts?.[index];
        const textAlreadyPrepared =
          (readModelPromptProjection(liveTranscript) ?? readModelPromptProjection(message)) !==
            undefined ||
          (liveTranscript?.role === "user" &&
            readReplayText(message.content) !== readReplayText(liveTranscript.content));
        const media =
          readRuntimePromptMediaFacts(message) ?? readPersistedMediaFacts(message) ?? [];
        if (!media.length) {
          continue;
        }
        // A suppressed retry can be paired with a canonical row without page bytes.
        // Only actual images with producer-owned source indexes permit skipping reads.
        const preparedPages = collectPreparedDocumentImageFactIndexes(
          media,
          Array.isArray(message.content)
            ? message.content.filter((block) => block.type === "image")
            : [],
          readPersistedImageBlockFactIndexes(message),
        );
        const key = JSON.stringify([
          message.timestamp,
          media,
          textAlreadyPrepared,
          [...preparedPages],
        ]);
        retainedDocumentKeys.add(key);
        let files = documents.get(key);
        if (!files) {
          files = await prepareFileContextFromMedia({
            media,
            config,
            workspaceDir: mediaOptions.workspaceDir,
            channelId: mediaOptions.channelId,
            accountId: mediaOptions.accountId,
            maxChars,
            totalMaxChars: maxChars,
            textAlreadyPrepared,
            skipAttachmentIndexes: preparedPages,
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
    const result = prune(transformed);
    onPruned?.(pruned);
    return result;
  };
  return () => {
    active = false;
    documents.clear();
    agent.transformContext = originalTransformContext;
  };
}
