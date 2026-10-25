import { existsSync } from "node:fs";
import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { iterateSessionContextEntries } from "../../../packages/agent-core/src/harness/session/session.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import type { AgentContextPruningConfig } from "../../config/types.agent-defaults.js";
import { createDedupeCache } from "../../infra/dedupe.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "../glob-pattern.js";
import type { AgentMessage } from "../runtime/index.js";
import type { SessionManager } from "../sessions/index.js";
import { formatFullOutputFooter } from "../sessions/tools/tool-contracts.js";
import {
  calculateMaxToolResultCharsWithCap,
  resolveAutoLiveToolResultMaxChars,
  resolveLiveToolResultMaxChars,
} from "../tool-result-limits.js";
import { readCacheTtlCheckpoint } from "./cache-ttl-checkpoint.js";
import * as truncationNotice from "./context-truncation-notice.js";
import { log } from "./logger.js";
import {
  recordToolResultPromptProjection,
  type ToolResultPromptProjectionState,
} from "./session-prompt-state.js";
import { dropThinkingBlocks } from "./thinking.js";
import {
  getToolResultProjectionBaseKey,
  getToolResultProjectionKeys,
  getToolResultTextBlocks,
  hashToolResultText,
  TOOL_RESULT_PROJECTION_KEY,
} from "./tool-result-projection-key.js";
import { projectToolResultMessage } from "./tool-result-projection-message.js";
import {
  estimateToolResultTextChars,
  isToolResultTextBlock,
  readPreparedToolResultTextChars,
  sliceToolResultTextTailToBudget,
  sliceToolResultTextToBudget,
} from "./tool-result-text-budget.js";
import { rewriteTranscriptEntriesInSessionManager } from "./transcript-rewrite.js";

export {
  DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
  resolveLiveToolResultMaxChars,
} from "../tool-result-limits.js";
const PROMPT_TOOL_RESULT_AGGREGATE_CAP_MULTIPLIER = 4;
const AGGREGATE_TOOL_RESULT_CONTEXT_SHARE = 0.5;
const CACHE_TTL_IMAGE_CHARS = 8_000;
const CACHE_TTL_IMAGE_MARKER = "[image removed during context pruning]";
const CACHE_TTL_DEFAULT_PLACEHOLDER = "[Old tool result content cleared]";

type CacheTtlPruningSettings = {
  ttlMs: number;
  hardClear: boolean;
  placeholder: string;
  isToolPrunable: (toolName: string) => boolean;
};
type CacheTtlToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

export function resolveCacheTtlPruningSettings(
  config: AgentContextPruningConfig | undefined,
): CacheTtlPruningSettings | undefined {
  if (config?.mode !== "cache-ttl") {
    return undefined;
  }
  let ttlMs = 5 * 60_000;
  try {
    ttlMs = config.ttl ? parseDurationMs(config.ttl, { defaultUnit: "m" }) : ttlMs;
  } catch {
    // Invalid durations retain the shipped five-minute default.
  }
  const normalize = normalizeLowercaseStringOrEmpty;
  const deny = compileGlobPatterns({ raw: config.tools?.deny, normalize });
  const allow = compileGlobPatterns({ raw: config.tools?.allow, normalize });
  return {
    ttlMs,
    hardClear: config.hardClear?.enabled ?? true,
    placeholder: config.hardClear?.placeholder?.trim() || CACHE_TTL_DEFAULT_PLACEHOLDER,
    isToolPrunable: (toolName) => {
      const normalized = normalize(toolName);
      return (
        !matchesAnyGlobPattern(normalized, deny) &&
        (allow.length === 0 || matchesAnyGlobPattern(normalized, allow))
      );
    },
  };
}

function cacheTtlText(block: unknown, serializeMalformed = true): string | undefined {
  if (!isRecord(block) || block.type !== "text") {
    return undefined;
  }
  if (typeof block.text === "string") {
    return block.text;
  }
  if (!serializeMalformed) {
    return undefined;
  }
  try {
    return JSON.stringify(block) ?? "[malformed text block]";
  } catch {
    return "[malformed text block]";
  }
}

function cacheTtlMessageChars(message: AgentMessage): number {
  if (message.role === "user" && typeof message.content === "string") {
    return estimateStringChars(message.content);
  }
  if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") {
    return 256;
  }
  const content: unknown[] = Array.isArray(message.content) ? message.content : [];
  return content.reduce<number>((chars, block) => {
    if (!isRecord(block)) {
      return chars;
    }
    const text = cacheTtlText(block, message.role !== "assistant");
    if (text !== undefined) {
      return chars + estimateStringChars(text);
    }
    if (block.type === "image") {
      return chars + CACHE_TTL_IMAGE_CHARS;
    }
    if (message.role !== "assistant") {
      return chars;
    }
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      const values = [
        block.thinking,
        block.thinkingSignature,
        ...(block.type === "redacted_thinking" ? [block.data] : []),
      ];
      return values.reduce<number>(
        (sum, value) => sum + (typeof value === "string" ? estimateStringChars(value) : 0),
        chars,
      );
    }
    if (block.type !== "toolCall") {
      return chars;
    }
    try {
      return chars + JSON.stringify(block.arguments ?? {}).length;
    } catch {
      return chars + 128;
    }
  }, 0);
}

