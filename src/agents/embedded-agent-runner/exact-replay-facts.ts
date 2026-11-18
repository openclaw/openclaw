import { isDeepStrictEqual } from "node:util";
import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import { parseDateFirstTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { estimateCompactionChars } from "../../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import {
  formatCompactionUserLabel,
  projectCompactionContentBlock,
  stringifyCompactionValue,
} from "../../../packages/agent-core/src/harness/compaction/utils.js";
import type { ToolPairingMessageFact } from "../../../packages/agent-core/src/harness/session/tool-pairing-facts.js";
import { collectToolPairingMessageFact } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { readOpenAIResponsesItemRecoveryAnchor } from "../../../packages/ai/src/transports/openai-responses-compaction-replay.js";
import {
  replaceCompactionReplayOwnerContent,
  createCompactionReplayWindowFactCollector,
  type CompactionReplayWindowFact,
} from "../../../packages/ai/src/transports/provider-compaction-replay.js";
import { hasPersistedMedia } from "../../sessions/user-turn-media.js";
import { readModelPromptProjection } from "../../sessions/user-turn-transcript.message.js";
import {
  assistantSilenceOverride,
  collectAssistantSilenceBlockFact,
  normalizeAssistantPhase,
  type AssistantPhase,
  type AssistantSilenceBlockFact,
} from "../../shared/chat-message-content.js";
import {
  collectMeaningfulConversationBlock,
  collectRealConversationMessageFact,
  hasMeaningfulConversationText,
  type RealConversationMessageFact,
} from "../compaction-real-conversation.js";
import { prepareAssistantReplayImageContent } from "../embedded-agent-helpers/images.js";
import { hasOpenAIReasoningSignature } from "../embedded-agent-helpers/openai.js";
import { annotateInterSessionUserMessages } from "../replay-provenance.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  collectReplayToolBlockFacts,
  collectReplayToolResultFacts,
  type ReplayToolBlockFacts,
  type ReplayToolResultFacts,
} from "../tool-call-shared.js";
import { sanitizeContentBlocksImages } from "../tool-images.js";
import { normalizeUserMessageContent } from "./compaction-duplicate-user-messages.js";
import {
  isBareDeliveryMirrorCandidate,
  normalizeReplayMessage,
} from "./replay-history-sanitization.js";
import type { PreparedCompactionReplayOptions } from "./replay-history.types.js";
import {
  collectReplayTextFingerprint,
  replayComparisonFingerprint,
  type ReplayTextFingerprint,
} from "./replay-text-facts.js";
import { hasReplayableThinkingSignature } from "./thinking-replay.js";

export const SESSION_PRELUDE = Symbol.for("openclaw.sessionHistoryPrelude");

type BlockLocator<S> = { source: S; index: number; projection?: true };
export type ReplayBlockFact<S> = {
  locator?: BlockLocator<S>;
  /** Generated omission/bootstrap text, never copied source text. */
  literal?: string;
  present: boolean;
  nullish: boolean;
  hasTextSignature: boolean;
  type?: string;
  tool: ReplayToolBlockFacts;
  result: ReplayToolResultFacts;
  resultName?: string;
  thinkingSignature: boolean;
  imageThinkingSignature: boolean;
  imageKeep: boolean;
  imageChanged: boolean;
  imagePolicies?: { keep: number; changed: number; signature: number };
  mediaUnchanged?: boolean;
  staleOpenAIReasoning: boolean;
  silence: AssistantSilenceBlockFact;
  meaningful: boolean;
  assistantChars?: number;
  contentChars?: number;
  hasContentText: boolean;
  omission?: string;
  duplicateInvalid: boolean;
  duplicateText?: ReplayTextFingerprint;
  equality: string;
  rawIndex: number;
};

export type ReplayMessageFact<S> = {
  source?: S;
  role: AgentMessage["role"];
  content?: ReplayBlockFact<S>[];
  stringContent?: ReplayBlockFact<S>;
  sourceContentWasString: boolean;
  stopReason?: string;
  timestamp?: number;
  timestampMissing: boolean;
  parsedTimestamp?: number;
  excluded: boolean;
  persistedMedia: boolean;
  userLabelChars: number;
  senderId: string;
  silenceOverride?: boolean;
  phase?: AssistantPhase;
  fixedReal?: RealConversationMessageFact;
  fixedChars?: number;
  mirrorCandidate: boolean;
  recoveryAnchor: boolean;
  checkpoint?: CompactionReplayWindowFact;
  hasProviderReplay: boolean;
  result: ReplayToolResultFacts;
  resultName?: string;
  syntheticResult: boolean;
  projectedText?: ReplayBlockFact<S>;
  prelude: boolean;
  [SESSION_PRELUDE]?: boolean;
};

