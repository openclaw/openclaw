export type CanonicalStateStatus = {
  raw: unknown;
  label: string;
  key: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function titleCaseStatus(value: string): string {
  const lowerWords = new Set(["and", "or", "of", "the"]);
  return value
    .split(" ")
    .filter(Boolean)
    .map((word, index) => {
      const lower = word.toLowerCase();
      return index > 0 && lowerWords.has(lower)
        ? lower
        : `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
    })
    .join(" ");
}

function canonicalStatusText(value: unknown, depth = 0): string | undefined {
  if (depth > 4) {
    return undefined;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value).trim();
    return text || undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = canonicalStatusText(entry, depth + 1);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of [
    "state",
    "status",
    "phase",
    "value",
    "label",
    "name",
    "normalized",
    "display",
    "text",
    "title",
  ]) {
    const nested = canonicalStatusText(value[key], depth + 1);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

export function firstCanonicalStateStatusValue(values: unknown[]): unknown {
  for (const value of values) {
    if (canonicalStatusText(value)) {
      return value;
    }
  }
  return undefined;
}

export function normalizeCanonicalStateStatus(value: unknown): CanonicalStateStatus {
  const rawText = canonicalStatusText(value) ?? "unknown";
  const normalized = rawText.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const lowered = normalized.toLowerCase();
  const aliases: Record<string, string> = {
    active: "In Progress",
    block: "Blocked",
    blocked: "Blocked",
    complete: "Done",
    completed: "Done",
    done: "Done",
    "human review": "Human Review",
    humanreview: "Human Review",
    "in progress": "In Progress",
    open: "Open",
    pending: "Pending",
    ready: "Ready",
    "ready for human approval": "Ready for Human Approval",
    review: "Human Review",
    running: "In Progress",
    todo: "Pending",
    unknown: "Unknown",
  };
  const label = aliases[lowered] ?? titleCaseStatus(normalized || "unknown");
  return {
    raw: value,
    label,
    key: label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, ""),
  };
}
