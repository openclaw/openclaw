import fs from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, FileOperations } from "@mariozechner/pi-coding-agent";
import { extractSections } from "../../auto-reply/reply/post-compaction-context.js";
import { openBoundaryFile } from "../../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { extractKeywords, isQueryStopWordToken } from "../../memory/query-expansion.js";
import {
  BASE_CHUNK_RATIO,
  type CompactionSummarizationInstructions,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  SUMMARIZATION_OVERHEAD_TOKENS,
  computeAdaptiveChunkRatio,
  estimateMessagesTokens,
  isOversizedForSummary,
  pruneHistoryForContextShare,
  resolveContextWindowTokens,
  summarizeInStages,
} from "../compaction.js";
import { collectTextContentBlocks } from "../content-blocks.js";
import { wrapUntrustedPromptDataBlock } from "../sanitize-for-prompt.js";
import { repairToolUseResultPairing } from "../session-transcript-repair.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "../tool-call-id.js";
import {
  composeSplitTurnInstructions,
  resolveCompactionInstructions,
} from "./compaction-instructions.js";
import { getCompactionSafeguardRuntime } from "./compaction-safeguard-runtime.js";

const log = createSubsystemLogger("compaction-safeguard");

// Track session managers that have already logged the missing-model warning to avoid log spam.
const missedModelWarningSessions = new WeakSet<object>();
const TURN_PREFIX_INSTRUCTIONS =
  "This summary covers the prefix of a split turn. Focus on the original request," +
  " early progress, and any details needed to understand the retained suffix.";
const MAX_TOOL_FAILURES = 8;
const MAX_TOOL_FAILURE_CHARS = 240;
const MAX_COMPACTION_SUMMARY_CHARS = 16_000;
const MAX_FILE_OPS_SECTION_CHARS = 2_000;
const MAX_FILE_OPS_LIST_CHARS = 900;
const SUMMARY_TRUNCATED_MARKER = "\n\n[Compaction summary truncated to fit budget]";
const DEFAULT_RECENT_TURNS_PRESERVE = 3;
const DEFAULT_QUALITY_GUARD_MAX_RETRIES = 1;
const MAX_RECENT_TURNS_PRESERVE = 12;
const MAX_QUALITY_GUARD_MAX_RETRIES = 3;
const MAX_RECENT_TURN_TEXT_CHARS = 600;
const MAX_EXTRACTED_IDENTIFIERS = 12;
const MAX_UNTRUSTED_INSTRUCTION_CHARS = 4000;
const MAX_ASK_OVERLAP_TOKENS = 12;
const MIN_ASK_OVERLAP_TOKENS_FOR_DOUBLE_MATCH = 3;
const REQUIRED_SUMMARY_SECTIONS = [
  "## Decisions",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  "## Exact identifiers",
] as const;
const STRICT_EXACT_IDENTIFIERS_INSTRUCTION =
  "For ## Exact identifiers, preserve literal values exactly as seen (IDs, URLs, file paths, ports, hashes, dates, times).";
const POLICY_OFF_EXACT_IDENTIFIERS_INSTRUCTION =
  "For ## Exact identifiers, include identifiers only when needed for continuity; do not enforce literal-preservation rules.";

type ToolFailure = {
  toolCallId: string;
  toolName: string;
  summary: string;
  meta?: string;
};

function clampNonNegativeInt(value: unknown, fallback: number): number {
  const normalized = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.floor(normalized));
}

function resolveRecentTurnsPreserve(value: unknown): number {
  return Math.min(
    MAX_RECENT_TURNS_PRESERVE,
    clampNonNegativeInt(value, DEFAULT_RECENT_TURNS_PRESERVE),
  );
}

function resolveQualityGuardMaxRetries(value: unknown): number {
  return Math.min(
    MAX_QUALITY_GUARD_MAX_RETRIES,
    clampNonNegativeInt(value, DEFAULT_QUALITY_GUARD_MAX_RETRIES),
  );
}