/** One fact for each exact context projection; native payload callbacks remain synchronous. */
export type ExactReplaySourceFact<S> = {
  source: S;
  role: AgentMessage["role"];
  rawPairing?: ToolPairingMessageFact;
  normalized: ReplayMessageFact<S> | null;
  recovery: ReplayMessageFact<S> | null;
  deferredCheckpoint?: true;
};

export type ExactReplayEqualityRequest<S> = {
  kind: "mirror" | "duplicate-user";
  left: ReplayMessageFact<S>;
  right: ReplayMessageFact<S>;
};
export type ExactReplayReaders<S> = {
  readMedia(
    source: S,
    indexes: readonly number[],
  ): Promise<ReadonlyMap<number, ReplayBlockFact<S>>>;
  compareRows(request: ExactReplayEqualityRequest<S>): Promise<boolean>;
};
export type ExactReplayContext = {
  latestModelSwitchTimestamp?: number | null;
  builtinGoogleReplay: boolean;
  googleMarkerPresent: boolean;
};

function collectBlock<S>(
  value: unknown,
  message: AgentMessage,
  locator?: BlockLocator<S>,
  rawIndex = -1,
  options?: PreparedCompactionReplayOptions,
): ReplayBlockFact<S> {
  const record = asOptionalRecord(value);
  const type = typeof record?.type === "string" ? record.type : undefined;
  let assistantChars: number | undefined = 0;
  let contentChars: number | undefined;
  let hasContentText = false;
  let omission: string | undefined;
  try {
    if (value == null) {
      throw new Error("invalid content block");
    }
    if (type === "text") {
      assistantChars = estimateStringChars(record?.text as string);
    } else if (type === "thinking") {
      assistantChars = estimateStringChars(record?.thinking as string);
    } else if (type === "toolCall") {
      assistantChars =
        estimateStringChars(record?.name as string) +
        estimateStringChars(stringifyCompactionValue(record?.arguments));
    }
  } catch {
    assistantChars = undefined;
  }
  try {
    const projection = projectCompactionContentBlock(
      value as { type: string; content?: unknown; text?: string },
    );
    hasContentText = Boolean(projection.text);
    contentChars = estimateStringChars(hasContentText ? [projection.text].join("") : "");
    omission = projection.omission;
  } catch {
    contentChars = undefined;
  }
  const signature = (block: unknown) =>
    hasReplayableThinkingSignature(block as Parameters<typeof hasReplayableThinkingSignature>[0]);
  const prepareImage = (policy: number) =>
    prepareAssistantReplayImageContent([value], policy === 4, {
      sanitizeThoughtSignatures: {
        allowBase64Only: Boolean(policy & 1),
        includeCamelCase: Boolean(policy & 2),
      },
    });
  const policyIndex = options?.policy.preserveSignatures
    ? 4
    : (options?.policy.sanitizeThoughtSignatures?.allowBase64Only ? 1 : 0) |
      (options?.policy.sanitizeThoughtSignatures?.includeCamelCase ? 2 : 0);
  const preparedContent = message.role === "assistant" ? prepareImage(policyIndex) : [value];
  const prepared = preparedContent[0];
  let imagePolicies: ReplayBlockFact<S>["imagePolicies"];
  if (!options && message.role === "assistant") {
    imagePolicies = { keep: 0, changed: 0, signature: 0 };
    for (let policy = 0; policy < 5; policy++) {
      const content = prepareImage(policy);
      if (content.length) {
        imagePolicies.keep |= 1 << policy;
      }
      if (content[0] !== value) {
        imagePolicies.changed |= 1 << policy;
      }
      if (signature(content[0])) {
        imagePolicies.signature |= 1 << policy;
      }
    }
  }
  return {
    locator,
    present: Boolean(value),
    nullish: value == null,
    hasTextSignature: record?.textSignature !== undefined,
    type,
    tool: collectReplayToolBlockFacts({ role: message.role, stopReason: "toolUse" }, value),
    result: record ? collectReplayToolResultFacts(record) : { ids: {} },
    resultName: normalizeOptionalString(record?.toolName) ?? normalizeOptionalString(record?.name),
    thinkingSignature: signature(value),
    imageThinkingSignature: signature(prepared),
    imageKeep: (preparedContent?.length ?? 0) > 0,
    imageChanged: prepared !== value,
    imagePolicies,
    staleOpenAIReasoning:
      type === "thinking" && hasOpenAIReasoningSignature(record?.thinkingSignature),
    silence: collectAssistantSilenceBlockFact(value),
    meaningful: collectMeaningfulConversationBlock(value),
    assistantChars,
    contentChars,
    hasContentText,
    omission,
    duplicateInvalid: !record || type === "image",
    duplicateText:
      type === "text" && typeof record?.text === "string"
        ? collectReplayTextFingerprint(record.text)
        : undefined,
    equality: replayComparisonFingerprint(value),
    rawIndex,
  };
}

