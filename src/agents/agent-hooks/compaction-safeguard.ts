/** Extension that safeguards compaction with structured summaries and quality repair. */

import fs from "node:fs";
import path from "node:path";
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  capCompactionSummary,
  fitCompactionSummary,
  MAX_COMPACTION_SUMMARY_CHARS,
  SUMMARY_TRUNCATED_MARKER,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import {
  computeFileLists,
  formatFileOperations,
  MAX_FILE_OPS_LIST_CHARS,
  MAX_FILE_OPS_SECTION_CHARS,
} from "../../../packages/agent-core/src/harness/compaction/utils.js";
import { extractSections } from "../../auto-reply/reply/post-compaction-context.js";
import { evaluateDecision } from "../../decisions/runtime.js";
import { openRootFile } from "../../infra/boundary-file-read.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getCompactionProvider,
  type CompactionProvider,
} from "../../plugins/compaction-provider.js";
import { normalizeAcceptedSessionSpawnResult } from "../accepted-session-spawn.js";
import { computeAdaptiveChunkRatioWithWorker } from "../compaction-planning-worker.js";
import { buildHistoryPrunePlan } from "../compaction-planning.js";
import { isRealConversationMessage } from "../compaction-real-conversation.js";
import {
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  SUMMARIZATION_OVERHEAD_TOKENS,
  computeAdaptiveChunkRatio,
  resolveContextWindowTokens,
  summarizeInStages,
} from "../compaction.js";
import { collectTextContentBlocks } from "../content-blocks.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "../copilot-dynamic-headers.js";
import { stripRuntimeContextCustomMessages } from "../internal-runtime-context.js";
import {
  buildSessionContext as buildCoreSessionContext,
  type AgentMessage,
  type SessionTreeEntry as CoreSessionTreeEntry,
} from "../runtime/index.js";
import type { SessionModelUsageSink } from "../sessions/compaction/runtime.js";
import type { ExtensionAPI, ExtensionContext } from "../sessions/index.js";
import { recordSessionModelUsage } from "../sessions/session-model-usage.js";
import {
  MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
  readWorkspaceBootstrapFile,
} from "../workspace-bootstrap-read.js";
import { resolveCompactionInstructions } from "./compaction-instructions.js";
import {
  prepareActiveCompactionCuration,
  prepareCompactionSummaryInput,
  resolveCuratedCompactionCandidate,
} from "./compaction-safeguard-active-curation.js";
import {
  buildPreservedTurnsSection,
  buildSplitTurnContextSection,
  type CompactionLoss,
  type ContextSection,
  extractLatestUserAsk,
  extractMessageText,
  formatRequiredAskContext,
  MAX_SPLIT_TURN_CONTEXT_CHARS,
  SPLIT_TURN_SECTION_HEADING,
  splitPreservedRecentTurns,
} from "./compaction-safeguard-context.js";
import {
  appendSummarySection,
  auditSummaryQuality,
  buildCompactionStructureInstructions,
  buildStructuredFallbackSummary,
  createSummaryQualityRetentionPlan,
  extractOpaqueIdentifiers,
  nestRequiredSummaryHeadings,
} from "./compaction-safeguard-quality.js";
import {
  getCurrentCompactionSemanticMode,
  getCompactionSafeguardRuntime,
  setCompactionSafeguardCancellation,
} from "./compaction-safeguard-runtime.js";
import {
  evaluateCompactionFidelity,
  evaluateCompactionShadowCuration,
} from "./compaction-safeguard-semantic-decisions.js";
import {
  buildCompactionSemanticSnapshot,
  fingerprint,
  fingerprintCompactionMessages,
} from "./compaction-safeguard-semantic.js";
import { createCompactionSummaryAttemptRuntime } from "./compaction-safeguard-summary-attempt.js";

const log = createSubsystemLogger("compaction-safeguard");

// Track session managers that have already logged the missing-model warning to avoid log spam.
const missedModelWarningSessions = new WeakSet<object>();
const MAX_TOOL_FAILURES = 8;
const MAX_TOOL_FAILURE_CHARS = 240;
const CONTEXT_TRUNCATED_MARKER = "\n\n[Earlier compaction context truncated to fit budget]\n\n";
const DEFAULT_RECENT_TURNS_PRESERVE = 3;
const DEFAULT_QUALITY_GUARD_MAX_RETRIES = 1;
const MAX_RECENT_TURNS_PRESERVE = 12;
const MAX_QUALITY_GUARD_MAX_RETRIES = 3;
const PREVIOUS_SUMMARY_REDISTILL_PREFIX =
  "Previous compaction summary to re-distill with the current conversation. " +
  "Prune stale, duplicate, or superseded details instead of preserving it verbatim.";
