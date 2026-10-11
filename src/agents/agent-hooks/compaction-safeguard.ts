/** Extension that safeguards compaction with structured summaries and quality repair. */

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  capCompactionSummary,
  fitCompactionSummary,
  formatRequiredAskContext,
  MAX_COMPACTION_SUMMARY_CHARS,
  SUMMARY_TRUNCATED_MARKER,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import {
  computeFileLists,
  formatFileOperations,
  MAX_FILE_OPS_SECTION_CHARS,
} from "../../../packages/agent-core/src/harness/compaction/utils.js";
import { classifyToolUseResultPairing } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getCompactionProvider,
  type CompactionProvider,
} from "../../plugins/compaction-provider.js";
import { isRealConversationMessage } from "../compaction-real-conversation.js";
import { summarizeCompactionHistory } from "../compaction.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "../copilot-dynamic-headers.js";
import { stripRuntimeContextCustomMessages } from "../internal-runtime-context.js";
import {
  buildSessionContext as buildCoreSessionContext,
  type AgentMessage,
  type SessionTreeEntry as CoreSessionTreeEntry,
} from "../runtime/index.js";
import { repairToolUseResultPairing } from "../session-transcript-repair.js";
import type { SessionModelUsageSink } from "../sessions/compaction/runtime.js";
import type { ExtensionAPI, ExtensionContext } from "../sessions/index.js";
import { recordSessionModelUsage } from "../sessions/session-model-usage.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "../tool-call-id.js";
import { resolveCompactionInstructions } from "./compaction-instructions.js";
import {
  appendSummarySection,
  auditSummaryQuality,
  buildCompactionStructureInstructions,
  buildStructuredFallbackSummary,
  createSummaryQualityRetentionPlan,
  extractOpaqueIdentifiers,
  nestRequiredSummaryHeadings,
  resolveSummaryReserveTokens,
  wrapUntrustedInstructionBlock,
} from "./compaction-safeguard-quality.js";
import {
  getCompactionSafeguardRuntime,
  setCompactionSafeguardCancellation,
} from "./compaction-safeguard-runtime.js";
import {
  collectToolFailures,
  formatToolFailuresSection,
} from "./compaction-safeguard-tool-failures.js";
import { readWorkspaceContextForSummary } from "./compaction-workspace-context.js";

const log = createSubsystemLogger("compaction-safeguard");

const missedModelWarningSessions = new WeakSet<object>();
const SPLIT_TURN_SECTION_HEADING = "**Turn Context (split turn):**";
const CONTEXT_TRUNCATED_MARKER = "\n\n[Earlier compaction context truncated to fit budget]\n\n";
// Split-turn context supplements the generated summary and must not claim its
// guaranteed half of the final artifact before common finalization runs.
const MAX_SPLIT_TURN_CONTEXT_CHARS = Math.floor(MAX_COMPACTION_SUMMARY_CHARS / 2);
const SPLIT_TURN_TRUNCATED_MARKER = "[Earlier split-turn messages truncated]\n";
const PRESERVED_TURNS_TRUNCATED_MARKER = "[Earlier preserved messages truncated]\n";
const DEFAULT_RECENT_TURNS_PRESERVE = 3;
const DEFAULT_QUALITY_GUARD_MAX_RETRIES = 1;
const MAX_RECENT_TURNS_PRESERVE = 12;
const MAX_QUALITY_GUARD_MAX_RETRIES = 3;
const MAX_RECENT_TURN_TEXT_CHARS = 600;
const compactionSafeguardDeps = {
  summarizeCompactionHistory,
};
type CompactionLoss =
  | "summary-tail"
  | "suffix-head"
  | "split-turn-head"
  | "split-turn-tail"
  | "preserved-turn-head"
  | "identifier-retention"
  | "quality-retention";