function softPruneCacheTtlToolResult(
  message: CacheTtlToolResultMessage,
): CacheTtlToolResultMessage {
  const content = Array.isArray(message.content) ? message.content : [];
  const hasImage = content.some((block) => isRecord(block) && block.type === "image");
  const text = content
    .flatMap(
      (block) =>
        cacheTtlText(block) ??
        (isRecord(block) && block.type === "image" ? CACHE_TTL_IMAGE_MARKER : []),
    )
    .join("\n");
  if (!hasImage && text.length <= 4_000) {
    return message;
  }
  const projected =
    text.length <= 4_000
      ? text
      : `${sliceUtf16Safe(text, 0, 1_500)}\n...\n${sliceUtf16Safe(text, -1_500)}\n\n` +
        `[Tool result trimmed: kept first 1500 chars and last 1500 chars of ${text.length} chars.]`;
  return { ...message, content: freezeJsonSnapshot([{ type: "text", text: projected }]) };
}

/** Projects expired cache-TTL history without mutating the transcript. */
export function pruneExpiredCacheTtlToolResults(params: {
  messages: AgentMessage[];
  settings: CacheTtlPruningSettings;
  contextWindowTokens: number;
  lastCacheTouchAt: number | null;
  dropThinkingBlocksForEstimate: boolean;
  now: number;
  projectionState: ToolResultPromptProjectionState;
  /** False replays existing projections only, when another owner (server clearing) prunes. */
  pruneNewRounds: boolean;
  onPruned?: () => void;
}): AgentMessage[] {
  const { settings, projectionState } = params;
  const projection = projectToolResultMessages({
    messages: params.messages,
    projectionState,
  });
  const messages = projection.messages;
  const unchanged = messages.some((message, index) => message !== params.messages[index])
    ? messages
    : params.messages;
  let next: AgentMessage[] | undefined;
  const recordProjection = (
    index: number,
    message: CacheTtlToolResultMessage,
    mode: "soft" | "hard",
  ) => {
    const key = projection.keys[index];
    const replacement = key
      ? Object.assign({}, message, { [TOOL_RESULT_PROJECTION_KEY]: key })
      : message;
    if (key) {
      // TTL gates new edits only: replay these bytes until their source leaves the session.
      recordToolResultPromptProjection(projectionState, key, replacement, mode);
      projectionState.frozen.add(key);
    }
    (next ??= messages.slice())[index] = replacement;
  };
  if (
    !params.pruneNewRounds ||
    !params.lastCacheTouchAt ||
    settings.ttlMs <= 0 ||
    params.now - params.lastCacheTouchAt < settings.ttlMs
  ) {
    return unchanged;
  }
  const cutoff =
    messages.flatMap((message, index) => (message.role === "assistant" ? [index] : [])).at(-3) ??
    -1;
  const start = messages.findIndex((message) => message.role === "user");
  if (cutoff < 0 || start < 0) {
    return unchanged;
  }
  const estimate = params.dropThinkingBlocksForEstimate ? dropThinkingBlocks(messages) : messages;
  // Thinking removal preserves positions; reuse costs only within this pruning pass.
  const messageChars = estimate.map(cacheTtlMessageChars);
  let totalChars = messageChars.reduce((sum, chars) => sum + chars, 0);
  const charWindow = params.contextWindowTokens * 4;
  if (totalChars / charWindow < 0.3) {
    return unchanged;
  }
  const eligible: { index: number; chars: number }[] = [];
  for (let index = start; index < cutoff; index++) {
    const message = messages[index];
    if (
      message?.role !== "toolResult" ||
      !settings.isToolPrunable(typeof message.toolName === "string" ? message.toolName : "")
    ) {
      continue;
    }
    const key = projection.keys[index];
    const previousMode = key ? projectionState.replacements.get(key)?.cacheTtl : undefined;
    if (previousMode === "hard") {
      continue;
    }
    const candidate = { index, chars: messageChars[index]! };
    eligible.push(candidate);
    if (previousMode === "soft") {
      continue;
    }
    // Trim the canonical source, not the oversized projection, so a restart re-derives identical bytes.
    const source = params.messages[index];
    const projected = source?.role === "toolResult" ? softPruneCacheTtlToolResult(source) : source;
    if (projected && projected !== source && projected.role === "toolResult") {
      const projectedChars = cacheTtlMessageChars(projected);
      totalChars += projectedChars - candidate.chars;
      candidate.chars = projectedChars;
      recordProjection(index, projected, "soft");
    }
  }
  if (
    totalChars / charWindow >= 0.5 &&
    settings.hardClear &&
    eligible.reduce((sum, candidate) => sum + candidate.chars, 0) >= 50_000
  ) {
    for (const { index, chars } of eligible) {
      if (totalChars / charWindow < 0.5) {
        break;
      }
      const message = (next ?? messages)[index];
      if (message?.role !== "toolResult") {
        continue;
      }
      const cleared = {
        ...message,
        content: freezeJsonSnapshot([{ type: "text" as const, text: settings.placeholder }]),
      };
      totalChars += cacheTtlMessageChars(cleared) - chars;
      recordProjection(index, cleared, "hard");
    }
  }
  if (next) {
    params.onPruned?.();
  }
  return next ?? unchanged;
}

const MIN_KEEP_CHARS = 2_000;
const RECOVERY_MIN_KEEP_CHARS = 0;
const TOOL_RESULT_WARNING_DEDUPE_LIMIT = 1_024;
export const toolResultWarningDedupe = {
  sessionRecovery: createDedupeCache({ ttlMs: 0, maxSize: TOOL_RESULT_WARNING_DEDUPE_LIMIT }),
};

