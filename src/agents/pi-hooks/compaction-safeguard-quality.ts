import { extractKeywords, isQueryStopWordToken } from "../../memory-host-sdk/query.js";
import { localeLowercasePreservingWhitespace } from "../../shared/string-coerce.js";
import type { CompactionSummarizationInstructions } from "../compaction.js";
import { wrapUntrustedPromptDataBlock } from "../sanitize-for-prompt.js";
import { SUMMARY_UNVERIFIED } from "../subagent-active-task-contract.js";

export const COMPACTION_SUMMARY_UNVERIFIED = "SUMMARY_UNVERIFIED" as const;

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

export function wrapUntrustedInstructionBlock(label: string, text: string): string {
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

export function buildCompactionStructureInstructions(
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
    "When prior compaction summaries are present, re-distill them with new messages and remove stale duplicate detail.",
  ].join("\n");
  const custom = customInstructions?.trim();
  if (!custom) {
    return sectionsTemplate;
  }
  const customBlock = wrapUntrustedInstructionBlock("Additional context from /compact", custom);
  if (!customBlock) {
    return sectionsTemplate;
  }
  return `${sectionsTemplate}\n\n${customBlock}`;
}

function normalizedSummaryLines(summary: string): string[] {
  return summary
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function extractSummarySectionLines(summary: string, heading: string): string[] {
  const lines = summary.split(/\r?\n/u);
  const startIndex = lines.findIndex((line) => line.trim() === heading);
  if (startIndex < 0) {
    return [];
  }
  const sectionLines: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (/^##\s+\S/u.test(line.trim())) {
      break;
    }
    const trimmed = line.trim();
    if (trimmed) {
      sectionLines.push(trimmed);
    }
  }
  return sectionLines;
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

export function buildStructuredFallbackSummary(
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

export function appendSummarySection(summary: string, section: string): string {
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

export function extractOpaqueIdentifiers(text: string): string[] {
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

function tokenizeAskOverlapText(text: string): string[] {
  const normalized = localeLowercasePreservingWhitespace(text.normalize("NFKC")).trim();
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

function extractSummarySectionBody(summary: string, heading: string): string {
  const lines = summary.split(/\r?\n/u);
  const headingIndex = lines.findIndex((line) => line.trim() === heading);
  if (headingIndex < 0) {
    return "";
  }
  const bodyLines: string[] = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^##\s+/u.test(line.trim())) {
      break;
    }
    bodyLines.push(line);
  }
  return bodyLines.join("\n").trim();
}

function deniesPendingUserAsk(text: string): boolean {
  const normalized = localeLowercasePreservingWhitespace(text.normalize("NFKC"))
    .replace(/[\t\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return false;
  }
  return (
    /^(?:[-*]\s*)?(?:none|n\/a|nothing|no pending asks?\.?|no pending user asks?\.?)$/iu.test(
      normalized,
    ) || /\bno\s+pending\s+(?:user\s+)?asks?\b/iu.test(normalized)
  );
}

export function summaryContradictsLatestUserAsk(params: {
  summary: string;
  latestAsk: string | null;
}): boolean {
  const latestAsk = params.latestAsk?.trim();
  if (!latestAsk) {
    return false;
  }
  const pendingAskBody = extractSummarySectionBody(params.summary, "## Pending user asks");
  if (deniesPendingUserAsk(pendingAskBody)) {
    return true;
  }
  return deniesPendingUserAsk(params.summary);
}

export function formatSummaryUnverifiedSection(params: {
  summary: string;
  latestAsk: string | null;
  maxLatestAskChars?: number;
}): string {
  if (!summaryContradictsLatestUserAsk(params)) {
    return "";
  }
  const maxLatestAskChars = Math.max(1, Math.floor(params.maxLatestAskChars ?? 1200));
  const latestAsk = (params.latestAsk ?? "").trim();
  const boundedLatestAsk =
    latestAsk.length > maxLatestAskChars
      ? `${latestAsk.slice(0, maxLatestAskChars)}...`
      : latestAsk;
  return [
    `## ${SUMMARY_UNVERIFIED}`,
    `${SUMMARY_UNVERIFIED}: the summary's pending-ask state contradicted the latest explicit user request. Treat the summary body as unverified until re-distilled.`,
    "Latest explicit user request preserved verbatim:",
    boundedLatestAsk,
  ].join("\n");
}

function pendingAskSectionContradictsLatestAsk(summary: string, latestAsk: string | null): boolean {
  if (!latestAsk) {
    return false;
  }
  const pendingAskSection = extractSummarySectionLines(summary, "## Pending user asks").join(" ");
  if (!pendingAskSection) {
    return false;
  }
  const saysNoPendingAsk =
    /^(?:[-*]\s*)?(?:none|no pending asks?|no pending user asks?|nothing pending|n\/a)\.?$/iu.test(
      pendingAskSection,
    ) || /\bno pending (?:user )?asks?\b/iu.test(pendingAskSection);
  return saysNoPendingAsk && !hasAskOverlap(pendingAskSection, latestAsk);
}

export function findCompactionSummaryVerificationIssues(params: {
  summary: string;
  latestAsk: string | null;
}): string[] {
  if (!params.latestAsk) {
    return [];
  }
  const reasons: string[] = [];
  if (!hasAskOverlap(params.summary, params.latestAsk)) {
    reasons.push("latest_user_ask_not_reflected");
  }
  if (pendingAskSectionContradictsLatestAsk(params.summary, params.latestAsk)) {
    reasons.push("pending_user_asks_contradicts_latest_user_request");
  }
  return Array.from(new Set(reasons));
}

export function buildSummaryUnverifiedSection(params: {
  latestAsk: string | null;
  reasons: string[];
}): string {
  if (!params.latestAsk || params.reasons.length === 0) {
    return "";
  }
  const boundedLatestAsk = params.latestAsk.replace(/\s+/gu, " ").trim().slice(0, 600);
  return [
    "",
    "",
    "## Summary verification",
    COMPACTION_SUMMARY_UNVERIFIED,
    `- Reasons: ${params.reasons.join(", ")}`,
    `- Latest explicit user request preserved: ${boundedLatestAsk}`,
  ].join("\n");
}

export function buildSummaryVerificationSection(params: {
  summary: string;
  latestAsk: string | null;
  extraReasons?: string[];
}): string {
  const reasons = Array.from(
    new Set([
      ...findCompactionSummaryVerificationIssues({
        summary: params.summary,
        latestAsk: params.latestAsk,
      }),
      ...(params.extraReasons ?? []),
    ]),
  );
  return buildSummaryUnverifiedSection({ latestAsk: params.latestAsk, reasons });
}

export function auditSummaryQuality(params: {
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
      (identifier) => !summaryIncludesIdentifier(params.summary, identifier),
    );
    if (missingIdentifiers.length > 0) {
      reasons.push(`missing_identifiers:${missingIdentifiers.slice(0, 3).join(",")}`);
    }
  }
  reasons.push(...findCompactionSummaryVerificationIssues(params));
  return { ok: reasons.length === 0, reasons };
}