function nestMarkdownHeadings(text: string): string {
  return text.replace(/^##(?=[ \t]+\S)/gmu, "###");
}

function normalizeLegacySplitTurnSummary(summary: string | undefined): string | undefined {
  const splitTurnStart = summary?.indexOf(SPLIT_TURN_SECTION_HEADING) ?? -1;
  if (!summary || splitTurnStart < 0) {
    return summary;
  }
  const splitTurnContentStart = splitTurnStart + SPLIT_TURN_SECTION_HEADING.length;
  // Shipped safeguard summaries nested a second complete summary after this owned boundary.
  // Demote its headings only in the next model input; the persisted old boundary stays untouched.
  return `${summary.slice(0, splitTurnContentStart)}${nestRequiredSummaryHeadings(summary.slice(splitTurnContentStart))}`;
}

/**
 * The boundary-scoped range a preparation was meant to cover: everything the
 * current context holds before its kept tail, minus the prior summary message
 * (that is re-distilled separately). Bounded by construction — it can never
 * reach behind the last reset/compaction boundary.
 */
function collectPreparationRangeMessages(
  sessionManager: ExtensionContext["sessionManager"],
  firstKeptEntryId: string,
): AgentMessage[] {
  const entries = readSessionBranch(sessionManager);
  const firstKeptIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
  if (firstKeptIndex < 0) {
    return [];
  }
  // Keep replay boundaries even when their retained entries precede the physical marker.
  // The core projector, not the preparation cut, owns which older entries remain visible.
  return projectBranchEntries(
    entries.filter(
      (entry, index) =>
        index < firstKeptIndex || entry.type === "compaction" || entry.type === "reset",
    ),
  ).filter((message) => message.role !== "compactionSummary");
}

function readSessionBranch(
  sessionManager: ExtensionContext["sessionManager"],
): CoreSessionTreeEntry[] {
  try {
    return sessionManager.getBranch() as CoreSessionTreeEntry[];
  } catch {
    return [];
  }
}

function projectBranchEntries(entries: CoreSessionTreeEntry[]): AgentMessage[] {
  try {
    return buildCoreSessionContext(entries).messages as AgentMessage[];
  } catch {
    return [];
  }
}

function containsRealConversation(messages: AgentMessage[]): boolean {
  return messages.some((message, index, allMessages) =>
    isRealConversationMessage(message, allMessages, index),
  );
}

/**
 * Build the reserved suffix that follows the summary body. Both the provider
 * and LLM paths use this so diagnostic sections survive truncation.
 */
type ContextSection = {
  text: string;
  segmentStarts: number[];
  // Keep producer loss attached to the bounded artifact so every finalizer path
  // emits the same redacted diagnostic when the section already dropped context.
  truncatedLoss?: CompactionLoss;
};

type CompactionSuffix = {
  text: string;
  // Keep producer segment boundaries after later suffix sections are appended;
  // otherwise the final tail cap can split an assistant tool-call/result group.
  contextRanges: Array<{ start: number; end: number; segmentStarts: number[] }>;
  // Leading chars the tail cap keeps whole, trimming the later sections instead.
  reservedChars?: number;
};

type SummaryQualityRetention = Parameters<typeof createSummaryQualityRetentionPlan>[2];

function assembleSuffix(
  parts: {
    splitTurnSection?: ContextSection;
    generatedSplitTurnSection?: string;
    preservedTurnsSection?: ContextSection;
    toolFailureSection?: string;
    fileOpsSummary?: string;
    workspaceContext?: string;
  },
  reserveSplitTurn = false,
): CompactionSuffix {
  let text = "";
  let reservedChars = 0;
  const contextRanges: CompactionSuffix["contextRanges"] = [];
  for (const [name, part] of Object.entries(parts)) {
    const section = typeof part === "string" ? part : part?.text;
    if (!section) {
      continue;
    }
    const leadingTrim = text ? 0 : section.length - section.trimStart().length;
    const appended = leadingTrim > 0 ? section.slice(leadingTrim) : section;
    const start = text.length;
    text = appendSummarySection(text, section);
    if (reserveSplitTurn && name === "generatedSplitTurnSection") {
      reservedChars = text.length;
    }
    if (typeof part !== "string") {
      contextRanges.push({
        start,
        end: start + appended.length,
        segmentStarts: part.segmentStarts
          .filter((segmentStart) => segmentStart >= leadingTrim)
          .map((segmentStart) => start + segmentStart - leadingTrim),
      });
    }
  }
  // Ensure leading separator so suffix does not merge with body (e.g. when body
  // ends without newline: "...## Exact identifiers## Tool Failures").
  if (text && !/^\s/.test(text)) {
    text = `\n\n${text}`;
    reservedChars += reservedChars > 0 ? 2 : 0;
    for (const range of contextRanges) {
      range.start += 2;
      range.end += 2;
      range.segmentStarts = range.segmentStarts.map((segmentStart) => segmentStart + 2);
    }
  }
  return { text, contextRanges, ...(reservedChars > 0 ? { reservedChars } : {}) };
}

async function resolveModelAuth(
  ctx: ExtensionContext,
  model: NonNullable<ExtensionContext["model"]>,
): Promise<
  { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; reason: string }
> {
  let requestAuth: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
  try {
    requestAuth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  } catch (err) {
    const error = formatErrorMessage(err);
    log.warn(
      `Compaction safeguard: request credentials unavailable; cancelling compaction. ${error}`,
    );
    return {
      ok: false,
      reason: `Compaction safeguard could not resolve request credentials for ${model.provider}/${model.id}: ${error}`,
    };
  }
  if (!requestAuth.ok) {
    log.warn(
      `Compaction safeguard: request credential resolution failed for ${model.provider}/${model.id}: ${requestAuth.error}`,
    );
    return {
      ok: false,
      reason: `Compaction safeguard could not resolve request credentials for ${model.provider}/${model.id}: ${requestAuth.error}`,
    };
  }
  // `ok: true` is the registry's authoritative success signal; it already returns
  // `ok: false` when auth cannot resolve. Do not re-derive failure from absent
  // key/headers. SDK-managed modes (aws-sdk, oauth) sign the request later and
  // legitimately carry neither, so gating on them wedges compaction forever.
  return { ok: true, apiKey: requestAuth.apiKey, headers: requestAuth.headers };
}

function buildCompactionSummaryHeaders(params: {
  model: NonNullable<ExtensionContext["model"]>;
  messages: AgentMessage[];
  headers?: Record<string, string>;
}): Record<string, string> | undefined {
  if (params.model.provider !== "github-copilot") {
    return params.headers;
  }
  const messages = params.messages as unknown as Parameters<
    typeof buildCopilotDynamicHeaders
  >[0]["messages"];
  return {
    ...buildCopilotDynamicHeaders({
      messages,
      hasImages: hasCopilotVisionInput(messages),
    }),
    ...params.headers,
  };
}

function clampNonNegativeInt(value: unknown, fallback: number, max: number): number {
  const normalized = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(0, Math.floor(normalized)));
}

function resolveRecentTurnsPreserve(value: unknown): number {
  return clampNonNegativeInt(value, DEFAULT_RECENT_TURNS_PRESERVE, MAX_RECENT_TURNS_PRESERVE);
}

