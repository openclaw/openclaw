import type { SidecarStatus } from "../sidecar-repo.js";

export type CandidateMemoryType = "identity" | "preference" | "constraint" | "todo" | "decision";

export type Candidate = {
  text: string;
  memoryType: CandidateMemoryType;
  importance: number;
  confidence: number;
};

export type ExtractOptions = {
  // Cap on candidates returned per call. Higher-importance candidates win on
  // ties; ordering within a tie follows rule order below.
  maxCandidates?: number;
  // Minimum length of the candidate's stored text after normalization.
  minLength?: number;
  // Maximum length of the stored candidate text (truncates with no ellipsis).
  maxLength?: number;
};

const DEFAULTS = {
  maxCandidates: 3,
  minLength: 4,
  maxLength: 280,
} as const;

type Rule = {
  memoryType: CandidateMemoryType;
  importance: number;
  confidence: number;
  // Each rule's regex must capture the salient span as group 1 (or the whole
  // match falls back as the captured text).
  pattern: RegExp;
};

// Order matters only for tie-breaking on importance. Identity first because it
// is the most consequential and least ambiguous.
const RULES: Rule[] = [
  {
    memoryType: "identity",
    importance: 0.9,
    confidence: 0.7,
    pattern: /\b((?:my name is|i am called|call me)\s+[A-Za-z][\w'-]{1,40})\b/i,
  },
  {
    memoryType: "constraint",
    importance: 0.7,
    confidence: 0.6,
    pattern:
      /\b((?:do not|don't|never)\s+\w+(?:\s+\w+){0,8}\s+(?:to|when|if|because)\b[^.?!\n]{0,160})/i,
  },
  {
    memoryType: "preference",
    importance: 0.6,
    confidence: 0.6,
    pattern:
      /\b((?:i (?:prefer|like|love|hate|don't (?:like|want))|i always|i never)\b[^.?!\n]{3,160})/i,
  },
  {
    memoryType: "todo",
    importance: 0.5,
    confidence: 0.6,
    pattern: /\b((?:remind me to|todo:|don't forget to|i need to)[^.?!\n]{3,160})/i,
  },
  {
    memoryType: "decision",
    importance: 0.4,
    confidence: 0.5,
    pattern: /\b((?:let'?s|we (?:will|are going to)|i (?:will|'?ll))\b[^.?!\n]{3,160})/i,
  },
];

// Stored status defaults are owned by the sidecar repo; we surface the type
// here only so a higher-level handler doesn't need to reach back into the
// SidecarStatus union when constructing partials.
export const DEFAULT_INGEST_STATUS: SidecarStatus = "active";

export function extractCandidates(userText: string, opts: ExtractOptions = {}): Candidate[] {
  const max = opts.maxCandidates ?? DEFAULTS.maxCandidates;
  const minLen = opts.minLength ?? DEFAULTS.minLength;
  const maxLen = opts.maxLength ?? DEFAULTS.maxLength;
  if (!userText || userText.trim().length === 0) {
    return [];
  }

  const found: Candidate[] = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(userText);
    if (!match) {
      continue;
    }
    const raw = (match[1] ?? match[0]).trim();
    if (raw.length < minLen) {
      continue;
    }
    const text = raw.length > maxLen ? raw.slice(0, maxLen) : raw;
    found.push({
      text,
      memoryType: rule.memoryType,
      importance: rule.importance,
      confidence: rule.confidence,
    });
  }

  // Stable sort: by importance desc, then by rule order (already preserved by
  // push order in `found`).
  found.sort((a, b) => b.importance - a.importance);
  return found.slice(0, max);
}