const compactionSafeguardDeps = {
  summarizeInStages,
};
function prependPreviousSummaryForRedistill(params: {
  messages: AgentMessage[];
  previousSummary?: string;
}): AgentMessage[] {
  const previousSummary = params.previousSummary?.trim();
  if (!previousSummary) {
    return params.messages;
  }
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `<previous-compaction-summary>\n${PREVIOUS_SUMMARY_REDISTILL_PREFIX}\n\n${previousSummary}\n</previous-compaction-summary>`,
        },
      ],
      timestamp: 0,
    } as AgentMessage,
    ...params.messages,
  ];
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
 * Messages the model currently sees: the last reset/compaction boundary's kept
 * tail plus everything after it. Never the raw branch — that re-reads history
 * behind every boundary and turns one compaction into dozens of model calls.
 */
function collectSessionContextMessages(sessionManager: unknown): AgentMessage[] {
  return projectBranchEntries(readSessionBranch(sessionManager));
}

/**
 * The boundary-scoped range a preparation was meant to cover: everything the
 * current context holds before its kept tail, minus the prior summary message
 * (that is re-distilled separately). Bounded by construction — it can never
 * reach behind the last reset/compaction boundary.
 */
function collectPreparationRangeMessages(
  sessionManager: unknown,
  firstKeptEntryId: string,
): AgentMessage[] {
  const entries = readSessionBranch(sessionManager);
  const firstKeptIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
  if (firstKeptIndex < 0) {
    return [];
  }
  return projectBranchEntries(entries.slice(0, firstKeptIndex)).filter(
    (message) => message.role !== "compactionSummary",
  );
}