function resolveQualityGuardMaxRetries(value: unknown): number {
  return clampNonNegativeInt(
    value,
    DEFAULT_QUALITY_GUARD_MAX_RETRIES,
    MAX_QUALITY_GUARD_MAX_RETRIES,
  );
}

function resolveSuffixTailStart(suffix: CompactionSuffix, tailBudget: number): number {
  const desiredStart = Math.max(0, suffix.text.length - tailBudget);
  const containingRange = suffix.contextRanges.find(
    (range) => desiredStart > range.start && desiredStart < range.end,
  );
  if (!containingRange) {
    return desiredStart;
  }
  return (
    containingRange.segmentStarts.find((segmentStart) => segmentStart >= desiredStart) ??
    containingRange.end
  );
}

function capCompactionSuffix(suffix: CompactionSuffix, maxChars: number): string {
  if (suffix.text.length <= maxChars) {
    return suffix.text;
  }
  if (maxChars <= 0) {
    return "";
  }
  const reserved = suffix.reservedChars ?? 0;
  if (reserved > 0) {
    // A reservation that cannot fit keeps its head, which names the active turn.
    if (reserved >= maxChars) {
      return capCompactionSummary(suffix.text.slice(0, reserved), maxChars);
    }
    const rest: CompactionSuffix = {
      text: suffix.text.slice(reserved),
      contextRanges: suffix.contextRanges
        .filter((range) => range.start >= reserved)
        .map((range) => ({
          start: range.start - reserved,
          end: range.end - reserved,
          segmentStarts: range.segmentStarts.map((segmentStart) => segmentStart - reserved),
        })),
    };
    return `${suffix.text.slice(0, reserved)}${capCompactionSuffix(rest, maxChars - reserved)}`;
  }
  if (maxChars < CONTEXT_TRUNCATED_MARKER.length) {
    const start = resolveSuffixTailStart(suffix, maxChars);
    return sliceUtf16Safe(suffix.text, start);
  }
  const tailBudget = maxChars - CONTEXT_TRUNCATED_MARKER.length;
  const start = resolveSuffixTailStart(suffix, tailBudget);
  return tailBudget > 0
    ? `${CONTEXT_TRUNCATED_MARKER}${sliceUtf16Safe(suffix.text, start)}`
    : CONTEXT_TRUNCATED_MARKER;
}

function budgetCompactionSummary(
  summaryBody: string,
  suffix: CompactionSuffix,
  maxChars: number,
  qualityRetention?: SummaryQualityRetention,
) {
  const joined = `${summaryBody}${suffix.text}`;
  // A body that fits still goes through the retention plan when it omits an
  // audited identifier or lets an audit section outgrow its cap; both would
  // re-distill into the next summary otherwise.
  const retentionPlan = qualityRetention
    ? createSummaryQualityRetentionPlan(summaryBody, SUMMARY_TRUNCATED_MARKER, qualityRetention)
    : null;
  if (maxChars <= 0 || (joined.length <= maxChars && !retentionPlan?.needsRebuild(maxChars))) {
    return {
      summary: joined,
      structuralSummary: summaryBody,
      bodyBudget: maxChars,
      bodyTrimmed: false,
      suffixTrimmed: false,
    };
  }

  // The fitter must search above the retention minimum, not price an unrelated
  // head cut whose CJK density can exceed a larger candidate that keeps the facts.
  if (retentionPlan && retentionPlan.minimumChars > maxChars) {
    return undefined;
  }

  const bodyCapacity = retentionPlan ? maxChars : summaryBody.length;
  const bodyFloor = Math.min(
    bodyCapacity,
    maxChars,
    Math.max(1, Math.ceil(maxChars / 2), retentionPlan?.minimumChars ?? 0),
  );
  const suffixReservation = Math.min(suffix.text.length, maxChars);
  const bodySlot = Math.min(bodyCapacity, Math.max(bodyFloor, maxChars - suffixReservation));
  const rendered = retentionPlan?.render(bodySlot);
  const cappedBody = rendered?.text ?? capCompactionSummary(summaryBody, bodySlot);
  const suffixBudget = Math.max(0, maxChars - cappedBody.length);
  const cappedSuffix = capCompactionSuffix(suffix, suffixBudget);
  return {
    summary: `${cappedBody}${cappedSuffix}`,
    structuralSummary: cappedBody,
    bodyBudget: bodySlot,
    bodyTrimmed: rendered ? rendered.trimmed : cappedBody.length < summaryBody.length,
    suffixTrimmed: cappedSuffix.length < suffix.text.length,
  };
}

function extractMessageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim();
  }
  return Array.isArray(content)
    ? content
        .flatMap((block) => {
          const text =
            block && typeof block === "object" ? (block as { text?: unknown }).text : undefined;
          return typeof text === "string" && text.trim() ? [text.trim()] : [];
        })
        .join("\n")
    : "";
}

function formatNonTextPlaceholder(content: unknown): string | null {
  if (content == null || typeof content === "string") {
    return null;
  }
  if (!Array.isArray(content)) {
    return "[non-text content]";
  }
  const typeCounts = new Map<string, number>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typeRaw = (block as { type?: unknown }).type;
    const type = typeof typeRaw === "string" && typeRaw.trim().length > 0 ? typeRaw : "unknown";
    if (type === "text") {
      continue;
    }
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }
  return typeCounts.size > 0
    ? `[non-text content: ${Array.from(typeCounts, ([type, count]) =>
        count > 1 ? `${type} x${count}` : type,
      ).join(", ")}]`
    : null;
}

