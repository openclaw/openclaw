import { extractKeywords, isQueryStopWordToken } from "../../memory-host-sdk/query.js";
import { localeLowercasePreservingWhitespace } from "../../shared/string-coerce.js";
import { wrapUntrustedPromptDataBlock } from "../sanitize-for-prompt.js";
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
];
const STRICT_EXACT_IDENTIFIERS_INSTRUCTION = "For ## Exact identifiers, preserve literal values exactly as seen (IDs, URLs, file paths, ports, hashes, dates, times).";
const POLICY_OFF_EXACT_IDENTIFIERS_INSTRUCTION = "For ## Exact identifiers, include identifiers only when needed for continuity; do not enforce literal-preservation rules.";
export function wrapUntrustedInstructionBlock(label, text) {
    return wrapUntrustedPromptDataBlock({
        label,
        text,
        maxChars: MAX_UNTRUSTED_INSTRUCTION_CHARS,
    });
}
function resolveExactIdentifierSectionInstruction(summarizationInstructions) {
    const policy = summarizationInstructions?.identifierPolicy ?? "strict";
    if (policy === "off") {
        return POLICY_OFF_EXACT_IDENTIFIERS_INSTRUCTION;
    }
    if (policy === "custom") {
        const custom = summarizationInstructions?.identifierInstructions?.trim();
        if (custom) {
            const customBlock = wrapUntrustedInstructionBlock("For ## Exact identifiers, apply this operator-defined policy text", custom);
            if (customBlock) {
                return customBlock;
            }
        }
    }
    return STRICT_EXACT_IDENTIFIERS_INSTRUCTION;
}
export function buildCompactionStructureInstructions(customInstructions, summarizationInstructions) {
    const identifierSectionInstruction = resolveExactIdentifierSectionInstruction(summarizationInstructions);
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
function normalizedSummaryLines(summary) {
    return summary
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}
function hasRequiredSummarySections(summary) {
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
export function buildStructuredFallbackSummary(previousSummary, _summarizationInstructions) {
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
export function appendSummarySection(summary, section) {
    if (!section) {
        return summary;
    }
    if (!summary.trim()) {
        return section.trimStart();
    }
    return `${summary}${section}`;
}
function sanitizeExtractedIdentifier(value) {
    return value
        .trim()
        .replace(/^[("'`[{<]+/, "")
        .replace(/[)\]"'`,;:.!?<>]+$/, "");
}
function isPureHexIdentifier(value) {
    return /^[A-Fa-f0-9]{8,}$/.test(value);
}
function normalizeOpaqueIdentifier(value) {
    return isPureHexIdentifier(value) ? value.toUpperCase() : value;
}
function summaryIncludesIdentifier(summary, identifier) {
    if (isPureHexIdentifier(identifier)) {
        return summary.toUpperCase().includes(identifier.toUpperCase());
    }
    return summary.includes(identifier);
}
export function extractOpaqueIdentifiers(text) {
    const matches = text.match(/([A-Fa-f0-9]{8,}|https?:\/\/\S+|\/[\w.-]{2,}(?:\/[\w.-]+)+|[A-Za-z]:\\[\w\\.-]+|[A-Za-z0-9._-]+\.[A-Za-z0-9._/-]+:\d{1,5}|\b\d{6,}\b)/g) ?? [];
    return Array.from(new Set(matches
        .map((value) => sanitizeExtractedIdentifier(value))
        .map((value) => normalizeOpaqueIdentifier(value))
        .filter((value) => value.length >= 4))).slice(0, MAX_EXTRACTED_IDENTIFIERS);
}
function tokenizeAskOverlapText(text) {
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
function hasAskOverlap(summary, latestAsk) {
    if (!latestAsk) {
        return true;
    }
    const askTokens = Array.from(new Set(tokenizeAskOverlapText(latestAsk))).slice(0, MAX_ASK_OVERLAP_TOKENS);
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
export function auditSummaryQuality(params) {
    const reasons = [];
    const lines = new Set(normalizedSummaryLines(params.summary));
    for (const section of REQUIRED_SUMMARY_SECTIONS) {
        if (!lines.has(section)) {
            reasons.push(`missing_section:${section}`);
        }
    }
    const enforceIdentifiers = (params.identifierPolicy ?? "strict") === "strict";
    if (enforceIdentifiers) {
        const missingIdentifiers = params.identifiers.filter((identifier) => !summaryIncludesIdentifier(params.summary, identifier));
        if (missingIdentifiers.length > 0) {
            reasons.push(`missing_identifiers:${missingIdentifiers.slice(0, 3).join(",")}`);
        }
    }
    if (!hasAskOverlap(params.summary, params.latestAsk)) {
        reasons.push("latest_user_ask_not_reflected");
    }
    return { ok: reasons.length === 0, reasons };
}