function readSessionBranch(sessionManager: unknown): CoreSessionTreeEntry[] {
  try {
    const entries: unknown = (sessionManager as { getBranch?: () => unknown })?.getBranch?.();
    return Array.isArray(entries) ? (entries as CoreSessionTreeEntry[]) : [];
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
 * Summarize via the built-in LLM pipeline (summarizeInStages).
 * Only called when no compaction provider is available or the provider failed.
 */
async function summarizeViaLLM(params: Parameters<typeof summarizeInStages>[0]): Promise<string> {
  // Summarization failure throws CompactionError (b942db4d569b) — there is no
  // degraded-fallback return shape to preserve a previous summary against.
  return await compactionSafeguardDeps.summarizeInStages({
    ...params,
    messages: prependPreviousSummaryForRedistill(params),
    previousSummary: undefined,
  });
}

/**
 * Build the reserved suffix that follows the summary body. Both the provider
 * and LLM paths use this so diagnostic sections survive truncation.
 */
type CompactionSuffix = {
  text: string;
  // Keep producer segment boundaries after later suffix sections are appended;
  // otherwise the final tail cap can split an assistant tool-call/result group.
  contextRanges: Array<{ start: number; end: number; segmentStarts: number[] }>;
};

type SummaryQualityRetention = {
  auditSummary?: string;
  identifiers: string[];
  latestAsk: string | null;
  latestAskInRetainedTurn?: boolean;
  latestUnresolvedUserRequest?: string;
  requiredAskContext: string;
  identifierPolicy: "strict" | "off" | "custom";
};

function assembleSuffix(parts: {
  splitTurnSection?: ContextSection;
  generatedSplitTurnSection?: string;
  preservedTurnsSection?: ContextSection;
  toolFailureSection?: string;
  fileOpsSummary?: string;
  workspaceContext?: string;
}): CompactionSuffix {
  let text = "";
  const contextRanges: CompactionSuffix["contextRanges"] = [];
  for (const part of Object.values(parts)) {
    const section = typeof part === "string" ? part : part?.text;
    if (!section) {
      continue;
    }
    const leadingTrim = text ? 0 : section.length - section.trimStart().length;
    const appended = leadingTrim > 0 ? section.slice(leadingTrim) : section;
    const start = text.length;
    text = appendSummarySection(text, section);
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
    for (const range of contextRanges) {
      range.start += 2;
      range.end += 2;
      range.segmentStarts = range.segmentStarts.map((segmentStart) => segmentStart + 2);
    }
  }
  return { text, contextRanges };
}

type ToolFailure = {
  toolCallId: string;
  toolName: string;
  summary: string;
  meta?: string;
};

type ModelRegistryWithRequestAuthLookup = {
  getApiKeyAndHeaders?: (
    model: NonNullable<ExtensionContext["model"]>,
  ) => Promise<ResolvedRequestAuth>;
};

type ResolvedRequestAuth =
  | {
      ok: true;
      apiKey?: string;
      headers?: Record<string, string>;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * Resolve model credentials. Returns auth details on success or a cancel reason on failure.
 * Extracted to keep the main handler readable when model/auth is conditional.
 */
async function resolveModelAuth(
  ctx: ExtensionContext,
  model: NonNullable<ExtensionContext["model"]>,
): Promise<
  { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; reason: string }
> {
  let requestAuth: ResolvedRequestAuth;
  try {
    const modelRegistry = ctx.modelRegistry as ModelRegistryWithRequestAuthLookup;
    if (typeof modelRegistry.getApiKeyAndHeaders !== "function") {
      throw new Error("model registry auth lookup unavailable");
    }
    requestAuth = await modelRegistry.getApiKeyAndHeaders(model);
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

function clampNonNegativeInt(
  value: unknown,
  fallback: number,
  max = Number.POSITIVE_INFINITY,
): number {
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

function formatToolFailureMeta(details: unknown): string | undefined {
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const record = details as Record<string, unknown>;
  return (
    [
      typeof record.status === "string" && record.status ? `status=${record.status}` : "",
      typeof record.exitCode === "number" && Number.isFinite(record.exitCode)
        ? `exitCode=${record.exitCode}`
        : "",
    ]
      .filter(Boolean)
      .join(" ") || undefined
  );
}

function collectToolFailures(messages: AgentMessage[]): ToolFailure[] {
  const failures: ToolFailure[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (message.role !== "toolResult" || !message.isError) {
      continue;
    }
    const toolResult = message as {
      toolCallId?: unknown;
      toolName?: unknown;
      content?: unknown;
      details?: unknown;
      isError?: unknown;
    };
    // Accepted sessions_spawn launches are successes, not failures, even when a legacy
    // transcript persisted them with isError:true. Mirror the observer's detection
    // (toolName + accepted child-run identity, see embedded-agent-subscribe.handlers.tools)
    // so only real failures stay in the summary and non-spawn tools are never matched by shape.
    if (
      typeof toolResult.toolName === "string" &&
      toolResult.toolName.trim() === "sessions_spawn" &&
      normalizeAcceptedSessionSpawnResult(toolResult)
    ) {
      continue;
    }
    const toolCallId = typeof toolResult.toolCallId === "string" ? toolResult.toolCallId : "";
    if (!toolCallId || seen.has(toolCallId)) {
      continue;
    }
    seen.add(toolCallId);

    const toolName =
      typeof toolResult.toolName === "string" && toolResult.toolName.trim()
        ? toolResult.toolName
        : "tool";
    const meta = formatToolFailureMeta(toolResult.details);
    const failureText =
      collectTextContentBlocks(toolResult.content).join("\n").replace(/\s+/g, " ").trim() ||
      (meta ? "failed" : "failed (no output)");
    const summary =
      failureText.length > MAX_TOOL_FAILURE_CHARS
        ? `${truncateUtf16Safe(failureText, MAX_TOOL_FAILURE_CHARS - 3)}...`
        : failureText;
    failures.push({ toolCallId, toolName, summary, meta });
  }

  return failures;
}

function formatToolFailuresSection(failures: ToolFailure[]): string {
  if (failures.length === 0) {
    return "";
  }
  const lines = failures.slice(0, MAX_TOOL_FAILURES).map((failure) => {
    const meta = failure.meta ? ` (${failure.meta})` : "";
    return `- ${failure.toolName}${meta}: ${failure.summary}`;
  });
  if (failures.length > MAX_TOOL_FAILURES) {
    lines.push(`- ...and ${failures.length - MAX_TOOL_FAILURES} more`);
  }
  return `\n\n## Tool Failures\n${lines.join("\n")}`;
}

function normalizeCompactionSuffix(suffix: string | CompactionSuffix): CompactionSuffix {
  return typeof suffix === "string" ? { text: suffix, contextRanges: [] } : suffix;
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

function capCompactionSuffix(suffixInput: string | CompactionSuffix, maxChars: number): string {
  const suffix = normalizeCompactionSuffix(suffixInput);
  if (suffix.text.length <= maxChars) {
    return suffix.text;
  }
  if (maxChars <= 0) {
    return "";
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
  suffixInput: string | CompactionSuffix,
  maxChars: number,
  qualityRetention?: SummaryQualityRetention,
) {
  const suffix = normalizeCompactionSuffix(suffixInput);
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
      qualityRetentionInfeasible: false,
    };
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
    qualityRetentionInfeasible: retentionPlan !== null && retentionPlan.minimumChars > maxChars,
  };
}

function resolveSummaryReserveTokens(
  requestedReserveTokens: number,
  model: NonNullable<Parameters<typeof summarizeInStages>[0]["model"]>,
): number {
  const requested = Math.max(1, Math.floor(requestedReserveTokens));
  const modelMaxTokens = model.maxTokens;
  if (
    typeof modelMaxTokens !== "number" ||
    !Number.isFinite(modelMaxTokens) ||
    modelMaxTokens <= 0
  ) {
    return requested;
  }
  return Math.max(1, Math.min(requested, Math.floor(modelMaxTokens)));
}

/**
 * Read and format critical workspace context for compaction summary.
 * Uses explicitly configured AGENTS.md section names only.
 * The default "Session Startup" / "Red Lines" pair preserves the legacy
 * "Every Session" / "Safety" fallback.
 * Limited to 2000 chars to avoid bloating the summary.
 */
async function readWorkspaceContextForSummary(
  sectionNames?: string[],
  workspaceDir = process.cwd(),
): Promise<string> {
  const MAX_SUMMARY_CONTEXT_CHARS = 2000;
  if (!Array.isArray(sectionNames) || sectionNames.length === 0) {
    return "";
  }
  const agentsPath = path.join(workspaceDir, "AGENTS.md");

  try {
    const opened = await openRootFile({
      absolutePath: agentsPath,
      rootPath: workspaceDir,
      boundaryLabel: "workspace root",
    });
    if (!opened.ok) {
      return "";
    }

    let content: string;
    try {
      content = await readWorkspaceBootstrapFile(opened.fd);
    } catch (err) {
      if (err instanceof RangeError) {
        log.warn(
          `Ignoring oversized AGENTS.md ${agentsPath}: file exceeds the ${MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES}-byte limit`,
        );
        return "";
      }
      throw err;
    } finally {
      fs.closeSync(opened.fd);
    }
    let sections = extractSections(content, sectionNames);
    if (
      sections.length === 0 &&
      sectionNames.length === 2 &&
      sectionNames.some((name) => name.trim().toLowerCase() === "session startup") &&
      sectionNames.some((name) => name.trim().toLowerCase() === "red lines")
    ) {
      sections = extractSections(content, ["Every Session", "Safety"]);
    }

    if (sections.length === 0) {
      return "";
    }

    const combined = sections.join("\n\n");
    const safeContent =
      combined.length > MAX_SUMMARY_CONTEXT_CHARS
        ? `${truncateUtf16Safe(combined, MAX_SUMMARY_CONTEXT_CHARS)}\n...[truncated]...`
        : combined;

    return `\n\n<workspace-critical-rules>\n${safeContent}\n</workspace-critical-rules>`;
  } catch {
    return "";
  }
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
        stripRuntimeContextCustomMessages(collectSessionContextMessages(ctx.sessionManager)),
      );
    setCompactionSafeguardCancellation(ctx.sessionManager, undefined);
    if (!hasRealConversation) {
      // When there are no summarizable messages AND no real turn-prefix content,
      // cancelling compaction leaves context unchanged but the SDK re-triggers
      // _checkCompaction after every assistant response — creating a cancel loop
      // that blocks cron lanes (#41981).
      //
      // Strategy: always return a minimal compaction result so the SDK writes a
      // boundary entry. The SDK's prepareCompaction() returns undefined when the
      // last entry is a compaction, which blocks immediate re-triggering within
      // the same turn. After a new assistant message arrives, if the SDK triggers
      // compaction again with an empty preparation, we write another boundary —
      // this is bounded to at most one boundary per LLM round-trip, not a tight
      // loop.
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

    const semanticMode = getCurrentCompactionSemanticMode(ctx.sessionManager);
    const semanticTimeoutMs = runtime?.semanticCurationTimeoutMs;
    const semanticAgentId = ctx.sessionManager.getSessionTarget()?.agentId ?? runtime?.agentId;
    const semanticSignal = signal ?? new AbortController().signal;
    const semanticSourceMessages = [...baseMessagesToSummarize, ...turnPrefixMessages];
    const semanticSnapshot =
      semanticMode === "shadow"
        ? (() => {
            const { preservedMessages } = splitPreservedRecentTurns({
              messages: baseMessagesToSummarize,
              recentTurnsPreserve,
            });
            const semanticLatestAsk =
              (preparation.isSplitTurn ? extractLatestUserAsk(turnPrefixMessages) : null) ??
              extractLatestUserAsk(baseMessagesToSummarize);
            const semanticIdentifiers = extractOpaqueIdentifiers(
              semanticSourceMessages.slice(-10).map(extractMessageText).filter(Boolean).join("\n"),
            );
            return buildCompactionSemanticSnapshot({
              messages: semanticSourceMessages,
              protectedMessages: new Set(preservedMessages),
              turnPrefixMessages: new Set(turnPrefixMessages),
              identifiers: semanticIdentifiers,
              latestUnresolvedUserRequest,
              latestUserAsk: semanticLatestAsk,
            });
          })()
        : undefined;
    const observeSemanticSummary = async (summary: string) => {
      if (!semanticSnapshot || getCurrentCompactionSemanticMode(ctx.sessionManager) !== "shadow") {
        return;
      }
      if (getCurrentCompactionSemanticMode(ctx.sessionManager) !== "shadow") {
        return;
      }
      try {
        const [shadowResult, fidelityResult] = await Promise.allSettled([
          evaluateCompactionShadowCuration({
            runtime: { evaluate: evaluateDecision },
            agentId: semanticAgentId,
            snapshot: semanticSnapshot,
            signal: semanticSignal,
            timeoutMs: semanticTimeoutMs,
            isEligible: () => getCurrentCompactionSemanticMode(ctx.sessionManager) === "shadow",
          }),
          evaluateCompactionFidelity({
            runtime: { evaluate: evaluateDecision },
            agentId: semanticAgentId,
            snapshot: semanticSnapshot,
            candidateSummary: summary,
            signal: semanticSignal,
            timeoutMs: semanticTimeoutMs,
            isEligible: () => getCurrentCompactionSemanticMode(ctx.sessionManager) === "shadow",
          }),
        ]);
        semanticSignal.throwIfAborted();
        if (shadowResult.status === "rejected") {
          throw shadowResult.reason;
        }
        if (fidelityResult.status === "rejected") {
          throw fidelityResult.reason;
        }
        const shadow = shadowResult.value;
        const fidelity = fidelityResult.value;
        if (
          getCurrentCompactionSemanticMode(ctx.sessionManager) !== "shadow" ||
          fingerprintCompactionMessages(semanticSourceMessages) !==
            semanticSnapshot.sourceFingerprint ||
          shadow.sourceFingerprint !== semanticSnapshot.sourceFingerprint ||
          fidelity.sourceFingerprint !== semanticSnapshot.sourceFingerprint ||
          fidelity.candidateFingerprint !== fingerprint(summary)
        ) {
          log.info("Compaction semantic observation discarded because its source or mode changed.");
          return;
        }
        if (shadow.status === "ok") {
          log.info(
            "Compaction semantic shadow: " +
              `segments=${semanticSnapshot.segments.length} evaluated=${shadow.evaluatedSegmentIds.length} ` +
              `excluded=${shadow.excludedSegmentIds.length} uncertain=${shadow.uncertainSegmentIds.length} ` +
              `sourceChars=${shadow.originalChars} selectedChars=${shadow.selectedChars} ` +
              `reduction=${(shadow.reductionRatio * 100).toFixed(1)}% complete=${shadow.complete} ` +
              `provider=${shadow.provenance.providerId}`,
          );
        } else {
          log.info(
            `Compaction semantic shadow unavailable: status=${shadow.status} reason=${shadow.reason}`,
          );
        }
        if (fidelity.status === "ok") {
          const counts = fidelity.assessments.reduce<Record<string, number>>((acc, assessment) => {
            acc[assessment.classification] = (acc[assessment.classification] ?? 0) + 1;
            return acc;
          }, {});
          log.info(
            "Compaction semantic fidelity: " +
              `preserved=${counts.preserved ?? 0} missing=${counts.missing ?? 0} ` +
              `contradicted=${counts.contradicted ?? 0} uncertain=${counts.uncertain ?? 0} ` +
              `provider=${fidelity.provenance.providerId}`,
          );
        } else {
          log.info(
            `Compaction semantic fidelity unavailable: status=${fidelity.status} reason=${fidelity.reason}`,
          );
        }
      } catch (err) {
        if (semanticSignal.aborted) {
          semanticSignal.throwIfAborted();
        }
        log.warn(
          `Compaction semantic observation failed without changing compaction behavior: ${formatErrorMessage(err)}`,
        );
      }
    };
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
    ) => {
      workspaceContextPromise ??= readWorkspaceContextForSummary(
        runtime?.postCompactionSections,
        runtime?.workspaceDir,
      );
      const suffix = assembleSuffix({
        splitTurnSection: sections.splitTurnSection,
        generatedSplitTurnSection: sections.generatedSplitTurnSection,
        preservedTurnsSection: sections.preservedTurnsSection,
        toolFailureSection,
        fileOpsSummary,
        workspaceContext: await workspaceContextPromise,
      });
      const fitted = fitCompactionSummary(preparation.summaryTokenBudget, (maxChars) =>
        budgetCompactionSummary(body, suffix, maxChars, qualityRetention),
      );
      if (!fitted.ok) {
        throw fitted.error;
      }
      const finalized = fitted.value;
      const losses = new Set(producerLosses);
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
      return finalized;
    };
    const compactionResult = (summary: string) => {
      semanticSignal.throwIfAborted();
      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: {
            readFiles,
            modifiedFiles,
            ...(latestUnresolvedUserRequest ? { latestUnresolvedUserRequest } : {}),
          },
        },
      };
    };
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
            const producerLosses = new Set<CompactionLoss>();
            const finalized = await finalizeSummaryText(
              providerResult,
              {
                splitTurnSection: preparation.isSplitTurn
                  ? buildSplitTurnContextSection(turnPrefixMessages, () => {
                      producerLosses.add("split-turn-head");
                    })
                  : undefined,
                preservedTurnsSection: buildPreservedTurnsSection(preservedMessages),
              },
              producerLosses,
            );
            await observeSemanticSummary(finalized.summary);
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
      if (!ctx.model && !runtime?.model && !missedModelWarningSessions.has(ctx.sessionManager)) {
        missedModelWarningSessions.add(ctx.sessionManager);
        log.warn(
          "[compaction-safeguard] Both ctx.model and runtime.model are undefined. " +
            "Compaction summarization will not run. This indicates extensionRunner.initialize() " +
            "was not called and model was not passed through runtime registry.",
        );
      }
      setCompactionSafeguardCancellation(
        ctx.sessionManager,
        "Compaction safeguard could not resolve a summarization model.",
      );
      return { cancel: true };
    }

    const authResult = await resolveModelAuth(ctx, model);
    if (!authResult.ok) {
      setCompactionSafeguardCancellation(ctx.sessionManager, authResult.reason);
      return { cancel: true };
    }
    try {
      const modelContextWindow = resolveContextWindowTokens(model);
      const contextWindowTokens = runtime?.contextWindowTokens ?? modelContextWindow;
      let messagesToSummarize = baseMessagesToSummarize;
      const headers = buildCompactionSummaryHeaders({
        model,
        messages: messagesToSummarize,
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
        contextWindow: contextWindowTokens,
        summarizationInstructions,
        thinkingLevel,
        streamFn,
        usageSink,
      };
      const qualityGuardMaxRetries = resolveQualityGuardMaxRetries(runtime?.qualityGuardMaxRetries);

      const maxHistoryShare = runtime?.maxHistoryShare ?? 0.5;

      const tokensBefore =
        typeof preparation.tokensBefore === "number" && Number.isFinite(preparation.tokensBefore)
          ? preparation.tokensBefore
          : undefined;

      let droppedSummary: string | undefined;

      if (tokensBefore !== undefined) {
        const prunePlan = buildHistoryPrunePlan({
          messagesToSummarize,
          turnPrefixMessages,
          tokensBefore,
          contextWindowTokens,
          maxHistoryShare,
          parts: 2,
        });
        const { newContentTokens, maxHistoryTokens, pruned } = prunePlan;

        if (newContentTokens > maxHistoryTokens && pruned) {
          if (pruned.droppedChunks > 0) {
            const newContentRatio = (newContentTokens / contextWindowTokens) * 100;
            log.warn(
              `Compaction safeguard: new content uses ${newContentRatio.toFixed(
                1,
              )}% of context; dropped ${pruned.droppedChunks} older chunk(s) ` +
                `(${pruned.droppedMessages} messages) to fit history budget.`,
            );
            messagesToSummarize = pruned.messages;

            // Summarize dropped messages so context isn't lost
            if (pruned.droppedMessagesList.length > 0) {
              try {
                const droppedChunkRatio = await computeAdaptiveChunkRatioWithWorker({
                  messages: pruned.droppedMessagesList,
                  contextWindow: contextWindowTokens,
                  signal,
                });
                const droppedMaxChunkTokens = Math.max(
                  1,
                  Math.floor(contextWindowTokens * droppedChunkRatio) -
                    SUMMARIZATION_OVERHEAD_TOKENS,
                );
                droppedSummary = await summarizeViaLLM({
                  ...llmSummaryParams,
                  messages: pruned.droppedMessagesList,
                  maxChunkTokens: droppedMaxChunkTokens,
                  summaryPrompt: { kind: "custom", instructions: structuredInstructions },
                  previousSummary,
                });
              } catch (droppedError) {
                if (signal?.aborted) {
                  signal.throwIfAborted();
                }
                throw new Error("Failed to summarize dropped messages.", {
                  cause: droppedError,
                });
              }
            }
          }
        }
      }

      const uncuratedSemanticSource = messagesToSummarize;
      const oracleMessages = [...uncuratedSemanticSource, ...turnPrefixMessages];
      const splitUserAsk = preparation.isSplitTurn
        ? extractLatestUserAsk(turnPrefixMessages)
        : null;
      const latestUserAsk = splitUserAsk ?? extractLatestUserAsk(uncuratedSemanticSource);
      const identifiers = extractOpaqueIdentifiers(
        oracleMessages.slice(-10).map(extractMessageText).filter(Boolean).join("\n"),
      );
      const requiredAskContext = formatRequiredAskContext(latestUserAsk ?? "");

      const activeCuration = await prepareActiveCompactionCuration({
        sessionManager: ctx.sessionManager,
        agentId: semanticAgentId,
        mode: semanticMode,
        sourceMessages: uncuratedSemanticSource,
        recentTurnsPreserve,
        identifiers,
        latestUnresolvedUserRequest,
        latestUserAsk,
        signal: semanticSignal,
        timeoutMs: semanticTimeoutMs,
      });
      if (activeCuration.applied) {
        log.info(
          "Compaction semantic curation applied: " +
            `sourceMessages=${activeCuration.applied.sourceMessages} ` +
            `selectedMessages=${activeCuration.applied.selectedMessages} ` +
            `sourceChars=${activeCuration.applied.originalChars} ` +
            `selectedChars=${activeCuration.applied.selectedChars} ` +
            `reduction=${(activeCuration.applied.reductionRatio * 100).toFixed(1)}% ` +
            `provider=${activeCuration.applied.providerId}`,
        );
      } else if (semanticMode === "apply" && activeCuration.skippedReason) {
        log.info(`Compaction semantic curation skipped: ${activeCuration.skippedReason}`);
      }
      messagesToSummarize = activeCuration.messages;

      const preparedSummaryInput = prepareCompactionSummaryInput({
        sourceMessages: messagesToSummarize,
        recentTurnsPreserve,
        qualityGuardEnabled,
        latestUnresolvedUserRequest,
        latestUserAsk,
        requiredAskContext,
      });
      messagesToSummarize = preparedSummaryInput.messages;
      const preservedTurnsSectionLocal = preparedSummaryInput.preservedTurnsSection;
      // Feed dropped-messages summary as previousSummary so the main summarization
      // incorporates context from pruned messages instead of losing it entirely.
      const effectivePreviousSummary = droppedSummary ?? previousSummary;

      const summaryRuntime = createCompactionSummaryAttemptRuntime({
        signal,
        contextWindowTokens,
        turnPrefixMessages,
        isSplitTurn: preparation.isSplitTurn,
        customInstructions,
        structuredInstructions,
        qualityGuardEnabled,
        effectivePreviousSummary,
        identifiers,
        latestUserAsk,
        splitUserAsk,
        latestUnresolvedUserRequest,
        requiredAskContext,
        identifierPolicy,
        summarize: (request) =>
          summarizeViaLLM({
            ...llmSummaryParams,
            ...request,
            headers: buildCompactionSummaryHeaders({
              model,
              messages: request.messages,
              headers: authResult.headers,
            }),
          }),
        finalizeSummaryText,
      });
      const { summarizePreparedInput, auditPreparedSummary } = summaryRuntime;
      let uncuratedFallbackAttempted = false;

      const buildUncuratedSemanticFallback = async (): Promise<string | null> => {
        semanticSignal.throwIfAborted();
        if (!activeCuration.uncuratedMessages || uncuratedFallbackAttempted) {
          return null;
        }
        uncuratedFallbackAttempted = true;
        const fallback = await summaryRuntime.buildUncuratedFallback({
          sourceMessages: activeCuration.uncuratedMessages,
          prepareInput: (sourceMessages) =>
            prepareCompactionSummaryInput({
              sourceMessages,
              recentTurnsPreserve,
              qualityGuardEnabled,
              latestUnresolvedUserRequest,
              latestUserAsk,
              requiredAskContext,
            }),
        });
        semanticSignal.throwIfAborted();
        if (fallback.status !== "ok") {
          log.warn(`Compaction semantic uncurated fallback failed: ${fallback.reason}`);
          return null;
        }
        log.warn("Compaction semantic curation fell back to the uncurated summary input.");
        return fallback.summary;
      };

      const acceptSummary = async (summary: string) => {
        const resolution = await resolveCuratedCompactionCandidate({
          sessionManager: ctx.sessionManager,
          agentId: semanticAgentId,
          snapshot: activeCuration.snapshot,
          uncuratedMessages: activeCuration.uncuratedMessages,
          omittedSegmentIds: activeCuration.omittedSegmentIds,
          summary,
          signal: semanticSignal,
          timeoutMs: semanticTimeoutMs,
          buildUncuratedFallback: buildUncuratedSemanticFallback,
        });
        if (resolution.status === "rejected") {
          log.warn(`Compaction semantic curation rejected candidate: ${resolution.reason}`);
          setCompactionSafeguardCancellation(
            ctx.sessionManager,
            "Compaction semantic curation could not preserve required source meaning.",
          );
          return { cancel: true as const };
        }
        if (resolution.usedFallback) {
          log.warn(
            `Compaction semantic curation fell back to uncurated input: ${resolution.reason}`,
          );
        }
        await observeSemanticSummary(resolution.summary);
        return compactionResult(resolution.summary);
      };

      let correctiveInstructions = "";
      const totalAttempts = qualityGuardEnabled ? qualityGuardMaxRetries + 1 : 1;

      for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
        let candidate: Awaited<ReturnType<typeof summarizePreparedInput>>;
        try {
          candidate = await summarizePreparedInput({
            sourceMessages: messagesToSummarize,
            preservedTurnsSection: preservedTurnsSectionLocal,
            correctiveInstructions,
          });
        } catch (attemptError) {
          if (signal?.aborted) {
            signal.throwIfAborted();
          }
          const fallbackSummary = await buildUncuratedSemanticFallback();
          if (fallbackSummary) {
            return compactionResult(fallbackSummary);
          }
          if (attempt > 0) {
            log.warn(
              "Compaction safeguard: corrective generation failed; " +
                `reasonCode=corrective_generation_failed attempt=${attempt + 1}`,
            );
            setCompactionSafeguardCancellation(
              ctx.sessionManager,
              "Compaction safeguard finalized summary failed quality checks and corrective generation failed.",
            );
            return { cancel: true };
          }
          throw attemptError;
        }

        const { finalized } = candidate;
        const canRegenerate =
          messagesToSummarize.length > 0 ||
          (preparation.isSplitTurn && turnPrefixMessages.length > 0);
        const quality = auditPreparedSummary(candidate);
        if (!qualityGuardEnabled) {
          return await acceptSummary(finalized.summary);
        }
        if (finalized.qualityRetentionInfeasible) {
          const fallbackSummary = await buildUncuratedSemanticFallback();
          if (fallbackSummary) {
            return compactionResult(fallbackSummary);
          }
          log.warn(
            "Compaction safeguard: required quality facts exceed finalized artifact budget; " +
              `requiredChars>${MAX_COMPACTION_SUMMARY_CHARS} identifierCount=${identifiers.length}`,
          );
          setCompactionSafeguardCancellation(
            ctx.sessionManager,
            "Compaction safeguard required facts exceed the finalized summary budget.",
          );
          return { cancel: true };
        }
        if (quality.ok) {
          return await acceptSummary(finalized.summary);
        }
        if (!canRegenerate || attempt >= totalAttempts - 1) {
          const fallbackSummary = await buildUncuratedSemanticFallback();
          if (fallbackSummary) {
            return compactionResult(fallbackSummary);
          }
          const reasonCodes = [
            ...new Set(quality.reasons.map((reason) => reason.split(":", 1)[0])),
          ];
          log.warn(
            "Compaction safeguard: finalized summary failed quality checks; " +
              `reasonCodes=${reasonCodes.join(",")} reasonCount=${quality.reasons.length}`,
          );
          setCompactionSafeguardCancellation(
            ctx.sessionManager,
            "Compaction safeguard finalized summary failed quality checks.",
          );
          return { cancel: true };
        }
        correctiveInstructions = summaryRuntime.buildCorrectiveInstructions({
          audit: quality,
          bodyBudget: finalized.bodyBudget,
        });
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
      setCompactionSafeguardCancellation(
        ctx.sessionManager,
        `Compaction safeguard could not summarize the session: ${message}`,
        error,
      );
      return { cancel: true };
    }
  });
}

const testing = {
  setSummarizeInStagesForTest(next?: typeof summarizeInStages) {
    compactionSafeguardDeps.summarizeInStages = next ?? summarizeInStages;
  },
  collectToolFailures,
  formatToolFailuresSection,
  splitPreservedRecentTurns,
  buildPreservedTurnsSection,
  buildCompactionStructureInstructions,
  buildStructuredFallbackSummary,
  prependPreviousSummaryForRedistill,
  appendSummarySection,
  resolveRecentTurnsPreserve,
  resolveQualityGuardMaxRetries,
  extractOpaqueIdentifiers,
  auditSummaryQuality,
  capCompactionSummary,
  budgetCompactionSummary,
  formatFileOperations,
  computeAdaptiveChunkRatio,
  readWorkspaceContextForSummary,
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  MAX_COMPACTION_SUMMARY_CHARS,
  MAX_FILE_OPS_SECTION_CHARS,
  MAX_FILE_OPS_LIST_CHARS,
  SUMMARY_TRUNCATED_MARKER,
  CONTEXT_TRUNCATED_MARKER,
  MAX_SPLIT_TURN_CONTEXT_CHARS,
} as const;

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.compactionSafeguardTestApi")] =
    testing;
}