type ToolResultTruncationOptions = {
  suffix?: (truncatedChars: number) => string;
  minKeepChars?: number;
  minimumRawWeight?: number;
};

const DEFAULT_SUFFIX = truncationNotice.formatContextLimitTruncationNotice;
const COMPACT_RECOVERY_SUFFIX = (truncatedChars: number) =>
  `[... ${Math.max(1, Math.floor(truncatedChars))} chars truncated; narrow args]`;
const AGGREGATE_ELISION_MARKER =
  "[tool result elided: aggregate tool-result budget exceeded; rerun the command if the output is needed]";

function resolveEffectiveMinKeepChars(
  maxChars: number,
  options: ToolResultTruncationOptions,
  suffixFactory: (truncatedChars: number) => string,
): number {
  const minKeepChars = options.minKeepChars ?? MIN_KEEP_CHARS;
  const budgetOptions = { minimumRawWeight: options.minimumRawWeight };
  const suffixFloor = estimateToolResultTextChars(suffixFactory(1), budgetOptions);
  return Math.max(0, Math.min(minKeepChars, maxChars - suffixFloor));
}

function appendBoundedTruncationSuffix(params: {
  keptText: string;
  originalTextLength: number;
  maxChars: number;
  suffixFactory: (truncatedChars: number) => string;
  minimumRawWeight?: number;
}): string {
  let keptText = params.keptText;
  const budgetOptions = { minimumRawWeight: params.minimumRawWeight };
  while (true) {
    const suffix = params.suffixFactory(Math.max(1, params.originalTextLength - keptText.length));
    const suffixChars = estimateToolResultTextChars(suffix, budgetOptions);
    if (suffixChars >= params.maxChars) {
      const fullOmissionSuffix = params.suffixFactory(Math.max(1, params.originalTextLength));
      return sliceToolResultTextToBudget(fullOmissionSuffix, params.maxChars, budgetOptions);
    }
    const nextKeptText = sliceToolResultTextToBudget(
      keptText,
      params.maxChars - suffixChars,
      budgetOptions,
    );
    const finalText = nextKeptText + suffix;
    if (
      nextKeptText.length === keptText.length &&
      estimateToolResultTextChars(finalText, budgetOptions) <= params.maxChars
    ) {
      return finalText;
    }
    if (nextKeptText.length === 0 && keptText.length === 0) {
      return sliceToolResultTextToBudget(finalText, params.maxChars, budgetOptions);
    }
    keptText = nextKeptText;
  }
}

const MIDDLE_OMISSION_MARKER =
  "\n\n⚠️ [... middle content omitted — showing head and tail ...]\n\n";

function hasImportantTail(text: string): boolean {
  const tail = normalizeLowercaseStringOrEmpty(sliceUtf16Safe(text, -2000));
  return (
    /\b(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code)\b/.test(tail) ||
    // Exec/process append terminal facts after output; they may not contain
    // "error" or "failed", but dropping them makes a failed command look successful.
    /\b(exited with (?:code|signal)|timed out|aborted|stopped by request|not found|not executable)\b/.test(
      tail,
    ) ||
    /\}\s*$/.test(tail.trim()) ||
    /\b(total|summary|result|complete|finished|done)\b/.test(tail)
  );
}

/** Truncates text while preserving an important diagnostic tail when present. */
export function truncateToolResultText(
  text: string,
  maxChars: number,
  options: ToolResultTruncationOptions = {},
): string {
  const suffixFactory = options.suffix ?? DEFAULT_SUFFIX;
  const budgetOptions = { minimumRawWeight: options.minimumRawWeight };
  const minKeepChars = resolveEffectiveMinKeepChars(maxChars, options, suffixFactory);
  if (text.length <= maxChars && estimateToolResultTextChars(text, budgetOptions) <= maxChars) {
    return text;
  }
  const initialKeptText = sliceToolResultTextToBudget(text, maxChars, budgetOptions);
  const defaultSuffix = suffixFactory(Math.max(1, text.length - initialKeptText.length));
  const budget = Math.max(
    minKeepChars,
    maxChars - estimateToolResultTextChars(defaultSuffix, budgetOptions),
  );

  const appendSuffix = (keptText: string) =>
    appendBoundedTruncationSuffix({
      keptText,
      originalTextLength: text.length,
      maxChars,
      suffixFactory,
      minimumRawWeight: options.minimumRawWeight,
    });
  if (hasImportantTail(text) && budget > minKeepChars * 2) {
    const tailBudget = Math.min(Math.floor(budget * 0.3), 4_000);
    const headBudget =
      budget - tailBudget - estimateToolResultTextChars(MIDDLE_OMISSION_MARKER, budgetOptions);

    if (headBudget > minKeepChars) {
      let headText = sliceToolResultTextToBudget(text, headBudget, budgetOptions);
      const headNewline = headText.lastIndexOf("\n");
      if (headNewline > headText.length * 0.8) {
        headText = sliceUtf16Safe(headText, 0, headNewline);
      }

      let tailText = sliceToolResultTextTailToBudget(text, tailBudget, budgetOptions);
      const tailNewline = tailText.indexOf("\n");
      if (tailNewline !== -1 && tailNewline < tailText.length * 0.2) {
        tailText = sliceUtf16Safe(tailText, tailNewline + 1);
      }

      if (headText.length + tailText.length < text.length) {
        return appendSuffix(headText + MIDDLE_OMISSION_MARKER + tailText);
      }
    }
  }

  let keptText = sliceToolResultTextToBudget(text, budget, budgetOptions);
  const lastNewline = keptText.lastIndexOf("\n");
  if (lastNewline > keptText.length * 0.8) {
    keptText = sliceUtf16Safe(keptText, 0, lastNewline);
  }
  return appendSuffix(keptText);
}