function splitPreservedRecentTurns(params: {
  messages: AgentMessage[];
  recentTurnsPreserve: number;
}): { summarizableMessages: AgentMessage[]; preservedMessages: AgentMessage[] } {
  const preserveTurns = params.recentTurnsPreserve;
  if (preserveTurns <= 0) {
    return { summarizableMessages: params.messages, preservedMessages: [] };
  }
  const conversationIndexes = params.messages.flatMap((message, index) =>
    message.role === "user" || message.role === "assistant" ? [index] : [],
  );
  if (conversationIndexes.length === 0) {
    return { summarizableMessages: params.messages, preservedMessages: [] };
  }

  const userIndexes = conversationIndexes.filter(
    (index) => params.messages[index]?.role === "user",
  );
  const boundaryStartIndex = userIndexes.at(-preserveTurns);
  const preservedIndexSet = new Set(
    boundaryStartIndex === undefined
      ? userIndexes
      : conversationIndexes.filter((index) => index >= boundaryStartIndex),
  );
  if (boundaryStartIndex === undefined) {
    for (const index of conversationIndexes.toReversed()) {
      preservedIndexSet.add(index);
      if (preservedIndexSet.size >= preserveTurns * 2) {
        break;
      }
    }
  }
  const preservedToolCallIds = new Set<string>();
  for (const index of preservedIndexSet) {
    const message = params.messages[index];
    if (message?.role === "assistant") {
      for (const toolCall of extractToolCallsFromAssistant(message)) {
        preservedToolCallIds.add(toolCall.id);
      }
    }
  }
  if (preservedToolCallIds.size > 0) {
    const preservedStartIndex = conversationIndexes.find((index) => preservedIndexSet.has(index))!;
    for (let index = preservedStartIndex; index < params.messages.length; index += 1) {
      const message = params.messages[index];
      if (message?.role !== "toolResult") {
        continue;
      }
      const toolResultId = extractToolResultId(message);
      if (toolResultId && preservedToolCallIds.has(toolResultId)) {
        preservedIndexSet.add(index);
      }
    }
  }
  const summarizableMessages: AgentMessage[] = [];
  const preservedMessages: AgentMessage[] = [];
  for (const [index, message] of params.messages.entries()) {
    (preservedIndexSet.has(index) ? preservedMessages : summarizableMessages).push(message);
  }
  // Preserving recent assistant turns can orphan downstream toolResult messages.
  // Repair pairings here so compaction summarization doesn't trip strict providers.
  return {
    summarizableMessages: repairToolUseResultPairing(summarizableMessages).messages,
    preservedMessages,
  };
}

function formatContextMessage(message: AgentMessage): string | null {
  let roleLabel: string;
  if (message.role === "assistant") {
    roleLabel = "Assistant";
  } else if (message.role === "user") {
    roleLabel = "User";
  } else if (message.role === "toolResult") {
    const toolName = (message as { toolName?: unknown }).toolName;
    const safeToolName = typeof toolName === "string" && toolName.trim() ? toolName : "tool";
    roleLabel = `Tool result (${safeToolName})`;
  } else {
    return null;
  }
  const rendered = [
    extractMessageText(message),
    formatNonTextPlaceholder((message as { content?: unknown }).content),
  ]
    .filter(Boolean)
    .join("\n");
  if (!rendered) {
    return null;
  }
  const trimmed =
    rendered.length > MAX_RECENT_TURN_TEXT_CHARS
      ? `${truncateUtf16Safe(rendered, MAX_RECENT_TURN_TEXT_CHARS)}...`
      : rendered;
  return `- ${roleLabel}: ${trimmed}`;
}

function formatContextSegments(messages: AgentMessage[]): string[] {
  const pairing = classifyToolUseResultPairing(messages);
  // A call-bearing assistant and all occurrence-matched results are one context
  // atom; keeping remainder messages separate lets later terminal text survive.
  const toolSegments = new Map<AgentMessage, AgentMessage[]>(
    pairing.frames.map((frame) => [
      frame.assistant,
      [
        frame.assistant,
        ...frame.occurrences.flatMap((occurrence) =>
          occurrence.sourceResult ? [occurrence.sourceResult] : [],
        ),
      ],
    ]),
  );
  return messages.flatMap((message) => {
    if (message.role === "toolResult") {
      // Paired results render with their assistant message; unclaimed results
      // are unsafe context because their owning call is absent or ambiguous.
      return [];
    }
    const lines = (toolSegments.get(message) ?? [message])
      .map(formatContextMessage)
      .filter((line): line is string => Boolean(line));
    return lines.length > 0 ? [lines.join("\n")] : [];
  });
}

function formatBoundedContextSection(params: {
  messages: AgentMessage[];
  heading: string;
  maxChars: number;
  truncatedMarker: string;
  truncatedLoss: CompactionLoss;
}): ContextSection {
  const segments = formatContextSegments(params.messages);
  if (segments.length === 0) {
    return { text: "", segmentStarts: [] };
  }

  let prefix = `${params.heading}\n`;
  let retained = segments;
  const truncated = !(prefix.length + segments.join("\n").length <= params.maxChars);
  if (truncated) {
    prefix += params.truncatedMarker;
    retained = [];
    let usedChars = prefix.length;
    for (const segment of segments.toReversed()) {
      const segmentChars = segment.length + (retained.length > 0 ? 1 : 0);
      if (usedChars + segmentChars > params.maxChars) {
        break;
      }
      retained.unshift(segment);
      usedChars += segmentChars;
    }
  }
  let offset = prefix.length;
  return {
    text: `${prefix}${retained.join("\n")}`,
    segmentStarts: retained.map((segment) => {
      const start = offset;
      offset += segment.length + 1;
      return start;
    }),
    ...(truncated ? { truncatedLoss: params.truncatedLoss } : {}),
  };
}