export function literalBlock<S>(text: string): ReplayBlockFact<S> {
  // The literal is a generated replay marker, not a replacement transcript row.
  const block = { type: "text", text };
  const chars = estimateStringChars(text);
  return {
    literal: text,
    present: true,
    nullish: false,
    hasTextSignature: false,
    type: "text",
    tool: {
      toolCall: false,
      idToolCall: false,
      thinking: false,
      hasInput: false,
      hasIds: false,
      hasPartialJson: false,
      finalizedOpenAIResponses: false,
      hasInputAttachments: false,
    },
    result: { ids: {} },
    thinkingSignature: false,
    imageThinkingSignature: false,
    imageKeep: text.trim().length > 0,
    imageChanged: false,
    staleOpenAIReasoning: false,
    silence: collectAssistantSilenceBlockFact(block),
    meaningful: hasMeaningfulConversationText(text),
    assistantChars: chars,
    contentChars: chars,
    hasContentText: Boolean(text),
    duplicateInvalid: false,
    duplicateText: collectReplayTextFingerprint(text),
    equality: replayComparisonFingerprint(block),
    rawIndex: -1,
  };
}

function collectMessage<S>(
  message: AgentMessage,
  source: S,
  original: AgentMessage,
  options?: PreparedCompactionReplayOptions,
): ReplayMessageFact<S> {
  const record = asOptionalRecord(message)!;
  const originalContent =
    "content" in original && Array.isArray(original.content) ? original.content : [];
  const content =
    "content" in message && Array.isArray(message.content)
      ? message.content.map((block, index) =>
          collectBlock(
            block,
            message,
            { source, index },
            originalContent.indexOf(block as never),
            options,
          ),
        )
      : undefined;
  const rawString = typeof record.content === "string" ? record.content : undefined;
  const stringContent =
    rawString !== undefined
      ? collectBlock({ type: "text", text: rawString }, message, { source, index: -1 }, -1, options)
      : undefined;
  let projectedText: ReplayBlockFact<S> | undefined;
  if (message.role === "user") {
    try {
      const text = readModelPromptProjection(message);
      if (text !== undefined) {
        projectedText = collectBlock(
          { type: "text", text },
          message,
          { source, index: -1, projection: true },
          -1,
          options,
        );
      }
    } catch {
      /* Historical invalid projections fall back to their source content. */
    }
  }
  const rawPairing = collectToolPairingMessageFact(message);
  let fixedChars: number | undefined;
  if (message.role !== "assistant" && message.role !== "user" && message.role !== "toolResult") {
    try {
      fixedChars = estimateCompactionChars(message);
    } catch {
      /* Matches undefined token metrics. */
    }
  }
  return {
    source,
    role: message.role,
    content,
    stringContent,
    sourceContentWasString: typeof (original as { content?: unknown }).content === "string",
    stopReason: typeof record.stopReason === "string" ? record.stopReason : undefined,
    timestamp: typeof record.timestamp === "number" ? record.timestamp : undefined,
    timestampMissing: record.timestamp == null,
    parsedTimestamp: parseDateFirstTimestampMs(record.timestamp),
    excluded: record.excludeFromContext === true,
    persistedMedia: hasPersistedMedia(message),
    userLabelChars:
      message.role === "user" ? estimateStringChars(formatCompactionUserLabel(message)) - 4 : 0,
    senderId:
      typeof asOptionalRecord(record["__openclaw"])?.senderId === "string"
        ? (asOptionalRecord(record["__openclaw"])!.senderId as string)
        : "",
    silenceOverride: assistantSilenceOverride(message),
    phase: normalizeAssistantPhase(record.phase),
    fixedReal:
      message.role !== "assistant" && message.role !== "user" && message.role !== "toolResult"
        ? collectRealConversationMessageFact(message)
        : undefined,
    fixedChars,
    mirrorCandidate: message.role === "assistant" && isBareDeliveryMirrorCandidate(message),
    checkpoint: options
      ? createCompactionReplayWindowFactCollector(options.model, {
          sessionId: options.sessionId,
          enabled: options.replayEnabled,
        })(message)
      : undefined,
    hasProviderReplay: Boolean(record.providerReplay),
    recoveryAnchor:
      message.role === "assistant" &&
      readOpenAIResponsesItemRecoveryAnchor(message.providerReplay) !== undefined,
    result: collectReplayToolResultFacts(message),
    resultName: normalizeOptionalString(record.toolName) ?? normalizeOptionalString(record.name),
    syntheticResult: rawPairing?.role === "toolResult" && rawPairing.synthetic,
    projectedText,
    prelude: Boolean(Reflect.get(message, Symbol.for("openclaw.sessionHistoryPrelude"))),
  };
}