export function resolveLiveToolResultAggregateMaxChars(params: {
  contextWindowTokens: number;
  perResultMaxChars?: number;
}): number {
  const perResultMaxChars = Math.max(
    1,
    Math.floor(
      params.perResultMaxChars ??
        resolveLiveToolResultMaxChars({
          contextWindowTokens: params.contextWindowTokens,
        }),
    ),
  );
  const contextWindowTokens = Number.isFinite(params.contextWindowTokens)
    ? Math.max(1, Math.floor(params.contextWindowTokens))
    : 1;
  // Match the 0.5 safeguard/mid-turn pressure invariant so truncation cannot hide pressure.
  const contextShareChars = Math.floor(
    contextWindowTokens * 4 * AGGREGATE_TOOL_RESULT_CONTEXT_SHARE,
  );
  return Math.max(
    perResultMaxChars * PROMPT_TOOL_RESULT_AGGREGATE_CAP_MULTIPLIER,
    contextShareChars,
  );
}

function getToolResultTextBudget(msg: AgentMessage): number {
  if (!msg || msg.role !== "toolResult") {
    return 0;
  }
  const content = (msg as { content?: unknown }).content;
  return Array.isArray(content)
    ? content.reduce(
        (total, block) =>
          total + (isToolResultTextBlock(block) ? estimateToolResultTextChars(block.text) : 0),
        0,
      )
    : 0;
}

export function truncateToolResultMessage(
  msg: Extract<AgentMessage, { role: "toolResult" }>,
  maxChars: number,
  options?: ToolResultTruncationOptions,
): Extract<AgentMessage, { role: "toolResult" }>;
export function truncateToolResultMessage(
  msg: AgentMessage,
  maxChars: number,
  options?: ToolResultTruncationOptions,
): AgentMessage;
export function truncateToolResultMessage(
  msg: AgentMessage,
  maxChars: number,
  options: ToolResultTruncationOptions = {},
): AgentMessage {
  const suffixFactory = options.suffix ?? truncationNotice.forMessage(msg);
  const budgetOptions = { minimumRawWeight: options.minimumRawWeight };
  const minKeepChars = resolveEffectiveMinKeepChars(maxChars, options, suffixFactory);
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return msg;
  }

  const blockTextChars = content.map((block) =>
    isToolResultTextBlock(block)
      ? (readPreparedToolResultTextChars(block, block.text, budgetOptions.minimumRawWeight ?? 1) ??
        estimateToolResultTextChars(block.text, budgetOptions))
      : 0,
  );
  const totalTextChars = blockTextChars.reduce((sum, chars) => sum + chars, 0);
  if (totalTextChars <= maxChars) {
    return msg;
  }

  // A caller's raw-text safety floor changes cost, not which semantic blocks
  // are short. Reserve their actual weighted cost before shrinking larger text.
  let smallBlockChars = 0;
  let largeBlockNoticeChars = 0;
  let totalNoticeChars = 0;
  const blocks = content.map((block, index) => {
    const textChars = blockTextChars[index] ?? 0;
    const text = textChars > 0 && isToolResultTextBlock(block) ? block.text : undefined;
    const small =
      text !== undefined &&
      text.length <= minKeepChars &&
      estimateToolResultTextChars(text) <= minKeepChars;
    const noticeChars =
      text === undefined
        ? 0
        : estimateToolResultTextChars(suffixFactory(Math.max(1, text.length)), budgetOptions);
    smallBlockChars += small ? textChars : 0;
    largeBlockNoticeChars += small ? 0 : noticeChars;
    totalNoticeChars += noticeChars;
    return { block, textChars, small, noticeChars };
  });
  // Preserve short semantic blocks when larger ones can retain a complete truncation notice.
  const preserveSmallBlocks = smallBlockChars + largeBlockNoticeChars <= maxChars;
  const preservedChars = preserveSmallBlocks ? smallBlockChars : 0;
  const remainingBudget = Math.max(0, maxChars - preservedChars);
  const reducibleChars = totalTextChars - preservedChars;
  const reducibleNoticeChars = preserveSmallBlocks ? largeBlockNoticeChars : totalNoticeChars;
  const noticeScale =
    reducibleNoticeChars > 0 ? Math.min(1, remainingBudget / reducibleNoticeChars) : 0;
  const distributableBudget = Math.max(0, remainingBudget - reducibleNoticeChars);

  const newContent = blocks.map(({ block, textChars, small, noticeChars }) => {
    if (!isToolResultTextBlock(block)) {
      return block;
    }
    const preserveBlock = preserveSmallBlocks && small;
    const blockShare = reducibleChars > 0 ? textChars / reducibleChars : 0;
    const noticeBudget = noticeChars * noticeScale;
    const blockBudget = preserveBlock
      ? textChars
      : Math.floor(noticeBudget + distributableBudget * blockShare);
    const blockMinKeepChars = preserveBlock ? textChars : Math.floor(minKeepChars * blockShare);
    const truncatedText = truncateToolResultText(block.text, blockBudget, {
      suffix: suffixFactory,
      minKeepChars: blockMinKeepChars,
      minimumRawWeight: options.minimumRawWeight,
    });
    const nextBlock = Object.assign({}, block, { text: truncatedText });
    if (typeof block.content === "string") {
      nextBlock.content = truncatedText;
    }
    return nextBlock;
  });

  return { ...msg, content: newContent } as AgentMessage;
}

