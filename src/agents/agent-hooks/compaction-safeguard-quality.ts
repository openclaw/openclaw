/** Quality contract, fallback, and audit helpers for compaction safeguard summaries. */
import { localeLowercasePreservingWhitespace } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { extractKeywords, isQueryStopWordToken } from "../../memory-host-sdk/query.js";
import type { CompactionSummarizationInstructions } from "../compaction.js";
import { sanitizeDiagnosticPayload } from "../payload-redaction.js";
import { wrapUntrustedPromptDataBlock } from "../sanitize-for-prompt.js";

// Compaction summary quality helpers. They define the structured summary contract
// and audit whether summaries preserve pending asks plus exact identifiers.
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

/** Wraps operator-provided compaction instruction text as untrusted prompt data. */
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
      // Operator text is runtime data, not prompt authority. Wrap it as
      // untrusted data before inserting it into compaction instructions.
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

/** Build the required structured summary instructions for compaction. */
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

/** Return a structured fallback summary when model output is missing/invalid. */
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

/** Append an already-formatted summary section without disturbing empty summaries. */
/** Appends a bounded post-compaction section to an existing summary. */
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

// Blocklist for credential-shaped prefixes. These strings are common API key,
// token, and secret prefixes that should never be re-appended to a compaction
// summary. Case-insensitive check against the start of the sanitized value.
const CREDENTIAL_PREFIXES = [
  "sk-",
  "pk-",
  "rk-",
  "sk_live_",
  "sk_test_",
  "pk_live_",
  "pk_test_",
  "whsec_",
  "xoxb-",
  "xoxp-",
  "xoxs-",
  "xoxa-",
  "ghp_",
  "gho_",
  "ghs_",
  "ghu_",
  "github_pat_",
  "glpat-",
  "glcbt-",
  "Bearer ",
  "bearer ",
  "AKIA",
  "ASIA",
  "eyJ", // JWT prefix (base64-encoded '{')
];

// URL query parameter names that commonly carry secrets.
const CREDENTIAL_URL_PARAMS =
  /[?&](token|access_token|api_key|apikey|secret|password|auth|key|credential)=/i;

function isCredentialShaped(value: string): boolean {
  const lower = value.toLowerCase();
  for (const prefix of CREDENTIAL_PREFIXES) {
    if (lower.startsWith(prefix.toLowerCase())) {
      return true;
    }
  }
  if (value.startsWith("http") && CREDENTIAL_URL_PARAMS.test(value)) {
    return true;
  }
  return false;
}

// Pre-extraction redaction: remove credential-shaped substrings from input text
// BEFORE the identifier regex runs. This prevents hex fragments of API keys
// (e.g. "abcd1234ef" from "sk-abcd1234efgh") from surviving as identifiers
// when the prefix falls outside the regex match boundary.
const CREDENTIAL_REDACT_PATTERN = new RegExp(
  "(?:" +
    CREDENTIAL_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
    ")[A-Za-z0-9_\\-.+/=]{4,}",
  "gi",
);

function redactCredentials(text: string): string {
  return text.replace(CREDENTIAL_REDACT_PATTERN, "");
}

// Name/value credential shapes in non-JSON tool argument strings
// (e.g. "token: deadbeef12345678") that lack a known secret prefix.
const CREDENTIAL_NAME_VALUE_PATTERN =
  /\b(?:token|api[_-]?key|password|secret|auth|credential|access[_-]?token)\s*[:=]\s*[A-Za-z0-9_+\-./=]{8,}/gi;