function normalizeFailureText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateFailureText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function formatToolFailureMeta(details: unknown): string | undefined {
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const record = details as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status : undefined;
  const exitCode =
    typeof record.exitCode === "number" && Number.isFinite(record.exitCode)
      ? record.exitCode
      : undefined;
  const parts: string[] = [];
  if (status) {
    parts.push(`status=${status}`);
  }
  if (exitCode !== undefined) {
    parts.push(`exitCode=${exitCode}`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function extractToolResultText(content: unknown): string {
  return collectTextContentBlocks(content).join("\n");
}

function collectToolFailures(messages: AgentMessage[]): ToolFailure[] {
  const failures: ToolFailure[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = (message as { role?: unknown }).role;
    if (role !== "toolResult") {
      continue;
    }
    const toolResult = message as {
      toolCallId?: unknown;
      toolName?: unknown;
      content?: unknown;
      details?: unknown;
      isError?: unknown;
    };
    if (toolResult.isError !== true) {
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
    const rawText = extractToolResultText(toolResult.content);
    const meta = formatToolFailureMeta(toolResult.details);
    const normalized = normalizeFailureText(rawText);
    const summary = truncateFailureText(
      normalized || (meta ? "failed" : "failed (no output)"),
      MAX_TOOL_FAILURE_CHARS,
    );
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

function isRealConversationMessage(message: AgentMessage): boolean {
  return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function computeFileLists(fileOps: FileOperations): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).toSorted();
  const modifiedFiles = [...modified].toSorted();
  return { readFiles, modifiedFiles };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  function formatBoundedFileList(tag: string, files: string[], maxChars: number): string {
    if (files.length === 0 || maxChars <= 0) {
      return "";
    }
    const openTag = `<${tag}>\n`;
    const closeTag = `\n</${tag}>`;
    const lines: string[] = [];
    let usedChars = openTag.length + closeTag.length;

    for (let i = 0; i < files.length; i++) {
      const line = `${files[i]}\n`;
      const remaining = files.length - i - 1;
      const overflowLine = remaining > 0 ? `...and ${remaining} more\n` : "";
      const projected = usedChars + line.length + overflowLine.length;
      if (projected > maxChars) {
        const overflow = `...and ${files.length - i} more\n`;
        if (usedChars + overflow.length <= maxChars) {
          lines.push(overflow);
        }
        break;
      }
      lines.push(line);
      usedChars += line.length;
    }

    return lines.length > 0 ? `${openTag}${lines.join("")}${closeTag}` : "";
  }

  const sections: string[] = [];
  const readSection = formatBoundedFileList("read-files", readFiles, MAX_FILE_OPS_LIST_CHARS);
  const modifiedSection = formatBoundedFileList(
    "modified-files",
    modifiedFiles,
    MAX_FILE_OPS_LIST_CHARS,
  );
  if (readSection) {
    sections.push(readSection);
  }
  if (modifiedSection) {
    sections.push(modifiedSection);
  }
  if (sections.length === 0) {
    return "";
  }
  const combined = `\n\n${sections.join("\n\n")}`;
  return capCompactionSummary(combined, MAX_FILE_OPS_SECTION_CHARS);
}

function capCompactionSummary(summary: string, maxChars = MAX_COMPACTION_SUMMARY_CHARS): string {
  if (maxChars <= 0 || summary.length <= maxChars) {
    return summary;
  }
  const marker = SUMMARY_TRUNCATED_MARKER;
  const budget = Math.max(0, maxChars - marker.length);
  if (budget <= 0) {
    // Marker cannot fit; keep body prefix instead of a partial marker fragment.
    return summary.slice(0, maxChars);
  }
  return `${summary.slice(0, budget)}${marker}`;
}

function capCompactionSummaryPreservingSuffix(
  summaryBody: string,
  suffix: string,
  maxChars = MAX_COMPACTION_SUMMARY_CHARS,
): string {
  if (!suffix) {
    return capCompactionSummary(summaryBody, maxChars);
  }
  if (maxChars <= 0) {
    return capCompactionSummary(`${summaryBody}${suffix}`, maxChars);
  }
  if (suffix.length >= maxChars) {
    // Preserve tail (workspace rules, diagnostics) over head (preserved turns).
    return suffix.slice(-maxChars);
  }
  const bodyBudget = Math.max(0, maxChars - suffix.length);
  const cappedBody = capCompactionSummary(summaryBody, bodyBudget);
  return `${cappedBody}${suffix}`;
}

function extractMessageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string" && text.trim().length > 0) {
      parts.push(text.trim());
    }
  }
  return parts.join("\n").trim();
}

function formatNonTextPlaceholder(content: unknown): string | null {
  if (content === null || content === undefined) {
    return null;
  }
  if (typeof content === "string") {
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
  if (typeCounts.size === 0) {
    return null;
  }
  const parts = [...typeCounts.entries()].map(([type, count]) =>
    count > 1 ? `${type} x${count}` : type,
  );
  return `[non-text content: ${parts.join(", ")}]`;
}

function splitPreservedRecentTurns(params: {
  messages: AgentMessage[];
  recentTurnsPreserve: number;
}): { summarizableMessages: AgentMessage[]; preservedMessages: AgentMessage[] } {
  const preserveTurns = Math.min(
    MAX_RECENT_TURNS_PRESERVE,
    clampNonNegativeInt(params.recentTurnsPreserve, 0),
  );
  if (preserveTurns <= 0) {
    return { summarizableMessages: params.messages, preservedMessages: [] };
  }
  const conversationIndexes: number[] = [];
  const userIndexes: number[] = [];
  for (let i = 0; i < params.messages.length; i += 1) {
    const role = (params.messages[i] as { role?: unknown }).role;
    if (role === "user" || role === "assistant") {
      conversationIndexes.push(i);
      if (role === "user") {
        userIndexes.push(i);
      }
    }
  }
  if (conversationIndexes.length === 0) {
    return { summarizableMessages: params.messages, preservedMessages: [] };
  }

  const preservedIndexSet = new Set<number>();
  if (userIndexes.length >= preserveTurns) {
    const boundaryStartIndex = userIndexes[userIndexes.length - preserveTurns] ?? -1;
    if (boundaryStartIndex >= 0) {
      for (const index of conversationIndexes) {
        if (index >= boundaryStartIndex) {
          preservedIndexSet.add(index);
        }
      }
    }
  } else {
    const fallbackMessageCount = preserveTurns * 2;
    for (const userIndex of userIndexes) {
      preservedIndexSet.add(userIndex);
    }
    for (let i = conversationIndexes.length - 1; i >= 0; i -= 1) {
      const index = conversationIndexes[i];
      if (index === undefined) {
        continue;
      }
      preservedIndexSet.add(index);
      if (preservedIndexSet.size >= fallbackMessageCount) {
        break;
      }
    }
  }
  if (preservedIndexSet.size === 0) {
    return { summarizableMessages: params.messages, preservedMessages: [] };
  }
  const preservedToolCallIds = new Set<string>();
  for (let i = 0; i < params.messages.length; i += 1) {
    if (!preservedIndexSet.has(i)) {
      continue;
    }
    const message = params.messages[i];
    const role = (message as { role?: unknown }).role;
    if (role !== "assistant") {
      continue;
    }
    const toolCalls = extractToolCallsFromAssistant(
      message as Extract<AgentMessage, { role: "assistant" }>,
    );
    for (const toolCall of toolCalls) {
      preservedToolCallIds.add(toolCall.id);
    }
  }
  if (preservedToolCallIds.size > 0) {
    let preservedStartIndex = -1;
    for (let i = 0; i < params.messages.length; i += 1) {
      if (preservedIndexSet.has(i)) {
        preservedStartIndex = i;
        break;
      }
    }
    if (preservedStartIndex >= 0) {
      for (let i = preservedStartIndex; i < params.messages.length; i += 1) {
        const message = params.messages[i];
        if ((message as { role?: unknown }).role !== "toolResult") {
          continue;
        }
        const toolResultId = extractToolResultId(
          message as Extract<AgentMessage, { role: "toolResult" }>,
        );
        if (toolResultId && preservedToolCallIds.has(toolResultId)) {
          preservedIndexSet.add(i);
        }
      }
    }
  }
  const summarizableMessages = params.messages.filter((_, idx) => !preservedIndexSet.has(idx));
  // Preserving recent assistant turns can orphan downstream toolResult messages.
  // Repair pairings here so compaction summarization doesn't trip strict providers.
  const repairedSummarizableMessages = repairToolUseResultPairing(summarizableMessages).messages;
  const preservedMessages = params.messages
    .filter((_, idx) => preservedIndexSet.has(idx))
    .filter((msg) => {
      const role = (msg as { role?: unknown }).role;
      return role === "user" || role === "assistant" || role === "toolResult";
    });
  return { summarizableMessages: repairedSummarizableMessages, preservedMessages };
}

function formatPreservedTurnsSection(messages: AgentMessage[]): string {
  if (messages.length === 0) {
    return "";
  }
  const lines = messages
    .map((message) => {
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
      const text = extractMessageText(message);
      const nonTextPlaceholder = formatNonTextPlaceholder(
        (message as { content?: unknown }).content,
      );
      const rendered =
        text && nonTextPlaceholder ? `${text}\n${nonTextPlaceholder}` : text || nonTextPlaceholder;
      if (!rendered) {
        return null;
      }
      const trimmed =
        rendered.length > MAX_RECENT_TURN_TEXT_CHARS
          ? `${rendered.slice(0, MAX_RECENT_TURN_TEXT_CHARS)}...`
          : rendered;
      return `- ${roleLabel}: ${trimmed}`;
    })
    .filter((line): line is string => Boolean(line));
  if (lines.length === 0) {
    return "";
  }
  return `\n\n## Recent turns preserved verbatim\n${lines.join("\n")}`;
}

function wrapUntrustedInstructionBlock(label: string, text: string): string {
  return wrapUntrustedPromptDataBlock({
    label,
    text,
    maxChars: MAX_UNTRUSTED_INSTRUCTION_CHARS,
  });
}

function resolveExactIdentifierSectionInstruction(
  summarizationInstructions?: CompactionSummarizationInstructions,
): string {
  const policy = summarizationInstructions?.identifierPolicy ?? "strict";
  if (policy === "off") {
    return POLICY_OFF_EXACT_IDENTIFIERS_INSTRUCTION;
  }
  if (policy === "custom") {
    const custom = summarizationInstructions?.identifierInstructions?.trim();
    if (custom) {
      const customBlock = wrapUntrustedInstructionBlock(
        "For ## Exact identifiers, apply this operator-defined policy text",
        custom,
      );
      if (customBlock) {
        return customBlock;
      }
    }
  }
  return STRICT_EXACT_IDENTIFIERS_INSTRUCTION;
}

function buildCompactionStructureInstructions(
  customInstructions?: string,
  summarizationInstructions?: CompactionSummarizationInstructions,
): string {
  const identifierSectionInstruction =
    resolveExactIdentifierSectionInstruction(summarizationInstructions);
  const sectionsTemplate = [
    "Produce a compact, factual summary with these exact section headings:",
    ...REQUIRED_SUMMARY_SECTIONS,
    identifierSectionInstruction,
    "Do not omit unresolved asks from the user.",
  ].join("\n");
  const custom = customInstructions?.trim();
  if (!custom) {
    return sectionsTemplate;
  }
  const customBlock = wrapUntrustedInstructionBlock("Additional context from /compact", custom);
  if (!customBlock) {
    return sectionsTemplate;
  }
  // summarizeInStages already wraps custom instructions once with "Additional focus:".
  // Keep this helper label-free to avoid nested/duplicated headers.
  return `${sectionsTemplate}\n\n${customBlock}`;
}

function normalizedSummaryLines(summary: string): string[] {
  return summary
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function hasRequiredSummarySections(summary: string): boolean {
  const lines = normalizedSummaryLines(summary);
  let cursor = 0;
  for (const heading of REQUIRED_SUMMARY_SECTIONS) {
    const index = lines.findIndex((line, lineIndex) => lineIndex >= cursor && line === heading);
    if (index < 0) {
      return false;
    }
    cursor = index + 1;
  }
  return true;
}

function buildStructuredFallbackSummary(
  previousSummary: string | undefined,
  _summarizationInstructions?: CompactionSummarizationInstructions,
): string {
  const trimmedPreviousSummary = previousSummary?.trim() ?? "";
  if (trimmedPreviousSummary && hasRequiredSummarySections(trimmedPreviousSummary)) {
    return trimmedPreviousSummary;
  }
  const exactIdentifiersSummary = "None captured.";
  return [
    "## Decisions",
    trimmedPreviousSummary || "No prior history.",
    "",
    "## Open TODOs",
    "None.",
    "",
    "## Constraints/Rules",
    "None.",
    "",
    "## Pending user asks",
    "None.",
    "",
    "## Exact identifiers",
    exactIdentifiersSummary,
  ].join("\n");
}

function appendSummarySection(summary: string, section: string): string {
  if (!section) {
    return summary;
  }
  if (!summary.trim()) {
    return section.trimStart();
  }
  return `${summary}${section}`;
}

function sanitizeExtractedIdentifier(value: string): string {
  return value
    .trim()
    .replace(/^[("'`[{<]+/, "")
    .replace(/[)\]"'`,;:.!?<>]+$/, "");
}

function isPureHexIdentifier(value: string): boolean {
  return /^[A-Fa-f0-9]{8,}$/.test(value);
}

function normalizeOpaqueIdentifier(value: string): string {
  return isPureHexIdentifier(value) ? value.toUpperCase() : value;
}

function summaryIncludesIdentifier(summary: string, identifier: string): boolean {
  if (isPureHexIdentifier(identifier)) {
    return summary.toUpperCase().includes(identifier.toUpperCase());
  }
  return summary.includes(identifier);
}

function extractOpaqueIdentifiers(text: string): string[] {
  const matches =
    text.match(
      /([A-Fa-f0-9]{8,}|https?:\/\/\S+|\/[\w.-]{2,}(?:\/[\w.-]+)+|[A-Za-z]:\\[\w\\.-]+|[A-Za-z0-9._-]+\.[A-Za-z0-9._/-]+:\d{1,5}|\b\d{6,}\b)/g,
    ) ?? [];
  return Array.from(
    new Set(
      matches
        .map((value) => sanitizeExtractedIdentifier(value))
        .map((value) => normalizeOpaqueIdentifier(value))
        .filter((value) => value.length >= 4),
    ),
  ).slice(0, MAX_EXTRACTED_IDENTIFIERS);
}

function extractLatestUserAsk(messages: AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") {
      continue;
    }
    const text = extractMessageText(message);
    if (text) {
      return text;
    }
  }
  return null;
}

function tokenizeAskOverlapText(text: string): string[] {
  const normalized = text.toLocaleLowerCase().normalize("NFKC").trim();
  if (!normalized) {
    return [];
  }
  const keywords = extractKeywords(normalized);
  if (keywords.length > 0) {
    return keywords;
  }
  return normalized
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function hasAskOverlap(summary: string, latestAsk: string | null): boolean {
  if (!latestAsk) {
    return true;
  }
  const askTokens = Array.from(new Set(tokenizeAskOverlapText(latestAsk))).slice(
    0,
    MAX_ASK_OVERLAP_TOKENS,
  );
  if (askTokens.length === 0) {
    return true;
  }
  const meaningfulAskTokens = askTokens.filter((token) => {
    if (token.length <= 1) {
      return false;
    }
    if (isQueryStopWordToken(token)) {
      return false;
    }
    return true;
  });
  const tokensToCheck = meaningfulAskTokens.length > 0 ? meaningfulAskTokens : askTokens;
  if (tokensToCheck.length === 0) {
    return true;
  }
  const summaryTokens = new Set(tokenizeAskOverlapText(summary));
  let overlapCount = 0;
  for (const token of tokensToCheck) {
    if (summaryTokens.has(token)) {
      overlapCount += 1;
    }
  }
  const requiredMatches = tokensToCheck.length >= MIN_ASK_OVERLAP_TOKENS_FOR_DOUBLE_MATCH ? 2 : 1;
  return overlapCount >= requiredMatches;
}

function auditSummaryQuality(params: {
  summary: string;
  identifiers: string[];
  latestAsk: string | null;
  identifierPolicy?: CompactionSummarizationInstructions["identifierPolicy"];
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const lines = new Set(normalizedSummaryLines(params.summary));
  for (const section of REQUIRED_SUMMARY_SECTIONS) {
    if (!lines.has(section)) {
      reasons.push(`missing_section:${section}`);
    }
  }
  const enforceIdentifiers = (params.identifierPolicy ?? "strict") === "strict";
  if (enforceIdentifiers) {
    const missingIdentifiers = params.identifiers.filter(
      (id) => !summaryIncludesIdentifier(params.summary, id),
    );
    if (missingIdentifiers.length > 0) {
      reasons.push(`missing_identifiers:${missingIdentifiers.slice(0, 3).join(",")}`);
    }
  }
  if (!hasAskOverlap(params.summary, params.latestAsk)) {
    reasons.push("latest_user_ask_not_reflected");
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Read and format critical workspace context for compaction summary.
 * Extracts "Session Startup" and "Red Lines" from AGENTS.md.
 * Falls back to legacy names "Every Session" and "Safety".
 * Limited to 2000 chars to avoid bloating the summary.
 */
async function readWorkspaceContextForSummary(): Promise<string> {
  const MAX_SUMMARY_CONTEXT_CHARS = 2000;
  const workspaceDir = process.cwd();
  const agentsPath = path.join(workspaceDir, "AGENTS.md");

  try {
    const opened = await openBoundaryFile({
      absolutePath: agentsPath,
      rootPath: workspaceDir,
      boundaryLabel: "workspace root",
    });
    if (!opened.ok) {
      return "";
    }

    const content = (() => {
      try {
        return fs.readFileSync(opened.fd, "utf-8");
      } finally {
        fs.closeSync(opened.fd);
      }
    })();
    // Accept legacy section names ("Every Session", "Safety") as fallback
    // for backward compatibility with older AGENTS.md templates.
    let sections = extractSections(content, ["Session Startup", "Red Lines"]);
    if (sections.length === 0) {
      sections = extractSections(content, ["Every Session", "Safety"]);
    }

    if (sections.length === 0) {
      return "";
    }

    const combined = sections.join("\n\n");
    const safeContent =
      combined.length > MAX_SUMMARY_CONTEXT_CHARS
        ? combined.slice(0, MAX_SUMMARY_CONTEXT_CHARS) + "\n...[truncated]..."
        : combined;

    return `\n\n<workspace-critical-rules>\n${safeContent}\n</workspace-critical-rules>`;
  } catch {
    return "";
  }
}

export default function compactionSafeguardExtension(api: ExtensionAPI): void {
  api.on("session_before_compact", async (event, ctx) => {
    const { preparation, customInstructions: eventInstructions, signal } = event;
    if (!preparation.messagesToSummarize.some(isRealConversationMessage)) {
      log.warn(
        "Compaction safeguard: cancelling compaction with no real conversation messages to summarize.",
      );
      return { cancel: true };
    }
    const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
    const fileOpsSummary = formatFileOperations(readFiles, modifiedFiles);
    const toolFailures = collectToolFailures([
      ...preparation.messagesToSummarize,
      ...preparation.turnPrefixMessages,
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
    const model = ctx.model ?? runtime?.model;
    if (!model) {
      // Log warning once per session when both models are missing (diagnostic for future issues).
      // Use a WeakSet to track which session managers have already logged the warning.
      if (!ctx.model && !runtime?.model && !missedModelWarningSessions.has(ctx.sessionManager)) {
        missedModelWarningSessions.add(ctx.sessionManager);
        log.warn(
          "[compaction-safeguard] Both ctx.model and runtime.model are undefined. " +
            "Compaction summarization will not run. This indicates extensionRunner.initialize() " +
            "was not called and model was not passed through runtime registry.",
        );
      }
      return { cancel: true };
    }

    const apiKey = await ctx.modelRegistry.getApiKey(model);
    if (!apiKey) {
      log.warn(
        "Compaction safeguard: no API key available; cancelling compaction to preserve history.",
      );
      return { cancel: true };
    }

    try {
      const modelContextWindow = resolveContextWindowTokens(model);
      const contextWindowTokens = runtime?.contextWindowTokens ?? modelContextWindow;
      const turnPrefixMessages = preparation.turnPrefixMessages ?? [];
      let messagesToSummarize = preparation.messagesToSummarize;
      const recentTurnsPreserve = resolveRecentTurnsPreserve(runtime?.recentTurnsPreserve);
      const qualityGuardEnabled = runtime?.qualityGuardEnabled ?? false;
      const qualityGuardMaxRetries = resolveQualityGuardMaxRetries(runtime?.qualityGuardMaxRetries);
      const structuredInstructions = buildCompactionStructureInstructions(
        customInstructions,
        summarizationInstructions,
      );

      const maxHistoryShare = runtime?.maxHistoryShare ?? 0.5;

      const tokensBefore =
        typeof preparation.tokensBefore === "number" && Number.isFinite(preparation.tokensBefore)
          ? preparation.tokensBefore
          : undefined;

      let droppedSummary: string | undefined;

      if (tokensBefore !== undefined) {
        const summarizableTokens =
          estimateMessagesTokens(messagesToSummarize) + estimateMessagesTokens(turnPrefixMessages);
        const newContentTokens = Math.max(0, Math.floor(tokensBefore - summarizableTokens));
        // Apply SAFETY_MARGIN so token underestimates don't trigger unnecessary pruning
        const maxHistoryTokens = Math.floor(contextWindowTokens * maxHistoryShare * SAFETY_MARGIN);

        if (newContentTokens > maxHistoryTokens) {
          const pruned = pruneHistoryForContextShare({
            messages: messagesToSummarize,
            maxContextTokens: contextWindowTokens,
            maxHistoryShare,
            parts: 2,
          });
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
                const droppedChunkRatio = computeAdaptiveChunkRatio(
                  pruned.droppedMessagesList,
                  contextWindowTokens,
                );
                const droppedMaxChunkTokens = Math.max(
                  1,
                  Math.floor(contextWindowTokens * droppedChunkRatio) -
                    SUMMARIZATION_OVERHEAD_TOKENS,
                );
                droppedSummary = await summarizeInStages({
                  messages: pruned.droppedMessagesList,
                  model,
                  apiKey,
                  signal,
                  reserveTokens: Math.max(1, Math.floor(preparation.settings.reserveTokens)),
                  maxChunkTokens: droppedMaxChunkTokens,
                  contextWindow: contextWindowTokens,
                  customInstructions: structuredInstructions,
                  summarizationInstructions,
                  previousSummary: preparation.previousSummary,
                });
              } catch (droppedError) {
                log.warn(
                  `Compaction safeguard: failed to summarize dropped messages, continuing without: ${
                    droppedError instanceof Error ? droppedError.message : String(droppedError)
                  }`,
                );
              }
            }
          }
        }
      }

      const {
        summarizableMessages: summaryTargetMessages,
        preservedMessages: preservedRecentMessages,
      } = splitPreservedRecentTurns({
        messages: messagesToSummarize,
        recentTurnsPreserve,
      });
      messagesToSummarize = summaryTargetMessages;
      const preservedTurnsSection = formatPreservedTurnsSection(preservedRecentMessages);
      const latestUserAsk = extractLatestUserAsk([...messagesToSummarize, ...turnPrefixMessages]);
      const identifierSeedText = [...messagesToSummarize, ...turnPrefixMessages]
        .slice(-10)
        .map((message) => extractMessageText(message))
        .filter(Boolean)
        .join("\n");
      const identifiers = extractOpaqueIdentifiers(identifierSeedText);

      // Use adaptive chunk ratio based on message sizes, reserving headroom for
      // the summarization prompt, system prompt, previous summary, and reasoning budget
      // that generateSummary adds on top of the serialized conversation chunk.
      const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
      const adaptiveRatio = computeAdaptiveChunkRatio(allMessages, contextWindowTokens);
      const maxChunkTokens = Math.max(
        1,
        Math.floor(contextWindowTokens * adaptiveRatio) - SUMMARIZATION_OVERHEAD_TOKENS,
      );
      const reserveTokens = Math.max(1, Math.floor(preparation.settings.reserveTokens));

      // Feed dropped-messages summary as previousSummary so the main summarization
      // incorporates context from pruned messages instead of losing it entirely.
      const effectivePreviousSummary = droppedSummary ?? preparation.previousSummary;

      let summary = "";
      let lastHistorySummary = "";
      let lastSplitTurnSection = "";
      let usedLastSuccessfulSummary = false;
      let currentInstructions = structuredInstructions;
      const totalAttempts = qualityGuardEnabled ? qualityGuardMaxRetries + 1 : 1;
      let lastSuccessfulSummary: string | null = null;

      for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
        let summaryWithoutPreservedTurns = "";
        let summaryWithPreservedTurns = "";
        let splitTurnSection = "";
        let historySummary = "";
        try {
          historySummary =
            messagesToSummarize.length > 0
              ? await summarizeInStages({
                  messages: messagesToSummarize,
                  model,
                  apiKey,
                  signal,
                  reserveTokens,
                  maxChunkTokens,
                  contextWindow: contextWindowTokens,
                  customInstructions: currentInstructions,
                  summarizationInstructions,
                  previousSummary: effectivePreviousSummary,
                })
              : buildStructuredFallbackSummary(effectivePreviousSummary, summarizationInstructions);

          summaryWithoutPreservedTurns = historySummary;
          if (preparation.isSplitTurn && turnPrefixMessages.length > 0) {
            const prefixSummary = await summarizeInStages({
              messages: turnPrefixMessages,
              model,
              apiKey,
              signal,
              reserveTokens,
              maxChunkTokens,
              contextWindow: contextWindowTokens,
              customInstructions: composeSplitTurnInstructions(
                TURN_PREFIX_INSTRUCTIONS,
                currentInstructions,
              ),
              summarizationInstructions,
              previousSummary: undefined,
            });
            splitTurnSection = `**Turn Context (split turn):**\n\n${prefixSummary}`;
            summaryWithoutPreservedTurns = historySummary.trim()
              ? `${historySummary}\n\n---\n\n${splitTurnSection}`
              : splitTurnSection;
          }
          summaryWithPreservedTurns = appendSummarySection(
            summaryWithoutPreservedTurns,
            preservedTurnsSection,
          );
        } catch (attemptError) {
          if (lastSuccessfulSummary && attempt > 0) {
            log.warn(
              `Compaction safeguard: quality retry failed on attempt ${attempt + 1}; ` +
                `keeping last successful summary: ${
                  attemptError instanceof Error ? attemptError.message : String(attemptError)
                }`,
            );
            summary = lastSuccessfulSummary;
            usedLastSuccessfulSummary = true;
            break;
          }
          throw attemptError;
        }
        lastSuccessfulSummary = summaryWithPreservedTurns;
        lastHistorySummary = historySummary;
        lastSplitTurnSection = splitTurnSection;

        const canRegenerate =
          messagesToSummarize.length > 0 ||
          (preparation.isSplitTurn && turnPrefixMessages.length > 0);
        if (!qualityGuardEnabled || !canRegenerate) {
          summary = summaryWithPreservedTurns;
          break;
        }
        const quality = auditSummaryQuality({
          summary: summaryWithoutPreservedTurns,
          identifiers,
          latestAsk: latestUserAsk,
          identifierPolicy,
        });
        summary = summaryWithPreservedTurns;
        if (quality.ok || attempt >= totalAttempts - 1) {
          break;
        }
        const reasons = quality.reasons.join(", ");
        const qualityFeedbackInstruction =
          identifierPolicy === "strict"
            ? "Fix all issues and include every required section with exact identifiers preserved."
            : "Fix all issues and include every required section while following the configured identifier policy.";
        const qualityFeedbackReasons = wrapUntrustedInstructionBlock(
          "Quality check feedback",
          `Previous summary failed quality checks (${reasons}).`,
        );
        currentInstructions = qualityFeedbackReasons
          ? `${structuredInstructions}\n\n${qualityFeedbackInstruction}\n\n${qualityFeedbackReasons}`
          : `${structuredInstructions}\n\n${qualityFeedbackInstruction}`;
      }

      // Cap the main history body first, then append split-turn context, preserved
      // turns, diagnostics, and workspace rules so they survive truncation.
      // Truncation keeps the prefix (slice(0, budget)), so sections at the end
      // of the body would be dropped first—split-turn, preserved turns, tool
      // failures, and file ops must be in the suffix.
      const reservedSuffix = appendSummarySection(
        appendSummarySection(
          appendSummarySection(
            appendSummarySection("", lastSplitTurnSection),
            preservedTurnsSection,
          ),
          toolFailureSection,
        ),
        fileOpsSummary,
      );
      const workspaceContext = await readWorkspaceContextForSummary();
      const fullReservedSuffix = appendSummarySection(reservedSuffix, workspaceContext);
      // Ensure leading separator so suffix does not merge with body (e.g. when body
      // ends without newline from buildStructuredFallbackSummary: "...## Exact identifiers## Tool Failures").
      const normalizedSuffix =
        fullReservedSuffix && !/^\s/.test(fullReservedSuffix)
          ? `\n\n${fullReservedSuffix}`
          : fullReservedSuffix;
      const bodyToCap = usedLastSuccessfulSummary ? summary : lastHistorySummary;
      const suffixToUse = usedLastSuccessfulSummary
        ? (() => {
            const diag = appendSummarySection(
              appendSummarySection("", toolFailureSection),
              fileOpsSummary,
            );
            const withWk = appendSummarySection(diag, workspaceContext);
            return withWk && !/^\s/.test(withWk) ? `\n\n${withWk}` : withWk;
          })()
        : normalizedSuffix;
      summary = capCompactionSummaryPreservingSuffix(bodyToCap, suffixToUse ?? "");

      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { readFiles, modifiedFiles },
        },
      };
    } catch (error) {
      log.warn(
        `Compaction summarization failed; cancelling compaction to preserve history: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { cancel: true };
    }
  });
}

export const __testing = {
  collectToolFailures,
  formatToolFailuresSection,
  splitPreservedRecentTurns,
  formatPreservedTurnsSection,
  buildCompactionStructureInstructions,
  buildStructuredFallbackSummary,
  appendSummarySection,
  resolveRecentTurnsPreserve,
  resolveQualityGuardMaxRetries,
  extractOpaqueIdentifiers,
  auditSummaryQuality,
  capCompactionSummary,
  capCompactionSummaryPreservingSuffix,
  formatFileOperations,
  computeAdaptiveChunkRatio,
  isOversizedForSummary,
  readWorkspaceContextForSummary,
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  MAX_COMPACTION_SUMMARY_CHARS,
  MAX_FILE_OPS_SECTION_CHARS,
  MAX_FILE_OPS_LIST_CHARS,
  SUMMARY_TRUNCATED_MARKER,
} as const;
