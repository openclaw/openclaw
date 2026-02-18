export const COMPLETION_STATUSES = ["complete", "partial", "failed"] as const;
export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

export type CompletionStatus = (typeof COMPLETION_STATUSES)[number];
export type CompletionConfidence = (typeof CONFIDENCE_LEVELS)[number];

export type CompletionArtifact = {
  path: string;
  description?: string;
};

export type CompletionReport = {
  status?: CompletionStatus;
  confidence?: CompletionConfidence;
  summary?: string;
  artifacts?: CompletionArtifact[];
  blockers?: string[];
  warnings?: string[];
};

type CompletionReportSection = keyof CompletionReport;

type SectionLine = {
  field: CompletionReportSection;
  value: string;
};

const REPORT_FIELDS = new Set<CompletionReportSection>([
  "status",
  "confidence",
  "summary",
  "artifacts",
  "blockers",
  "warnings",
]);

const HEADER_RE = /^\s*(status|confidence|summary|artifacts|blockers|warnings)\s*[:=]\s*(.*?)\s*$/i;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(?:\s.*)?$/;

function stripFencedCodeBlocks(input: string) {
  const lines = input.split(/\r?\n/);
  let openFenceMarker: string | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(FENCE_RE);
    if (match) {
      const marker = match[2];
      if (openFenceMarker === undefined) {
        openFenceMarker = marker;
      } else if (marker[0] === openFenceMarker[0] && marker.length >= openFenceMarker.length) {
        openFenceMarker = undefined;
      }
      lines[i] = " ".repeat(line.length);
      continue;
    }

    if (openFenceMarker !== undefined) {
      lines[i] = " ".repeat(line.length);
    }
  }

  return lines.join("\n");
}

function parseHeader(line: string): SectionLine | undefined {
  const match = line.match(HEADER_RE);
  if (!match) {
    return undefined;
  }

  const field = match[1]?.toLowerCase() as CompletionReportSection;
  if (!REPORT_FIELDS.has(field)) {
    return undefined;
  }

  return {
    field,
    value: match[2] ?? "",
  };
}

function parseStatus(value: string): CompletionStatus | undefined {
  const normalized = value.trim().toLowerCase();
  return COMPLETION_STATUSES.includes(normalized as CompletionStatus)
    ? (normalized as CompletionStatus)
    : undefined;
}

function parseConfidence(value: string): CompletionConfidence | undefined {
  const normalized = value.trim().toLowerCase();
  return CONFIDENCE_LEVELS.includes(normalized as CompletionConfidence)
    ? (normalized as CompletionConfidence)
    : undefined;
}

function normalizeListLine(line: string) {
  return line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "");
}

function parseStringLines(lines: string[]): string[] {
  return lines
    .map((line) => normalizeListLine(line.trim()))
    .filter((line) => line.length > 0)
    .filter((line) => !/^(?:[-*+]|(?:\d+\.)?)$/.test(line.trim()));
}

function parseArtifactsLine(raw: string): CompletionArtifact | undefined {
  const line = normalizeListLine(raw).trim();
  if (!line) {
    return undefined;
  }

  const separator = line.indexOf(" - ");
  if (separator === -1) {
    return { path: line };
  }

  const path = line.slice(0, separator).trim();
  if (!path) {
    return undefined;
  }

  const description = line.slice(separator + 3).trim();
  return description ? { path, description } : { path };
}

function collectSectionLines(lines: string[], startIndex: number) {
  const section: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (parseHeader(lines[i])) {
      break;
    }
    section.push(lines[i]);
  }
  return section;
}

function parseArtifactsSection(lines: string[]): CompletionArtifact[] {
  return lines
    .map((line) => parseArtifactsLine(line))
    .filter((entry): entry is CompletionArtifact => entry !== undefined);
}

function parseSummarySection(lines: string[]): string | undefined {
  const cleaned: string[] = [];

  for (const line of lines) {
    const value = normalizeListLine(line.trim());
    if (!value) {
      continue;
    }
    cleaned.push(value);
  }

  if (cleaned.length === 0) {
    return undefined;
  }

  return cleaned.join(" ");
}

function isReportPopulated(report: CompletionReport): boolean {
  return (
    Boolean(report.status) ||
    Boolean(report.confidence) ||
    Boolean(report.summary) ||
    Boolean(report.artifacts?.length) ||
    Boolean(report.blockers?.length) ||
    Boolean(report.warnings?.length)
  );
}

export function parseCompletionReport(text: string): CompletionReport | null {
  const sanitized = stripFencedCodeBlocks(String(text).trim());
  if (!sanitized.trim()) {
    return null;
  }

  const lines = sanitized.split(/\r?\n/);
  const report: CompletionReport = {};
  const seen = new Set<CompletionReportSection>();

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const header = parseHeader(lines[i]);
    if (!header) {
      continue;
    }

    const { field, value } = header;
    const sectionLines = value ? [value] : collectSectionLines(lines, i);

    if (field === "status") {
      const status = parseStatus(value);
      if (status) {
        if (seen.has(field)) {
          continue;
        }
        report.status = status;
        seen.add(field);
      }
      continue;
    }

    if (field === "confidence") {
      const confidence = parseConfidence(value);
      if (confidence) {
        if (seen.has(field)) {
          continue;
        }
        report.confidence = confidence;
        seen.add(field);
      }
      continue;
    }

    if (field === "summary") {
      const summary = parseSummarySection(sectionLines);
      if (summary) {
        if (seen.has(field)) {
          continue;
        }
        report.summary = summary;
        seen.add(field);
      }
      continue;
    }

    if (field === "artifacts") {
      const artifacts = parseArtifactsSection(sectionLines);
      if (artifacts.length > 0) {
        if (seen.has(field)) {
          continue;
        }
        report.artifacts = artifacts;
        seen.add(field);
      }
      continue;
    }

    if (field === "blockers") {
      const blockers = parseStringLines(sectionLines);
      if (blockers.length > 0) {
        if (seen.has(field)) {
          continue;
        }
        report.blockers = blockers;
        seen.add(field);
      }
      continue;
    }

    if (field === "warnings") {
      const warnings = parseStringLines(sectionLines);
      if (warnings.length > 0) {
        if (seen.has(field)) {
          continue;
        }
        report.warnings = warnings;
        seen.add(field);
      }
    }
  }

  return isReportPopulated(report) ? report : null;
}