function getToolResultSpillDetails(message: AgentMessage) {
  const details = (message as { details?: unknown }).details;
  if (!isRecord(details)) {
    return undefined;
  }
  const nestedSpill = isRecord(details.spill) ? details.spill : undefined;
  // web_fetch owns the nested contract. Exec tools still own the flat spill fields.
  const path = nestedSpill?.path ?? details.fullOutputPath;
  if (typeof path !== "string" || path.length === 0) {
    return undefined;
  }
  const chars = nestedSpill?.chars ?? details.spilledChars;
  return {
    path,
    truncated: nestedSpill?.truncated === true || details.spillTruncated === true,
    ...(typeof chars === "number" && Number.isFinite(chars)
      ? { chars: Math.max(0, Math.floor(chars)) }
      : {}),
  };
}

type AggregateElisionMarkers = {
  full: string;
  compact: string;
  truncationSuffix: (truncatedChars: number) => string;
};

function resolveAggregateElisionMarkers(
  message: AgentMessage,
): AggregateElisionMarkers | undefined {
  const spill = getToolResultSpillDetails(message);
  if (!spill) {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  const footer = formatFullOutputFooter(spill.path);
  const escapedFooter = JSON.stringify(footer).slice(1, -1);
  // Preserve only paths already visible in the original footer.
  if (
    !Array.isArray(content) ||
    !content.some(
      (block) =>
        isToolResultTextBlock(block) &&
        (block.text.includes(footer) || block.text.includes(escapedFooter)),
    )
  ) {
    return undefined;
  }
  // Avoid pointing recovery at already-deleted spill files.
  if (!existsSync(spill.path)) {
    return undefined;
  }
  // The original footer already disclosed this path, so preserving it adds no disclosure.
  const kind = spill.truncated ? "partial" : "full";
  const count = spill.truncated
    ? ` (${spill.chars === undefined ? "capped content" : `first ${spill.chars} chars`})`
    : "";
  const output = `${kind} output`;
  return {
    full: `[tool result elided: ${output} preserved at ${spill.path}${count}; read it if the output is needed]`,
    compact: spill.truncated ? `[partial: ${spill.path}]` : `[read ${spill.path}]`,
    truncationSuffix: (truncatedChars) =>
      `[... ${Math.max(1, Math.floor(truncatedChars))} chars truncated; ${output} at ${spill.path}]`,
  };
}

/** Projects bounded tool-result history without mutating the transcript. */
export function truncateOversizedToolResultsInMessages(
  messages: AgentMessage[],
  contextWindowTokens: number,
  maxCharsOverride?: number,
  aggregateMaxCharsOverride?: number,
  projectionState?: ToolResultPromptProjectionState,
): {
  messages: AgentMessage[];
  truncatedCount: number;
  aggregateTruncatedCount: number;
  aggregatePressureEngaged: boolean;
} {
  const { maxChars, aggregateBudgetChars } = resolveToolResultBudgets({
    contextWindowTokens,
    maxCharsOverride,
    aggregateMaxCharsOverride,
  });
  const projection = projectionState
    ? projectToolResultMessages({
        messages,
        projectionState,
      })
    : undefined;
  const plan = buildToolResultReplacementPlan({
    messages: projection?.messages ?? messages,
    aggregateEligible: projection?.aggregateEligible,
    maxChars,
    aggregateBudgetChars,
    protectTrailingToolResults: Boolean(projectionState),
  });
  if (projectionState) {
    for (const [index, originalMessage] of messages.entries()) {
      const projectedMessage = plan.messages[index];
      const projectionKey = projection?.keys[index];
      if (projectionKey) {
        projectionState.frozen.add(projectionKey);
        if (
          plan.changedIndices.size > 0 &&
          projectedMessage?.role === "toolResult" &&
          projectedMessage !== originalMessage
        ) {
          recordToolResultPromptProjection(projectionState, projectionKey, projectedMessage);
        }
      }
    }
  }
  return {
    messages: plan.messages.some((message, index) => message !== messages[index])
      ? plan.messages
      : messages,
    truncatedCount: plan.changedIndices.size,
    aggregateTruncatedCount: plan.aggregateReplacementCount,
    aggregatePressureEngaged: plan.aggregatePressureExceeded,
  };
}

function resolveToolResultBudgets(params: {
  contextWindowTokens: number;
  maxCharsOverride?: number;
  aggregateMaxCharsOverride?: number;
}): { maxChars: number; aggregateBudgetChars: number } {
  const maxChars = Math.max(
    1,
    params.maxCharsOverride ??
      calculateMaxToolResultCharsWithCap(
        params.contextWindowTokens,
        resolveAutoLiveToolResultMaxChars(params.contextWindowTokens),
      ),
  );
  return {
    maxChars,
    aggregateBudgetChars: Math.max(
      1,
      params.aggregateMaxCharsOverride ??
        resolveLiveToolResultAggregateMaxChars({
          contextWindowTokens: params.contextWindowTokens,
          perResultMaxChars: maxChars,
        }),
    ),
  };
}

/** Reads pruned keys from the active transcript branch, never from a sibling branch. */
export function restoreCacheTtlToolResultProjections(
  projectionState: ToolResultPromptProjectionState,
  entries: readonly { type?: unknown; customType?: unknown; data?: unknown }[],
): void {
  const checkpoint = readCacheTtlCheckpoint(entries);
  projectionState.cacheTtlCheckpoint = checkpoint;
  if (!checkpoint) {
    return;
  }
  for (const key of checkpoint.snapshot.ambiguousToolResultBaseKeys) {
    projectionState.ambiguousBaseKeys.add(key);
  }
  for (const { key, sourceHash, texts } of checkpoint.snapshot.frozenToolResults) {
    // A live attempt can be ahead of its last marker; never roll it back.
    if (projectionState.sourceHashByKey.has(key)) {
      continue;
    }
    projectionState.sourceHashByKey.set(key, sourceHash);
    projectionState.frozen.add(key);
    if (texts) {
      projectionState.replacements.set(key, {
        content: freezeJsonSnapshot(texts.map((text) => ({ type: "text" as const, text }))),
      });
    }
  }
  for (const { key, ...mark } of checkpoint.snapshot.prunedToolResults) {
    if (!projectionState.replacements.get(key)?.cacheTtl) {
      projectionState.restoredCacheTtl.set(key, mark);
    }
  }
}

/** Drops projections whose source messages were removed or rewritten in canonical history. */
export function reconcileToolResultPromptProjectionState(
  messages: AgentMessage[],
  projectionState: ToolResultPromptProjectionState,
): void {
  const keys = getToolResultProjectionKeys(messages, projectionState);
  const canonicalKeys = new Set(
    messages.flatMap((message, index) => {
      const key = keys[index];
      const source = key ? projectionState.sourceHashByKey.get(key) : undefined;
      return key && (!source || source === hashToolResultText(getToolResultTextBlocks(message)))
        ? [key]
        : [];
    }),
  );
  for (const key of [
    ...projectionState.frozen,
    ...projectionState.replacements.keys(),
    ...projectionState.sourceHashByKey.keys(),
  ]) {
    if (!canonicalKeys.has(key)) {
      projectionState.frozen.delete(key);
      projectionState.replacements.delete(key);
      projectionState.sourceHashByKey.delete(key);
    }
  }
  const representedBaseKeys = new Set(messages.map(getToolResultProjectionBaseKey));
  for (const baseKey of projectionState.ambiguousBaseKeys) {
    if (!representedBaseKeys.has(baseKey)) {
      projectionState.ambiguousBaseKeys.delete(baseKey);
    }
  }
}

export function projectToolResultMessages(params: {
  messages: AgentMessage[];
  projectionState: ToolResultPromptProjectionState;
  recovering?: true;
}) {
  const keys = getToolResultProjectionKeys(params.messages, params.projectionState);
  materializeRestoredCacheTtl(params.messages, keys, params.projectionState);
  const aggregateEligible: boolean[] = [];
  return {
    keys,
    aggregateEligible,
    messages: params.messages.map((source, index) => {
      const key = keys[index];
      const frozen = key !== undefined && params.projectionState.frozen.has(key);
      const projected =
        key && (!params.recovering || frozen)
          ? params.projectionState.replacements.get(key)
          : undefined;
      if (key && !params.recovering && !params.projectionState.sourceHashByKey.has(key)) {
        params.projectionState.sourceHashByKey.set(
          key,
          hashToolResultText(getToolResultTextBlocks(source)),
        );
      }
      const message = projected
        ? projectToolResultMessage(
            source,
            projected,
            key,
            key ? params.projectionState.sourceHashByKey.get(key) : undefined,
          )
        : source;
      // Dispatch retains frozen bytes; recovery follows a rejected provider prefix.
      aggregateEligible.push(params.recovering || !key || !frozen);
      return message;
    }),
  };
}

/**
 * Restored marker keys become replacements here, at the owner every replay path
 * uses, so the pruned bytes are sent whether or not cache-TTL pruning is still on.
 */
function materializeRestoredCacheTtl(
  messages: AgentMessage[],
  keys: Array<string | undefined>,
  state: ToolResultPromptProjectionState,
): void {
  if (state.restoredCacheTtl.size === 0) {
    return;
  }
  for (const [index, message] of messages.entries()) {
    const key = keys[index];
    if (!key || message.role !== "toolResult" || state.replacements.get(key)?.cacheTtl) {
      continue;
    }
    const baseKey = getToolResultProjectionBaseKey(message);
    const exact = state.restoredCacheTtl.get(key);
    const mark = exact ?? (baseKey ? state.restoredCacheTtl.get(baseKey) : undefined);
    if (!mark) {
      continue;
    }
    if (!exact && baseKey) {
      // A key persisted before its tool id became ambiguous belongs to the earliest occurrence.
      state.restoredCacheTtl.delete(baseKey);
    }
    const projected =
      mark.mode === "hard"
        ? {
            ...message,
            content: freezeJsonSnapshot([{ type: "text" as const, text: mark.placeholder }]),
          }
        : softPruneCacheTtlToolResult(message);
    recordToolResultPromptProjection(state, key, projected, mark.mode);
    state.frozen.add(key);
    if (!state.sourceHashByKey.has(key)) {
      state.sourceHashByKey.set(key, hashToolResultText(getToolResultTextBlocks(message)));
    }
  }
  // Marks whose source left the branch (compaction, reset) are dropped with this pass.
  state.restoredCacheTtl.clear();
}

function clearToolResultText(
  message: AgentMessage,
  maxTextChars: number,
  resolvedSpillMarkers?: AggregateElisionMarkers,
): AgentMessage {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return message;
  }
  let remainingTextBudget = Math.max(0, Math.floor(maxTextChars));
  const spillMarkers = resolvedSpillMarkers ?? resolveAggregateElisionMarkers(message);
  if (spillMarkers) {
    // Keep recoverable pointers; their ~130 chars are negligible against the 64k+ floor.
    remainingTextBudget = Math.max(
      remainingTextBudget,
      estimateToolResultTextChars(spillMarkers.compact),
    );
  }
  return {
    ...message,
    content: content.map((block) => {
      if (!isToolResultTextBlock(block)) {
        return block;
      }
      const replacementText =
        [spillMarkers?.full, spillMarkers?.compact].find(
          (marker): marker is string =>
            typeof marker === "string" &&
            estimateToolResultTextChars(marker) <= remainingTextBudget,
        ) ?? sliceToolResultTextToBudget(AGGREGATE_ELISION_MARKER, remainingTextBudget);
      remainingTextBudget = Math.max(
        0,
        remainingTextBudget - estimateToolResultTextChars(replacementText),
      );
      return Object.assign({}, block, {
        text: replacementText,
        ...(typeof block.content === "string" ? { content: replacementText } : {}),
      });
    }),
  } as AgentMessage;
}