export function collectExactReplaySourceFact<S>(
  message: AgentMessage,
  source: S,
  options?: PreparedCompactionReplayOptions,
): ExactReplaySourceFact<S> {
  const annotated = annotateInterSessionUserMessages([message])[0]!;
  const normalized = normalizeReplayMessage(annotated);
  const recovery =
    message.role === "assistant" &&
    readOpenAIResponsesItemRecoveryAnchor(message.providerReplay) !== undefined
      ? collectMessage(replaceCompactionReplayOwnerContent(message, []), source, message, options)
      : null;
  return {
    source,
    role: message.role,
    rawPairing: collectToolPairingMessageFact(annotated),
    normalized: normalized ? collectMessage(normalized, source, annotated, options) : null,
    recovery,
    ...(!options && message.role === "assistant" && message.providerReplay
      ? { deferredCheckpoint: true as const }
      : {}),
  };
}

/** Select scalar policy outcomes after Gateway preflight has resolved the actual model. */
export function resolveExactReplaySourcePolicy<S>(
  source: ExactReplaySourceFact<S>,
  options: PreparedCompactionReplayOptions,
): ExactReplaySourceFact<S> {
  const policy = options.policy.preserveSignatures
    ? 4
    : (options.policy.sanitizeThoughtSignatures?.allowBase64Only ? 1 : 0) |
      (options.policy.sanitizeThoughtSignatures?.includeCamelCase ? 2 : 0);
  const block = (fact: ReplayBlockFact<S>): ReplayBlockFact<S> => {
    const masks = fact.imagePolicies;
    return masks
      ? {
          ...fact,
          imagePolicies: undefined,
          imageKeep: Boolean(masks.keep & (1 << policy)),
          imageChanged: Boolean(masks.changed & (1 << policy)),
          imageThinkingSignature: Boolean(masks.signature & (1 << policy)),
        }
      : fact;
  };
  const message = (fact: ReplayMessageFact<S> | null): ReplayMessageFact<S> | null =>
    fact
      ? {
          ...fact,
          content: fact.content?.map(block),
          stringContent: fact.stringContent && block(fact.stringContent),
          projectedText: fact.projectedText && block(fact.projectedText),
        }
      : null;
  return { ...source, normalized: message(source.normalized), recovery: message(source.recovery) };
}

