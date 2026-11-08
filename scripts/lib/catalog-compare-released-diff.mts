// Diff of what released OpenClaw readers do with a baseline vs a candidate catalog bundle.

export type CapturedCall = {
  method: string;
  url: string;
  headers: Record<string, unknown>;
  body: unknown;
};

export type RowObservation = {
  model: string;
  source?: string;
  runtimeModel?: unknown;
  error?: string;
  profiles: Record<"openclaw" | "codex", { offered: string[]; default: string | null }>;
  requests: Record<string, { calls: CapturedCall[]; outcome: string }>;
};

export type ReleaseRun = {
  version: string;
  refresh: Record<string, unknown>;
  rows: RowObservation[];
};

export type Change = {
  release: string;
  model: string;
  level: string;
  field: string;
  before: unknown;
  after: unknown;
};

const NO_LEVEL = "-";

function flatten(value: unknown, field: string, into: Map<string, unknown>): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length > 0) {
      for (const [key, child] of entries) {
        flatten(child, `${field}.${key}`, into);
      }
      return;
    }
  }
  into.set(field, value);
}

/** Every observed fact as model + level + field → value. */
function flattenRun(run: ReleaseRun): Map<string, unknown> {
  const facts = new Map<string, unknown>();
  const put = (model: string, level: string, field: string, value: unknown) => {
    const fields = new Map<string, unknown>();
    flatten(value, field, fields);
    for (const [name, leaf] of fields) {
      facts.set(JSON.stringify([model, level, name]), leaf);
    }
  };
  put("(catalog)", NO_LEVEL, "refresh.status", run.refresh.status);
  put("(catalog)", NO_LEVEL, "refresh.error", run.refresh.error);
  for (const row of run.rows) {
    put(row.model, NO_LEVEL, "row", "listed");
    put(row.model, NO_LEVEL, "error", row.error);
    put(row.model, NO_LEVEL, "model.source", row.source);
    put(row.model, NO_LEVEL, "model", row.runtimeModel);
    for (const [runtime, profile] of Object.entries(row.profiles)) {
      put(row.model, NO_LEVEL, `${runtime}.offered`, profile.offered);
      put(row.model, NO_LEVEL, `${runtime}.default`, profile.default);
    }
    for (const [level, request] of Object.entries(row.requests)) {
      put(row.model, level, "request.outcome", request.outcome);
      request.calls.forEach((call, index) => {
        put(row.model, level, index === 0 ? "request" : `request#${index + 1}`, call);
      });
    }
  }
  return facts;
}

export function diffRuns(before: ReleaseRun, after: ReleaseRun): Change[] {
  const a = flattenRun(before);
  const b = flattenRun(after);
  const changes: Change[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const [model, level, field] = JSON.parse(key) as [string, string, string];
    const was = a.get(key);
    const now = b.get(key);
    if (JSON.stringify(was) !== JSON.stringify(now)) {
      changes.push({ release: after.version, model, level, field, before: was, after: now });
    }
  }
  return changes.toSorted(
    (x, y) =>
      x.model.localeCompare(y.model) ||
      x.level.localeCompare(y.level) ||
      x.field.localeCompare(y.field),
  );
}

function show(value: unknown): string {
  if (value === undefined) {
    return "(absent)";
  }
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** One line per changed field; an added or dropped row is one line (`--json` keeps its fields). */
export function formatReport(
  releases: Array<{
    release: string;
    label: string;
    changes: Change[];
    omittedProviders?: string[];
  }>,
): string {
  const lines: string[] = [];
  for (const { release, label, changes, omittedProviders = [] } of releases) {
    lines.push(
      `${release} (${label}): ${changes.length === 0 ? "no behavior change" : `${changes.length} changed fields`}`,
    );
    if (omittedProviders.length > 0) {
      lines.push(`  not published at ${release}, not compared: ${omittedProviders.join(", ")}`);
    }
    const rowChanges = new Map(
      changes.filter((change) => change.field === "row").map((change) => [change.model, change]),
    );
    for (const change of changes) {
      const row = rowChanges.get(change.model);
      if (row && change !== row) {
        continue;
      }
      const fields = row ? changes.filter((other) => other.model === change.model).length : 0;
      lines.push(
        `  ${change.model}  ${change.level}  ${change.field}: ${show(change.before)} → ${show(change.after)}${row ? ` (${fields} fields)` : ""}`,
      );
    }
  }
  return lines.join("\n");
}