function buildPreservedTurnsSection(messages: AgentMessage[]): ContextSection {
  return formatBoundedContextSection({
    messages,
    heading: "\n\n## Recent turns preserved verbatim",
    maxChars: MAX_SPLIT_TURN_CONTEXT_CHARS,
    truncatedMarker: PRESERVED_TURNS_TRUNCATED_MARKER,
    truncatedLoss: "preserved-turn-head",
  });
}

function buildSplitTurnContextSection(messages: AgentMessage[]): ContextSection {
  return formatBoundedContextSection({
    messages,
    heading: "**Turn Context (split turn):**\n",
    maxChars: MAX_SPLIT_TURN_CONTEXT_CHARS,
    truncatedMarker: SPLIT_TURN_TRUNCATED_MARKER,
    truncatedLoss: "split-turn-head",
  });
}

function formatGeneratedSplitTurnSection(summary: string, onTruncated: () => void): string {
  const heading = `${SPLIT_TURN_SECTION_HEADING}\n\n`;
  const summaryBudget = MAX_SPLIT_TURN_CONTEXT_CHARS - heading.length;
  const nestedSummary = nestMarkdownHeadings(summary);
  const cappedSummary = capCompactionSummary(nestedSummary, summaryBudget);
  if (cappedSummary.length < nestedSummary.length) {
    onTruncated();
  }
  return `${heading}${cappedSummary}`;
}

function extractLatestUserAsk(messages: AgentMessage[]): string | null {
  for (const message of messages.toReversed()) {
    if (message.role === "user") {
      const ask = extractMessageText(message);
      if (ask) {
        return ask;
      }
    }
  }
  return null;
}