function buildToolResultReplacementPlan(params: {
  messages: AgentMessage[];
  aggregateEligible?: boolean[];
  maxChars: number;
  aggregateBudgetChars: number;
  protectTrailingToolResults?: boolean;
}) {
  // Plan on message positions; transcript entry IDs belong only to the rewrite boundary.
  const trailingStart = params.protectTrailingToolResults
    ? params.messages.findLastIndex((message) => message.role === "assistant") + 1
    : params.messages.length;
  const candidates = params.messages.flatMap((message, index) => {
    const textLength = getToolResultTextBudget(message);
    return message.role === "toolResult" && textLength > 0
      ? [{ index, source: message, message, textLength, aggregateTextLength: textLength }]
      : [];
  });
  const changedIndices = new Set<number>();
  let messages = params.messages;
  const replace = (
    candidate: (typeof candidates)[number],
    message: AgentMessage,
    textLength: number,
  ) => {
    const reduction = Math.max(0, candidate.textLength - textLength);
    if (messages === params.messages) {
      messages = messages.slice();
    }
    messages[candidate.index] = message;
    changedIndices.add(candidate.index);
    candidate.textLength = textLength;
    return reduction;
  };
  let oversizedReplacementCount = 0;
  let oversizedReducibleChars = 0;
  for (const candidate of candidates) {
    if (candidate.textLength <= params.maxChars) {
      continue;
    }
    const suffix = resolveAggregateElisionMarkers(candidate.source)?.truncationSuffix;
    candidate.message = truncateToolResultMessage(
      candidate.message,
      Math.max(params.maxChars, suffix ? estimateToolResultTextChars(suffix(1)) : 0),
      {
        minKeepChars: candidate.index >= trailingStart ? MIN_KEEP_CHARS : RECOVERY_MIN_KEEP_CHARS,
        ...(suffix ? { suffix } : {}),
      },
    );
    oversizedReducibleChars += replace(
      candidate,
      candidate.message,
      candidate.message === candidate.source
        ? candidate.textLength
        : getToolResultTextBudget(candidate.message),
    );
    candidate.aggregateTextLength = candidate.textLength;
    oversizedReplacementCount++;
  }
  const aggregateCandidates = candidates.filter((candidate) => candidate.textLength > 0);
  const remainingChars = aggregateCandidates.reduce((sum, item) => sum + item.textLength, 0);
  const aggregatePressureExceeded =
    aggregateCandidates.length >= 2 && remainingChars > params.aggregateBudgetChars;
  const suffixFactory =
    params.aggregateBudgetChars <
    aggregateCandidates.length * estimateToolResultTextChars(DEFAULT_SUFFIX(1))
      ? COMPACT_RECOVERY_SUFFIX
      : DEFAULT_SUFFIX;
  const minTruncatedTextChars = estimateToolResultTextChars(suffixFactory(1));
  const aggregateIndices = new Set<number>();
  let remainingReduction = aggregatePressureExceeded
    ? remainingChars - params.aggregateBudgetChars
    : 0;
  // Trim older results before clearing any. Frozen history and the unconsumed tail stay intact.
  for (const clear of [false, true]) {
    for (const candidate of aggregateCandidates) {
      if (remainingReduction <= 0) {
        break;
      }
      if (
        params.aggregateEligible?.[candidate.index] === false ||
        candidate.index >= trailingStart
      ) {
        continue;
      }
      if (!clear && candidate.textLength <= minTruncatedTextChars) {
        continue;
      }
      const spillMarkers = resolveAggregateElisionMarkers(candidate.source);
      const suffix = spillMarkers?.truncationSuffix ?? suffixFactory;
      const message = clear
        ? clearToolResultText(
            candidate.message,
            Math.max(
              params.protectTrailingToolResults
                ? estimateToolResultTextChars(spillMarkers?.compact ?? AGGREGATE_ELISION_MARKER)
                : 0,
              candidate.textLength - remainingReduction,
            ),
            spillMarkers,
          )
        : truncateToolResultMessage(
            candidate.message,
            Math.max(
              minTruncatedTextChars,
              candidate.textLength - remainingReduction,
              estimateToolResultTextChars(suffix(1)),
            ),
            { minKeepChars: RECOVERY_MIN_KEEP_CHARS, suffix },
          );
      const textLength =
        message === candidate.message
          ? candidate.aggregateTextLength
          : getToolResultTextBudget(message);
      const reduction = Math.max(0, candidate.textLength - textLength);
      if (reduction <= 0 && (!clear || !spillMarkers)) {
        continue;
      }
      remainingReduction -= replace(candidate, message, textLength);
      aggregateIndices.add(candidate.index);
    }
  }
  const aggregateReducibleChars = candidates.reduce((sum, candidate) => {
    // Both passes may replace one result; count its reduction from the per-result plan once.
    return aggregateIndices.has(candidate.index)
      ? sum + Math.max(0, candidate.aggregateTextLength - candidate.textLength)
      : sum;
  }, 0);
  return {
    messages,
    changedIndices,
    oversizedReplacementCount,
    aggregateReplacementCount: aggregateIndices.size,
    aggregatePressureExceeded,
    oversizedReducibleChars,
    aggregateReducibleChars,
  };
}