/** Selected media rows are sanitized after the native snapshot has closed. */
export async function collectExactReplayMediaFacts<S>(
  message: AgentMessage,
  source: S,
  indexes: readonly number[],
  options: PreparedCompactionReplayOptions,
): Promise<ReadonlyMap<number, ReplayBlockFact<S>>> {
  const normalized = normalizeReplayMessage(annotateInterSessionUserMessages([message])[0]!);
  const content =
    normalized && "content" in normalized && Array.isArray(normalized.content)
      ? normalized.content
      : [];
  const result = new Map<number, ReplayBlockFact<S>>();
  for (const index of indexes) {
    const block = content[index];
    if (!normalized || block?.type !== "image") {
      throw new Error("Replay media selection changed");
    }
    const prepared =
      normalized.role === "assistant"
        ? prepareAssistantReplayImageContent(
            [block],
            options.policy.preserveSignatures || normalized.stopReason === "error",
            { ...options.policy, ...options.imageLimits },
          )
        : [block];
    const sanitized = await sanitizeContentBlocksImages(prepared, "session:history", {
      ...options.imageLimits,
      verifyDecodability: true,
    });
    const next = sanitized[0]!;
    const fact = collectBlock(next, normalized, { source, index }, -1, options);
    fact.mediaUnchanged = next === block;
    if (next.type === "text") {
      fact.literal = next.text;
      fact.locator = undefined;
    }
    result.set(index, fact);
  }
  return result;
}

/** Bounded comparison adapter: one decoded source row per side, never a history array. */
export async function compareExactReplayRows<S>(
  request: ExactReplayEqualityRequest<S>,
  readSource: (source: S) => Promise<AgentMessage>,
): Promise<boolean> {
  async function* blocks(message: ReplayMessageFact<S>): AsyncGenerator {
    let previousSource: S | undefined;
    let previousMessage: AgentMessage | null | undefined;
    for (const block of message.content ?? (message.stringContent ? [message.stringContent] : [])) {
      if (block.literal !== undefined) {
        yield { type: "text", text: block.literal };
        continue;
      }
      if (!block.locator) {
        throw new Error("Replay equality lost its source locator");
      }
      const { source, index, projection } = block.locator;
      if (previousMessage === undefined || previousSource !== source) {
        previousMessage = normalizeReplayMessage(
          annotateInterSessionUserMessages([await readSource(source)])[0]!,
        );
        previousSource = source;
      }
      if (!previousMessage) {
        throw new Error("Replay equality source projection changed");
      }
      if (projection) {
        const text = readModelPromptProjection(previousMessage);
        if (text === undefined) {
          throw new Error("Replay user projection changed");
        }
        yield { type: "text", text };
      } else if (index === -1) {
        const text = "content" in previousMessage ? previousMessage.content : undefined;
        if (typeof text !== "string") {
          throw new Error("Replay string content changed");
        }
        yield { type: "text", text };
      } else {
        const content =
          "content" in previousMessage && Array.isArray(previousMessage.content)
            ? previousMessage.content
            : [];
        yield content[index];
      }
    }
  }
  if (request.kind === "mirror") {
    const left: unknown[] = [];
    const right: unknown[] = [];
    for await (const block of blocks(request.left)) {
      left.push(block);
    }
    for await (const block of blocks(request.right)) {
      right.push(block);
    }
    return isDeepStrictEqual(left, right);
  }
  if (request.left.senderId !== request.right.senderId) {
    return false;
  }
  async function* normalizedText(message: ReplayMessageFact<S>) {
    let first = true;
    for await (const block of blocks(message)) {
      const record = asOptionalRecord(block);
      if (record?.type !== "text" || typeof record.text !== "string") {
        continue;
      }
      const part = normalizeUserMessageContent(record.text)!.normalize("NFC");
      if (!part) {
        continue;
      }
      if (!first) {
        yield " ";
      }
      yield part;
      first = false;
    }
  }
  const left = normalizedText(request.left);
  const right = normalizedText(request.right);
  let l = await left.next();
  let r = await right.next();
  let li = 0;
  let ri = 0;
  while (!l.done && !r.done) {
    const length = Math.min(l.value.length - li, r.value.length - ri);
    if (l.value.slice(li, li + length) !== r.value.slice(ri, ri + length)) {
      await left.return();
      await right.return();
      return false;
    }
    li += length;
    ri += length;
    if (li === l.value.length) {
      l = await left.next();
      li = 0;
    }
    if (ri === r.value.length) {
      r = await right.next();
      ri = 0;
    }
  }
  return Boolean(l.done && r.done);
}