/** Registers compaction hooks that summarize, preserve recent turns, and audit output quality. */
export default function compactionSafeguardExtension(api: ExtensionAPI): void {
  api.on("session_before_compact", async (event, ctx) => {
    const {
      preparation,
      customInstructions: eventInstructions,
      signal,
      thinkingLevel,
      streamFn,
    } = event;
    const previousSummary = normalizeLegacySplitTurnSummary(preparation.previousSummary?.trim());
    let baseMessagesToSummarize = stripRuntimeContextCustomMessages(
      preparation.messagesToSummarize,
    );
    let baseTurnPrefixMessages = stripRuntimeContextCustomMessages(
      preparation.turnPrefixMessages ?? [],
    );
    const latestUnresolvedUserRequest = preparation.latestUnresolvedUserRequest ?? null;
    if (!containsRealConversation([...baseMessagesToSummarize, ...baseTurnPrefixMessages])) {
      // Safety net for a preparation that dropped real conversation from the
      // range it covers: summarize that boundary-scoped range instead. It is
      // never the raw branch, which re-read every reset and prior compaction.
      const rangeMessages = stripRuntimeContextCustomMessages(
        collectPreparationRangeMessages(ctx.sessionManager, preparation.firstKeptEntryId),
      );
      if (containsRealConversation(rangeMessages)) {
        log.info(
          "Compaction safeguard: summarizing the boundary-scoped preparation range after compaction preparation omitted real conversation content.",
        );
        baseMessagesToSummarize = rangeMessages;
        baseTurnPrefixMessages = [];
      }
    }
    // A prepared window of pure tool traffic is still real work when the current
    // context anchors it (a kept user turn or a prior compaction summary); only a
    // context with no real conversation at all gets the anti-loop boundary below.
    const hasRealConversation =
      containsRealConversation([...baseMessagesToSummarize, ...baseTurnPrefixMessages]) ||
      containsRealConversation(
        stripRuntimeContextCustomMessages(
          // Project the current boundary; raw branch history would re-summarize
          // messages hidden by earlier resets and compactions.
          projectBranchEntries(readSessionBranch(ctx.sessionManager)),
        ),
      );
    setCompactionSafeguardCancellation(ctx.sessionManager, undefined);
    const cancelCompaction = (reason: string, error?: unknown) => {
      setCompactionSafeguardCancellation(ctx.sessionManager, reason, error);
      return { cancel: true as const };
    };
    if (!hasRealConversation) {
      // Canceling an empty preparation re-triggers compaction on the next response (#41981).
      // A compaction boundary suppresses immediate retries until another assistant turn.
      log.info(
        "Compaction safeguard: no real conversation messages to summarize; writing compaction boundary to suppress re-trigger loop.",
      );
      const fallbackSummary = buildStructuredFallbackSummary(previousSummary);
      return {
        compaction: {
          summary: fallbackSummary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
        },
      };
    }
    const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
    const fileOpsSummary = formatFileOperations(readFiles, modifiedFiles);
    const toolFailures = collectToolFailures([
      ...baseMessagesToSummarize,
      ...baseTurnPrefixMessages,
    ]);
    const toolFailureSection = formatToolFailuresSection(toolFailures);

    // Model resolution: ctx.model is undefined in compact.ts workflow (extensionRunner.initialize() is never called).
    // Fall back to runtime.model which is explicitly passed when building extension paths.
    const runtime = getCompactionSafeguardRuntime(ctx.sessionManager);
    const customInstructions = resolveCompactionInstructions(
      eventInstructions,
      runtime?.customInstructions,
    );
    const summarizationInstructions = {
      identifierPolicy: runtime?.identifierPolicy,
      identifierInstructions: runtime?.identifierInstructions,
    };
    const identifierPolicy = runtime?.identifierPolicy ?? "strict";
    const qualityGuardEnabled = runtime?.qualityGuardEnabled ?? false;
    const providerId = runtime?.provider;
    const turnPrefixMessages = baseTurnPrefixMessages;
    const recentTurnsPreserve = resolveRecentTurnsPreserve(runtime?.recentTurnsPreserve);
    const structuredInstructions = buildCompactionStructureInstructions(
      customInstructions,
      summarizationInstructions,
      latestUnresolvedUserRequest ?? undefined,
    );
    let workspaceContextPromise: Promise<string> | undefined;
    const finalizeSummaryText = async (
      body: string,
      sections: {
        splitTurnSection?: ContextSection;
        generatedSplitTurnSection?: string;
        preservedTurnsSection?: ContextSection;
      },
      producerLosses: ReadonlySet<CompactionLoss> = new Set(),
      qualityRetention?: SummaryQualityRetention,
      // Lossy recovery reserves the active split turn before older preserved turns.
      degraded = false,
    ) => {
      workspaceContextPromise ??= readWorkspaceContextForSummary(
        runtime?.postCompactionSections,
        runtime?.workspaceDir,
      );
      const suffix = assembleSuffix(
        {
          splitTurnSection: sections.splitTurnSection,
          generatedSplitTurnSection: sections.generatedSplitTurnSection,
          preservedTurnsSection: sections.preservedTurnsSection,
          toolFailureSection,
          fileOpsSummary,
          workspaceContext: await workspaceContextPromise,
        },
        degraded,
      );
      const fit = (retention?: SummaryQualityRetention) =>
        fitCompactionSummary(preparation.summaryTokenBudget, (maxChars) =>
          budgetCompactionSummary(body, suffix, maxChars, retention),
        );
      let fitted = fit(qualityRetention);
      const losses = new Set(producerLosses);
      const qualityRetentionInfeasible = !fitted.ok && Boolean(qualityRetention);
      if (qualityRetention && !fitted.ok) {
        // The request context is bounded; identifiers are not. Shed the longest
        // identifiers first so one oversized URL cannot take the request with it.
        const { identifiers } = qualityRetention;
        const byLength = identifiers.toSorted((left, right) => left.length - right.length);
        for (let kept = byLength.length - 1; kept >= 0 && !fitted.ok; kept -= 1) {
          const keep = new Set(byLength.slice(0, kept));
          fitted = fit({
            ...qualityRetention,
            identifiers: identifiers.filter((identifier) => keep.has(identifier)),
          });
        }
        losses.add(fitted.ok ? "identifier-retention" : "quality-retention");
        if (!fitted.ok) {
          fitted = fit();
        }
      }
      if (!fitted.ok) {
        throw fitted.error;
      }
      const finalized = fitted.value;
      for (const section of Object.values(sections)) {
        if (typeof section !== "string" && section?.truncatedLoss) {
          losses.add(section.truncatedLoss);
        }
      }
      if (finalized.bodyTrimmed) {
        losses.add("summary-tail");
      }
      if (finalized.suffixTrimmed) {
        losses.add("suffix-head");
      }
      if (losses.size > 0) {
        log.warn(
          `Compaction safeguard: finalized artifact truncated; loss=${[...losses].join(",")}`,
        );
      }
      return { ...finalized, qualityRetentionInfeasible };
    };
    const compactionResult = (summary: string, provenance?: { qualityDegraded: true }) => ({
      compaction: {
        summary,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        details: {
          readFiles,
          modifiedFiles,
          ...(latestUnresolvedUserRequest ? { latestUnresolvedUserRequest } : {}),
          ...provenance,
        },
      },
    });
    if (providerId) {
      const compactionProvider: CompactionProvider | undefined = getCompactionProvider(providerId);
      if (compactionProvider) {
        try {
          // Give the provider ALL messages — no pruning, no chunking, no split-turn splitting.
          const providerResult = await compactionProvider.summarize({
            messages: [...baseMessagesToSummarize, ...turnPrefixMessages],
            signal,
            customInstructions: structuredInstructions,
            summarizationInstructions,
            previousSummary,
          });
          if (typeof providerResult === "string" && providerResult.trim()) {
            const { preservedMessages } = splitPreservedRecentTurns({
              messages: baseMessagesToSummarize,
              recentTurnsPreserve,
            });
            const finalized = await finalizeSummaryText(providerResult, {
              splitTurnSection: preparation.isSplitTurn
                ? buildSplitTurnContextSection(turnPrefixMessages)
                : undefined,
              preservedTurnsSection: buildPreservedTurnsSection(preservedMessages),
            });
            return compactionResult(finalized.summary);
          }
          log.warn(
            `Compaction provider "${compactionProvider.id}" returned empty result, falling back to LLM.`,
          );
        } catch (err) {
          // Escaped hook errors fall through to raw core compaction. Keep provider-local
          // failures in the audited fallback unless the caller aborted.
          if (signal?.aborted) {
            throw err;
          }
          log.warn(
            `Compaction provider "${compactionProvider.id}" failed, falling back to LLM: ${formatErrorMessage(err)}`,
          );
        }
      } else {
        log.warn(
          `Compaction provider "${providerId}" is configured but not registered. Falling back to LLM.`,
        );
      }
    }

    const model = ctx.model ?? runtime?.model;
    if (!model) {
      if (!missedModelWarningSessions.has(ctx.sessionManager)) {
        missedModelWarningSessions.add(ctx.sessionManager);
        log.warn(
          "[compaction-safeguard] Both ctx.model and runtime.model are undefined. " +
            "Compaction summarization will not run. This indicates extensionRunner.initialize() " +
            "was not called and model was not passed through runtime registry.",
        );
      }
      return cancelCompaction("Compaction safeguard could not resolve a summarization model.");
    }

    const authResult = await resolveModelAuth(ctx, model);
    if (!authResult.ok) {
      return cancelCompaction(authResult.reason);
    }
    try {
      const headers = buildCompactionSummaryHeaders({
        model,
        messages: baseMessagesToSummarize,
        headers: authResult.headers,
      });
      const usageSink: SessionModelUsageSink = (usage) =>
        recordSessionModelUsage(ctx.sessionManager, usage);
      const llmSummaryParams = {
        model,
        apiKey: authResult.apiKey ?? "",
        headers,
        signal,
        reserveTokens: resolveSummaryReserveTokens(preparation.settings.reserveTokens, model),
        summarizationInstructions,
        thinkingLevel,
        streamFn,
        usageSink,
      };
      const qualityGuardMaxRetries = resolveQualityGuardMaxRetries(runtime?.qualityGuardMaxRetries);

      const oracleMessages = [...baseMessagesToSummarize, ...turnPrefixMessages];
      const splitUserAsk = preparation.isSplitTurn
        ? extractLatestUserAsk(turnPrefixMessages)
        : null;
      const latestUserAsk = splitUserAsk ?? extractLatestUserAsk(baseMessagesToSummarize);
      const identifiers = extractOpaqueIdentifiers(
        oracleMessages.slice(-10).map(extractMessageText).filter(Boolean).join("\n"),
      );
      const {
        summarizableMessages: summaryTargetMessages,
        preservedMessages: preservedRecentMessages,
      } = splitPreservedRecentTurns({
        messages: baseMessagesToSummarize,
        recentTurnsPreserve,
      });
      const preservedTurnsSectionLocal = buildPreservedTurnsSection(preservedRecentMessages);
      const latestPreparedAsk = extractLatestUserAsk(baseMessagesToSummarize);
      const requiredAskContext = formatRequiredAskContext(latestUserAsk ?? "");
      const includePreservedContext =
        !latestUnresolvedUserRequest &&
        qualityGuardEnabled &&
        latestPreparedAsk === latestUserAsk &&
        !preservedTurnsSectionLocal.text.includes(requiredAskContext);
      // Retained excerpts supplement the handoff; they cannot update an older decision
      // by themselves. Reconcile the complete prepared window whenever there is a
      // summary to update or non-preserved/split-turn work to summarize.
      const reconciliationMessages =
        previousSummary ||
        includePreservedContext ||
        summaryTargetMessages.length > 0 ||
        turnPrefixMessages.length > 0
          ? oracleMessages
          : [];

      let correctiveInstructions = "";
      const totalAttempts = qualityGuardEnabled ? qualityGuardMaxRetries + 1 : 1;
      let bestSummary: { summary: string; reasonCount: number } | undefined;
      const degrade = (summary: string, diagnostic: string) => {
        log.warn(
          `Compaction safeguard: ${diagnostic}; using degraded summary; ` +
            "reasonCode=quality_guard_degraded_fallback",
        );
        return compactionResult(summary, { qualityDegraded: true });
      };

      for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
        let splitTurnSectionLocal = "";
        let splitTurnSummaryLocal = "";
        let historySummary = "";
        const producerLosses = new Set<CompactionLoss>();
        try {
          historySummary =
            reconciliationMessages.length > 0
              ? await compactionSafeguardDeps.summarizeCompactionHistory({
                  ...llmSummaryParams,
                  messages: reconciliationMessages,
                  summaryPrompt: { kind: "custom", instructions: structuredInstructions },
                  customInstructions: correctiveInstructions,
                  previousSummary,
                })
              : buildStructuredFallbackSummary(previousSummary);

          if (preparation.isSplitTurn && turnPrefixMessages.length > 0) {
            const splitTurnFocusLabel = "Additional context from /compact";
            const splitTurnFocus = wrapUntrustedInstructionBlock(
              splitTurnFocusLabel,
              customInstructions,
            );
            const prefixSummary = await compactionSafeguardDeps.summarizeCompactionHistory({
              ...llmSummaryParams,
              messages: turnPrefixMessages,
              summaryPrompt: { kind: "turn-prefix" },
              customInstructions: [splitTurnFocus, correctiveInstructions]
                .filter(Boolean)
                .join("\n\n"),
              previousSummary: undefined,
            });
            splitTurnSummaryLocal = prefixSummary;
            splitTurnSectionLocal = formatGeneratedSplitTurnSection(prefixSummary, () => {
              producerLosses.add("split-turn-tail");
            });
          }
        } catch (attemptError) {
          if (signal?.aborted) {
            signal.throwIfAborted();
          }
          if (bestSummary) {
            return degrade(
              bestSummary.summary,
              `corrective generation failed; attempt=${attempt + 1}`,
            );
          }
          throw attemptError;
        }
        const unbudgetedSummary = appendSummarySection(
          historySummary,
          splitTurnSectionLocal ? `\n\n${splitTurnSectionLocal}` : "",
        );
        const structuralSummary = qualityGuardEnabled ? historySummary : unbudgetedSummary;
        const finalized = await finalizeSummaryText(
          structuralSummary,
          {
            generatedSplitTurnSection:
              qualityGuardEnabled && splitTurnSectionLocal
                ? `\n\n${splitTurnSectionLocal}`
                : undefined,
            preservedTurnsSection: preservedTurnsSectionLocal,
          },
          producerLosses,
          qualityGuardEnabled
            ? {
                auditSummary: unbudgetedSummary,
                identifiers,
                latestAsk: latestUserAsk,
                latestAskInRetainedTurn: splitUserAsk !== null,
                latestUnresolvedUserRequest: latestUnresolvedUserRequest ?? undefined,
                requiredAskContext,
                identifierPolicy,
              }
            : undefined,
        );

        if (!qualityGuardEnabled) {
          return compactionResult(finalized.summary);
        }
        const quality = auditSummaryQuality({
          summary: finalized.summary,
          structuralSummary: finalized.structuralSummary,
          sourceSummaries: [historySummary, splitTurnSummaryLocal].filter(Boolean),
          identifiers,
          latestAsk: latestUserAsk,
          latestUnresolvedUserRequest: latestUnresolvedUserRequest ?? undefined,
          retainedTurnSummary: splitUserAsk !== null ? splitTurnSummaryLocal : undefined,
          identifierPolicy,
        });
        if (quality.ok && !finalized.qualityRetentionInfeasible) {
          return compactionResult(finalized.summary);
        }
        const reasonCount = quality.reasons.length + Number(finalized.qualityRetentionInfeasible);
        if (!bestSummary || reasonCount < bestSummary.reasonCount) {
          // Keep generated facts even when their formatting fails the audit. The
          // previous summary is only a fallback for an empty generated body.
          const recovered = await finalizeSummaryText(
            buildStructuredFallbackSummary(historySummary.trim() || previousSummary),
            {
              generatedSplitTurnSection: splitTurnSectionLocal
                ? `\n\n${splitTurnSectionLocal}`
                : undefined,
              preservedTurnsSection: preservedTurnsSectionLocal,
            },
            producerLosses,
            {
              identifiers,
              latestAsk: latestUserAsk,
              latestAskInRetainedTurn: splitUserAsk !== null,
              latestUnresolvedUserRequest: latestUnresolvedUserRequest ?? undefined,
              requiredAskContext,
              identifierPolicy,
            },
            true,
          );
          bestSummary = { summary: recovered.summary, reasonCount };
        }
        if (finalized.qualityRetentionInfeasible) {
          return degrade(
            bestSummary.summary,
            "required quality facts exceed finalized artifact budget",
          );
        }
        if (reconciliationMessages.length === 0 || attempt >= totalAttempts - 1) {
          const reasonCodes = [
            ...new Set(quality.reasons.map((reason) => reason.split(":", 1)[0])),
          ];
          return degrade(
            bestSummary.summary,
            "final quality attempt failed; " +
              `reasonCodes=${reasonCodes.join(",")} reasonCount=${quality.reasons.length}`,
          );
        }
        const reasons = quality.reasons.join(", ");
        const qualityFeedbackInstruction =
          identifierPolicy === "strict"
            ? "Fix all issues and include every required section with exact identifiers preserved."
            : "Fix all issues and include every required section while following the configured identifier policy.";
        const budgetInstruction = `Keep the complete summary body within ${finalized.bodyBudget} UTF-16 code units so the finalized artifact remains valid after required suffixes.`;
        const qualityFeedbackReasons = wrapUntrustedInstructionBlock(
          "Quality check feedback",
          `Previous summary failed quality checks (${reasons}).`,
        );
        correctiveInstructions = qualityFeedbackReasons
          ? `${qualityFeedbackInstruction}\n${budgetInstruction}\n\n${qualityFeedbackReasons}`
          : `${qualityFeedbackInstruction}\n${budgetInstruction}`;
      }

      throw new Error("Compaction safeguard exhausted summary attempts without a decision.");
    } catch (error) {
      // Caller cancellation is terminal, not a safeguard failure. Preserve the
      // original abort so the runner can classify it without a false data-loss warning.
      if (signal?.aborted) {
        signal.throwIfAborted();
      }
      const message = formatErrorMessage(error);
      log.warn(
        `Compaction summarization failed; cancelling compaction to preserve history: ${message}`,
      );
      return cancelCompaction(
        `Compaction safeguard could not summarize the session: ${message}`,
        error,
      );
    }
  });
}

const testing = {
  setSummarizeCompactionHistoryForTest(next?: typeof summarizeCompactionHistory) {
    compactionSafeguardDeps.summarizeCompactionHistory = next ?? summarizeCompactionHistory;
  },
  splitPreservedRecentTurns,
  buildPreservedTurnsSection,
  buildCompactionStructureInstructions,
  resolveRecentTurnsPreserve,
  resolveQualityGuardMaxRetries,
  extractOpaqueIdentifiers,
  auditSummaryQuality,
  capCompactionSummary,
  budgetCompactionSummary,
  formatFileOperations,
  MAX_FILE_OPS_SECTION_CHARS,
  MAX_COMPACTION_SUMMARY_CHARS,
  SUMMARY_TRUNCATED_MARKER,
  CONTEXT_TRUNCATED_MARKER,
  MAX_SPLIT_TURN_CONTEXT_CHARS,
} as const;

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.compactionSafeguardTestApi")] =
    testing;
}