export function estimateToolResultReductionPotential(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
  maxCharsOverride?: number;
  aggregateMaxCharsOverride?: number;
}) {
  const { maxChars, aggregateBudgetChars } = resolveToolResultBudgets(params);
  const plan = buildToolResultReplacementPlan({
    messages: params.messages,
    maxChars,
    aggregateBudgetChars,
  });
  const maxReducibleChars = plan.oversizedReducibleChars + plan.aggregateReducibleChars;

  return {
    oversizedCount: plan.oversizedReplacementCount,
    aggregateReducibleChars: plan.aggregateReducibleChars,
    maxReducibleChars,
  };
}

export async function truncateOversizedToolResultsInSessionManager(params: {
  sessionManager: SessionManager;
  contextWindowTokens: number;
  maxCharsOverride?: number;
  aggregateMaxCharsOverride?: number;
  protectTrailingToolResults?: boolean;
  projectionState?: ToolResultPromptProjectionState;
  sessionFile?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  storePath?: string;
}): Promise<{ truncated: boolean; truncatedCount: number; reason?: string }> {
  try {
    const { sessionManager, contextWindowTokens } = params;
    const contextEntries = Array.from(
      iterateSessionContextEntries(sessionManager.getBranch()),
      ({ entry }) => entry,
    );

    if (contextEntries.length === 0) {
      return { truncated: false, truncatedCount: 0, reason: "empty session" };
    }

    const branch = contextEntries.filter((entry) => entry.type === "message");
    const messages = branch.map((entry) => entry.message);
    const projected = params.projectionState
      ? projectToolResultMessages({
          messages,
          projectionState: params.projectionState,
          recovering: true,
        }).messages
      : messages;
    const { maxChars, aggregateBudgetChars } = resolveToolResultBudgets(params);
    const plan = buildToolResultReplacementPlan({
      ...params,
      messages: projected,
      maxChars,
      aggregateBudgetChars,
    });
    const replacements = branch.flatMap((entry, index) => {
      const message = plan.messages[index]!;
      return entry.message === message || JSON.stringify(entry.message) === JSON.stringify(message)
        ? []
        : [{ entryId: entry.id, message }];
    });
    if (replacements.length === 0) {
      return {
        truncated: false,
        truncatedCount: 0,
        reason: "no oversized or aggregate tool results",
      };
    }
    const rewriteResult = await rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements,
    });
    if (rewriteResult.changed && params.projectionState) {
      // Recovery changed canonical bytes; keeping their former source would undo the next TTL edit.
      reconcileToolResultPromptProjectionState(
        sessionManager.buildSessionContext().messages,
        params.projectionState,
      );
    }
    const target =
      sessionManager.getSessionTarget() ??
      (params.sessionId && params.sessionKey && params.agentId && params.storePath
        ? {
            agentId: params.agentId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            storePath: params.storePath,
          }
        : undefined);
    if (rewriteResult.changed && (params.sessionFile || target)) {
      emitSessionTranscriptUpdate({
        ...(params.sessionFile ? { sessionFile: params.sessionFile } : {}),
        ...(target
          ? { target }
          : {
              sessionKey: params.sessionKey,
              ...(params.agentId ? { agentId: params.agentId } : {}),
            }),
      });
    }

    const sessionLogKey = params.sessionKey ?? params.sessionId ?? "unknown";
    const message =
      `[tool-result-truncation] Truncated ${rewriteResult.rewrittenEntries} tool result(s) in session ` +
      `(contextWindow=${contextWindowTokens} maxChars=${maxChars} ` +
      `aggregateBudgetChars=${aggregateBudgetChars} ` +
      `oversized=${plan.oversizedReplacementCount} aggregate=${plan.aggregateReplacementCount}) ` +
      `sessionKey=${sessionLogKey}`;
    if (
      plan.aggregateReplacementCount <= 0 ||
      toolResultWarningDedupe.sessionRecovery.check(sessionLogKey)
    ) {
      log.info(message);
    } else {
      log.warn(
        `${message}; aggregate tool-result pressure detected; consider /compact or /new if pressure persists`,
      );
    }

    return {
      truncated: rewriteResult.changed,
      truncatedCount: rewriteResult.rewrittenEntries,
      reason: rewriteResult.reason,
    };
  } catch (err) {
    const errMsg = formatErrorMessage(err);
    log.warn(`[tool-result-truncation] Failed to truncate: ${errMsg}`);
    return { truncated: false, truncatedCount: 0, reason: errMsg };
  }
}

export function sessionLikelyHasOversizedToolResults(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
  maxCharsOverride?: number;
}): boolean {
  const estimate = estimateToolResultReductionPotential(params);
  return estimate.oversizedCount > 0 || estimate.aggregateReducibleChars > 0;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
