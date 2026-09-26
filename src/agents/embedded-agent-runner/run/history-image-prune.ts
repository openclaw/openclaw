import path from "node:path";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { buildInboundMediaNoteProjection } from "../../../auto-reply/media-note.js";
import {
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
import { hasNonBlankUserText } from "./attempt-history.js";
import { hydratePromptMediaMessages } from "./images.js";

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

// A single long agentic turn can accumulate dozens of tool rounds without a
// new user message ever closing it, so the completed-turn window above never
// evicts that turn's images and they replay on every model call (#140651
// froze the cutoff during tool loops to keep the warm prompt-cache prefix
// byte-stable). These thresholds add bounded intra-turn eviction while
// preserving that stability: the cutoff is a pure function of an append-only
// prefix and advances only at coarse round boundaries, so each advance
// rewrites the cached prefix once and the pruned view then stays byte-stable
// for the next INTRA_TURN_PRUNE_ROUND_STEP rounds. Tunable, but advances
// must stay rare relative to round frequency.
const INTRA_TURN_PRUNE_MIN_ROUNDS = 6;
const INTRA_TURN_KEEP_RECENT_ROUNDS = 4;
const INTRA_TURN_PRUNE_ROUND_STEP = 20;

/**
 * Cutoff index covering a turn's oldest completed tool rounds, or -1 while
 * the turn is below the eviction threshold. Monotone in `roundStarts` length:
 * recorded rounds never move, so a later scan of a longer prefix can only
 * keep or advance the cutoff, never retreat it.
 */
function resolveIntraTurnPruneCutoff(roundStarts: number[]): number {
  if (roundStarts.length < INTRA_TURN_PRUNE_MIN_ROUNDS) {
    return -1;
  }
  const evictedRounds =
    INTRA_TURN_PRUNE_MIN_ROUNDS -
    INTRA_TURN_KEEP_RECENT_ROUNDS +
    INTRA_TURN_PRUNE_ROUND_STEP *
      Math.floor((roundStarts.length - INTRA_TURN_PRUNE_MIN_ROUNDS) / INTRA_TURN_PRUNE_ROUND_STEP);
  return roundStarts[evictedRounds] ?? -1;
}

/**
 * Scan state for one turn: a turn opens at a user message (or an orphan
 * toolResult) and closes at the next user message. `roundStarts` records the
 * first index of each maximal contiguous toolResult block, so parallel tool
 * calls appending several results count as one round.
 */
type TurnScanState = {
  start: number;
  hasAssistantReply: boolean;
  roundStarts: number[];
};

function resolvePruneBeforeIndex(messages: AgentMessage[]): number {
  const completedTurnStarts: number[] = [];
  let currentTurn: TurnScanState | undefined;
  let intraTurnCutoff = -1;

  for (let i = 0; i < messages.length; i++) {
    const role = messages[i]?.role;
    if (role === "user") {
      if (currentTurn && currentTurn.hasAssistantReply) {
        // The retained window and one older turn are enough to decide pruning.
        if (completedTurnStarts.length > PRESERVE_RECENT_COMPLETED_TURNS) {
          completedTurnStarts.shift();
        }
        completedTurnStarts.push(currentTurn.start);
      }
      // Closed turns never change, so folding their cutoff into a running max
      // keeps eviction monotone: a follow-up or steering user message cannot
      // resurrect images a long turn already evicted.
      if (currentTurn) {
        intraTurnCutoff = Math.max(
          intraTurnCutoff,
          resolveIntraTurnPruneCutoff(currentTurn.roundStarts),
        );
      }
      currentTurn = { start: i, hasAssistantReply: false, roundStarts: [] };
      continue;
    }
    if (role === "toolResult") {
      currentTurn ??= { start: i, hasAssistantReply: false, roundStarts: [] };
      if (messages[i - 1]?.role !== "toolResult") {
        currentTurn.roundStarts.push(i);
      }
      continue;
    }
    if (role === "assistant" && currentTurn) {
      currentTurn.hasAssistantReply = true;
    }
  }
  if (currentTurn) {
    intraTurnCutoff = Math.max(
      intraTurnCutoff,
      resolveIntraTurnPruneCutoff(currentTurn.roundStarts),
    );
  }

  // Only a later user message closes a turn; tool-loop replies must not move
  // the completed-turn cutoff and rewrite the warm prefix during the active
  // turn. The sole exception is the coarse intra-turn eviction above, whose
  // cutoff advances rarely and monotonically once a turn crosses
  // INTRA_TURN_PRUNE_MIN_ROUNDS. Past that point it can supersede the
  // PRESERVE_RECENT_COMPLETED_TURNS guarantee for older messages.
  const completedTurnCutoff =
    completedTurnStarts.length > PRESERVE_RECENT_COMPLETED_TURNS
      ? (completedTurnStarts.at(-PRESERVE_RECENT_COMPLETED_TURNS) ?? -1)
      : -1;
  return Math.max(completedTurnCutoff, intraTurnCutoff);
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
  mediaOptions?: Parameters<typeof hydratePromptMediaMessages>[1],
): () => void {
  const originalTransformContext = agent.transformContext;
  agent.transformContext = async (messages: AgentMessage[], signal?: AbortSignal) => {
    const prunedInput = pruneProcessedHistoryImages(messages) ?? messages;
    const hydratedInput = mediaOptions
      ? await hydratePromptMediaMessages(prunedInput, mediaOptions)
      : prunedInput;
    const transformed = originalTransformContext
      ? await originalTransformContext.call(agent, hydratedInput, signal)
      : hydratedInput;
    const sourceMessages = Array.isArray(transformed) ? transformed : hydratedInput;
    return pruneProcessedHistoryImages(sourceMessages) ?? sourceMessages;
  };
  return () => {
    agent.transformContext = originalTransformContext;
  };
}
