// Trusted-critic anti-sycophancy heuristics for agent output review.
export const SYCOPHANCY_PATTERN_IDS = [
  "uncritical-praise",
  "question-mirror-endorsement",
  "rubber-stamp-review",
] as const;

export type SycophancyPatternId = (typeof SYCOPHANCY_PATTERN_IDS)[number];

export type SycophancyFlag = {
  patternId: SycophancyPatternId;
  description: string;
  excerpt: string;
  severity: "info" | "material";
};

export type SycophancyLogEntry = {
  timestamp: string;
  patternId: SycophancyPatternId;
  message: string;
  excerpt: string;
  severity: "info" | "material";
};

export type DetectionResult = {
  flagged: boolean;
  flags: SycophancyFlag[];
};

export type DetectionLogger = {
  readonly entries: readonly SycophancyLogEntry[];
  log(flag: SycophancyFlag): void;
};

type PatternRule = {
  id: SycophancyPatternId;
  description: string;
  severity: "info" | "material";
  matches: (text: string) => string | null;
};

const EVIDENCE_MARKERS =
  /\b(?:because|however|risk|concern|pushback|alternative|evidence|tradeoff|checked|verified|tested|reviewed|file:|line \d+)\b/i;

const UNCRITICAL_PRAISE =
  /\b(?:great idea|excellent choice|perfect plan|fantastic approach|brilliant idea|you(?:'re| are) absolutely right)\b[!.]?/i;

const MIRROR_ENDORSEMENT =
  /\b(?:yes,?\s+(?:you )?should|absolutely,?\s+(?:this is|that's)|definitely(?:\s+go ahead|\s+the right))\b/i;

const RUBBER_STAMP =
  /\b(?:looks good(?: to me)?|lgtm|ship it|no (?:material )?issues(?: found)?)\b[!.]?/i;

const PATTERN_RULES: PatternRule[] = [
  {
    id: "uncritical-praise",
    description: "Uncritical praise without reasoning or evidence",
    severity: "material",
    matches(text) {
      const match = text.match(UNCRITICAL_PRAISE);
      if (!match || EVIDENCE_MARKERS.test(text)) {
        return null;
      }
      return match[0];
    },
  },
  {
    id: "question-mirror-endorsement",
    description: "Mirrors a should-we question as endorsement without Pushback",
    severity: "material",
    matches(text) {
      if (/pushback\s*:/i.test(text)) {
        return null;
      }
      const match = text.match(MIRROR_ENDORSEMENT);
      return match ? match[0] : null;
    },
  },
  {
    id: "rubber-stamp-review",
    description: "Rubber-stamp approval without review evidence",
    severity: "material",
    matches(text) {
      const match = text.match(RUBBER_STAMP);
      if (!match || EVIDENCE_MARKERS.test(text)) {
        return null;
      }
      return match[0];
    },
  },
];

export function createDetectionLogger(): DetectionLogger {
  const entries: SycophancyLogEntry[] = [];
  return {
    get entries() {
      return entries;
    },
    log(flag: SycophancyFlag) {
      entries.push({
        timestamp: new Date().toISOString(),
        patternId: flag.patternId,
        message: flag.description,
        excerpt: flag.excerpt,
        severity: flag.severity,
      });
    },
  };
}

export function detectSycophancy(
  text: string,
  options?: { logger?: DetectionLogger },
): DetectionResult {
  const normalized = text.trim();
  const flags: SycophancyFlag[] = [];

  for (const rule of PATTERN_RULES) {
    const excerpt = rule.matches(normalized);
    if (!excerpt) {
      continue;
    }
    const flag: SycophancyFlag = {
      patternId: rule.id,
      description: rule.description,
      excerpt,
      severity: rule.severity,
    };
    flags.push(flag);
    options?.logger?.log(flag);
  }

  return {
    flagged: flags.length > 0,
    flags,
  };
}