function redactUnsafeRawToolArgument(text: string): string {
  return redactCredentials(text.replace(CREDENTIAL_NAME_VALUE_PATTERN, ""));
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

/** Extracts likely exact identifiers that summaries should preserve literally. */
export function extractOpaqueIdentifiers(text: string): string[] {
  const safeText = redactCredentials(text);
  const matches =
    safeText.match(
      /([A-Fa-f0-9]{8,}|https?:\/\/\S+|\/[\w.-]{2,}(?:\/[\w.-]+)+|[A-Za-z]:\\[\w\\.-]+|[A-Za-z0-9._-]+\.[A-Za-z0-9._/-]+:\d{1,5}|\b\d{6,}\b)/g,
    ) ?? [];
  return Array.from(
    new Set(
      matches
        .map((value) => sanitizeExtractedIdentifier(value))
        .filter((value) => !isCredentialShaped(value))
        .map((value) => normalizeOpaqueIdentifier(value))
        .filter((value) => value.length >= 4),
    ),
  ).slice(0, MAX_EXTRACTED_IDENTIFIERS);
}

const TOOL_CALL_BLOCK_TYPES = new Set([
  "toolCall",
  "toolUse",
  "tool_use",
  "functionCall",
  "function_call",
]);

export function extractMessageTextForIdentifiers(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const parts: string[] = [];
  const msg = message as { content?: unknown };
  const content = msg.content;
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const rec = block as Record<string, unknown>;
      if (rec.type === "text" && typeof rec.text === "string") {
        parts.push(rec.text);
      }
      if (typeof rec.type === "string" && TOOL_CALL_BLOCK_TYPES.has(rec.type)) {
        const args = rec.arguments ?? rec.input;
        if (typeof args === "string") {
          // String-encoded arguments (e.g. OpenAI's JSON-stringified format)
          // may contain credential fields. Parse and sanitize before extraction
          // to avoid leaking secrets into the ## Exact identifiers section.
          try {
            const parsed: unknown = JSON.parse(args);
            if (parsed && typeof parsed === "object") {
              parts.push(JSON.stringify(sanitizeDiagnosticPayload(parsed)));
            } else {
              parts.push(args);
            }
          } catch {
            // Not valid JSON; redact name/value credential shapes and known
            // prefixes before identifier extraction so hex-looking secrets
            // do not land in ## Exact identifiers.
            const redacted = redactUnsafeRawToolArgument(args);
            if (redacted.trim()) {
              parts.push(redacted);
            }
          }
        } else if (args && typeof args === "object") {
          try {
            // Redact credential-shaped fields (apiKey, token, password, secret)
            // before identifier extraction to avoid leaking secrets into
            // compaction summaries.
            parts.push(JSON.stringify(sanitizeDiagnosticPayload(args)));
          } catch {
            // skip unserializable args
          }
        }
      }
    }
  }
  return parts.join("\n");
}

// Scan budget: cap total extracted text to avoid unbounded synchronous work on
// large transcripts with big tool arguments/results.
const MAX_EXTRACTION_CHARS = 500_000;

export function extractIdentifiersFromMessages(messages: unknown[]): string[] {
  const parts: string[] = [];
  let totalChars = 0;
  for (const msg of messages) {
    const text = extractMessageTextForIdentifiers(msg);
    if (!text) {
      continue;
    }
    if (totalChars + text.length > MAX_EXTRACTION_CHARS) {
      const remaining = MAX_EXTRACTION_CHARS - totalChars;
      if (remaining > 0) {
        parts.push(text.slice(0, remaining));
      }
      break;
    }
    parts.push(text);
    totalChars += text.length;
  }
  return extractOpaqueIdentifiers(parts.join("\n"));
}

export function computeLostIdentifiers(sourceIdentifiers: string[], summary: string): string[] {
  return sourceIdentifiers.filter((identifier) => !summaryIncludesIdentifier(summary, identifier));
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
  const askTokens = uniqueStrings(tokenizeAskOverlapText(latestAsk)).slice(
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

/** Audit summary structure, exact identifier preservation, and latest-ask coverage. */
/** Audits a candidate summary for required sections, pending asks, and identifier preservation. */
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
  if (!hasAskOverlap(params.summary, params.latestAsk)) {
    reasons.push("latest_user_ask_not_reflected");
  }
  return { ok: reasons.length === 0, reasons };
}
