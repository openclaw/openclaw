import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  firstCanonicalStateStatusValue as firstStatusValue,
  normalizeCanonicalStateStatus,
  type CanonicalStateStatus,
} from "./orchestrator-state-status.js";
export {
  normalizeCanonicalStateStatus,
  type CanonicalStateStatus,
} from "./orchestrator-state-status.js";

export const CANONICAL_ORCHESTRATOR_STATE_QUERY_HELPER_ID =
  "canonical-orchestrator-state-query" as const;
export const CANONICAL_ORCHESTRATOR_STATE_QUERY_HELPER_VERSION = 1 as const;
export const STATE_DERIVED_STALE = "STATE_DERIVED_STALE" as const;

export type CanonicalStateIssue = {
  id: string;
  path: string;
  sha256: string;
  mtimeMs: number;
  status: CanonicalStateStatus;
  diagnostics?: string[];
  rootIssue?: string;
  activeTaskContractId?: string;
  authorizedRootIssue?: string;
  authorizationSourceHash?: string;
};

export type CanonicalStateOrchestrator = {
  path: string;
  sha256: string;
  mtimeMs: number;
  phase: CanonicalStateStatus;
  statusText?: string;
  activeTaskContractId?: string;
  authorizedRootIssue?: string;
  authorizationSourceHash?: string;
};

export type CanonicalRenderStateSummary = {
  phase: CanonicalStateStatus;
  statusText: string;
  counts: {
    running: number;
    blocked: number;
    review: number;
  };
  issueIds: {
    running: string[];
    blocked: string[];
    review: string[];
  };
};

export type CanonicalDerivedState = {
  path: string;
  sha256: string;
  mtimeMs: number;
  status?: CanonicalStateStatus;
  statusText?: string;
  stale: boolean;
  reasonCode?: typeof STATE_DERIVED_STALE;
};

export type CanonicalOrchestratorStateQuery = {
  helperId: typeof CANONICAL_ORCHESTRATOR_STATE_QUERY_HELPER_ID;
  helperVersion: typeof CANONICAL_ORCHESTRATOR_STATE_QUERY_HELPER_VERSION;
  ok: boolean;
  stateDir: string;
  rootIssue?: string;
  queriedAt: string;
  orchestrator?: CanonicalStateOrchestrator;
  issues: CanonicalStateIssue[];
  selectedIssue?: CanonicalStateIssue;
  issueStateHash?: string;
  renderState: CanonicalRenderStateSummary;
  derivedState?: CanonicalDerivedState;
  derivedStateStale: boolean;
  staleByAge: boolean;
  missing: string[];
  errors: string[];
};

type FileSnapshot = {
  path: string;
  content: string;
  sha256: string;
  mtimeMs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function readFileSnapshot(filePath: string): FileSnapshot | undefined {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const stat = fs.statSync(filePath);
    return {
      path: filePath,
      content,
      sha256: sha256(content),
      mtimeMs: stat.mtimeMs,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

function parseJsonSnapshot(snapshot: FileSnapshot): unknown {
  return JSON.parse(snapshot.content) as unknown;
}

function recordStringAt(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const direct = trimString(record[key]);
    if (direct) {
      return direct;
    }
  }
  return undefined;
}

function nestedStringAt(record: Record<string, unknown>, paths: string[][]): string | undefined {
  for (const keys of paths) {
    let current: unknown = record;
    for (const key of keys) {
      if (!isRecord(current)) {
        current = undefined;
        break;
      }
      current = current[key];
    }
    const value = trimString(current);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function diagnosticText(value: unknown): string {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim().slice(0, 240) || "(empty)";
  }
  try {
    return JSON.stringify(value).slice(0, 240);
  } catch {
    return String(value).slice(0, 240);
  }
}

function issueDiagnostics(record: Record<string, unknown>): string[] | undefined {
  const diagnostics: string[] = [];
  const status = isRecord(record.status) ? record.status : undefined;
  for (const [label, value] of [
    ["status.finalizer", status?.finalizer],
    ["status.pathValidation", status?.pathValidation],
    ["status.validationError", status?.validationError ?? status?.error],
    ["finalizer", record.finalizer],
    ["pathValidation", record.pathValidation],
    ["validationError", record.validationError ?? record.error],
  ] as const) {
    if (value != null) {
      diagnostics.push(`${label}:${diagnosticText(value)}`);
    }
  }
  return diagnostics.length > 0 ? diagnostics : undefined;
}

function normalizeIssueRecord(snapshot: FileSnapshot, json: unknown): CanonicalStateIssue {
  const record = isRecord(json) ? json : {};
  const id =
    recordStringAt(record, ["id", "issueId", "key", "name"]) ??
    path.basename(snapshot.path).replace(/\.json$/i, "");
  const statusValue = firstStatusValue([
    record.state,
    record.status,
    record.phase,
    isRecord(record.workflow) ? record.workflow.status : undefined,
    isRecord(record.metadata) ? record.metadata.status : undefined,
  ]);
  const rootIssue = recordStringAt(record, [
    "rootIssue",
    "authorizedRootIssue",
    "root",
    "parentIssue",
  ]);
  const diagnostics = issueDiagnostics(record);
  return {
    id,
    path: snapshot.path,
    sha256: snapshot.sha256,
    mtimeMs: snapshot.mtimeMs,
    status: normalizeCanonicalStateStatus(statusValue),
    ...(diagnostics ? { diagnostics } : {}),
    ...(rootIssue ? { rootIssue } : {}),
    ...(recordStringAt(record, ["activeTaskContractId", "authorizationContractId"])
      ? {
          activeTaskContractId: recordStringAt(record, [
            "activeTaskContractId",
            "authorizationContractId",
          ]),
        }
      : {}),
    ...(recordStringAt(record, ["authorizedRootIssue"]) ||
    nestedStringAt(record, [["authorization", "authorizedRootIssue"]])
      ? {
          authorizedRootIssue:
            recordStringAt(record, ["authorizedRootIssue"]) ??
            nestedStringAt(record, [["authorization", "authorizedRootIssue"]]),
        }
      : {}),
    ...(recordStringAt(record, ["authorizationSourceHash", "authSourceHash"]) ||
    nestedStringAt(record, [
      ["authorization", "sourceHash"],
      ["authorization", "authorizationSourceHash"],
    ])
      ? {
          authorizationSourceHash:
            recordStringAt(record, ["authorizationSourceHash", "authSourceHash"]) ??
            nestedStringAt(record, [
              ["authorization", "sourceHash"],
              ["authorization", "authorizationSourceHash"],
            ]),
        }
      : {}),
  };
}

function normalizeOrchestratorRecord(
  snapshot: FileSnapshot,
  json: unknown,
): CanonicalStateOrchestrator {
  const record = isRecord(json) ? json : {};
  const phaseValue = firstStatusValue([record.phase, record.state, record.status]);
  const statusText = trimString(record.status);
  return {
    path: snapshot.path,
    sha256: snapshot.sha256,
    mtimeMs: snapshot.mtimeMs,
    phase: normalizeCanonicalStateStatus(phaseValue),
    ...(statusText ? { statusText } : {}),
    ...(recordStringAt(record, ["activeTaskContractId", "authorizationContractId"])
      ? {
          activeTaskContractId: recordStringAt(record, [
            "activeTaskContractId",
            "authorizationContractId",
          ]),
        }
      : {}),
    ...(recordStringAt(record, ["authorizedRootIssue", "rootIssue"]) ||
    nestedStringAt(record, [["authorization", "authorizedRootIssue"]])
      ? {
          authorizedRootIssue:
            recordStringAt(record, ["authorizedRootIssue", "rootIssue"]) ??
            nestedStringAt(record, [["authorization", "authorizedRootIssue"]]),
        }
      : {}),
    ...(recordStringAt(record, ["authorizationSourceHash", "authSourceHash"]) ||
    nestedStringAt(record, [
      ["authorization", "sourceHash"],
      ["authorization", "authorizationSourceHash"],
    ])
      ? {
          authorizationSourceHash:
            recordStringAt(record, ["authorizationSourceHash", "authSourceHash"]) ??
            nestedStringAt(record, [
              ["authorization", "sourceHash"],
              ["authorization", "authorizationSourceHash"],
            ]),
        }
      : {}),
  };
}

function selectIssue(
  issues: CanonicalStateIssue[],
  rootIssue: string | undefined,
): CanonicalStateIssue | undefined {
  if (!rootIssue) {
    return issues[0];
  }
  return issues.find(
    (issue) =>
      issue.id === rootIssue ||
      issue.rootIssue === rootIssue ||
      issue.authorizedRootIssue === rootIssue,
  );
}

function renderStateSummary(
  orchestrator: CanonicalStateOrchestrator | undefined,
  issues: CanonicalStateIssue[],
): CanonicalRenderStateSummary {
  const idsFor = (key: string) =>
    issues
      .filter((issue) => issue.status.key === key)
      .map((issue) => issue.id)
      .sort();
  const running = idsFor("in-progress");
  const blocked = idsFor("blocked");
  const review = idsFor("human-review");
  const phase =
    orchestrator?.phase ??
    normalizeCanonicalStateStatus(
      blocked.length ? "blocked" : running.length ? "executing" : "ready",
    );
  const statusText =
    orchestrator?.statusText ??
    (blocked.length
      ? `Blocked on ${blocked.length} issue(s).`
      : running.length
        ? `Executing ${running.length} issue(s).`
        : review.length
          ? `Waiting on human review for ${review.length} issue(s).`
          : "No active issues.");
  return {
    phase,
    statusText,
    counts: { running: running.length, blocked: blocked.length, review: review.length },
    issueIds: { running, blocked, review },
  };
}

function markdownSectionValue(content: string, heading: string): string | undefined {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim().toLowerCase() !== `## ${heading.toLowerCase()}`) {
      continue;
    }
    for (const value of lines.slice(index + 1)) {
      const trimmed = value.trim();
      if (trimmed.startsWith("## ")) {
        return undefined;
      }
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function comparableDerivedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseDerivedState(
  snapshot: FileSnapshot,
  renderState: CanonicalRenderStateSummary,
): CanonicalDerivedState {
  const phaseMatch =
    markdownSectionValue(snapshot.content, "Phase") ??
    /(?:^|\n)\s*phase\s*[:=]\s*([^\n#]+)/i.exec(snapshot.content)?.[1];
  const statusText = markdownSectionValue(snapshot.content, "Status");
  const fallbackStatusMatch =
    statusText ??
    /(?:^|\n)\s*(?:status|state)\s*[:=]\s*([^\n#]+)/i.exec(snapshot.content)?.[1] ??
    /\b(ready|blocked|human[\s_-]*review|in[\s_-]*progress|done|complete(?:d)?)\b/i.exec(
      snapshot.content,
    )?.[1];
  const statusMatch = phaseMatch ?? fallbackStatusMatch;
  const status = statusMatch ? normalizeCanonicalStateStatus(statusMatch) : undefined;
  const phaseStale = Boolean(status && status.key !== renderState.phase.key);
  const statusTextStale = Boolean(
    statusText &&
    comparableDerivedText(statusText) !== comparableDerivedText(renderState.statusText),
  );
  const stale = phaseStale || statusTextStale;
  return {
    path: snapshot.path,
    sha256: snapshot.sha256,
    mtimeMs: snapshot.mtimeMs,
    ...(status ? { status } : {}),
    ...(statusText ? { statusText } : {}),
    stale,
    ...(stale ? { reasonCode: STATE_DERIVED_STALE } : {}),
  };
}

function issueStateHashFor(issues: CanonicalStateIssue[]): string | undefined {
  if (issues.length === 0) {
    return undefined;
  }
  return sha256(
    JSON.stringify(
      issues.map((issue) => ({ id: issue.id, path: issue.path, sha256: issue.sha256 })),
    ),
  );
}

export function queryCanonicalOrchestratorState(params: {
  stateDir: string;
  rootIssue?: string;
  orchestratorPath?: string;
  issuesDir?: string;
  stateMdPath?: string;
  nowMs?: number;
  maxAgeMs?: number;
}): CanonicalOrchestratorStateQuery {
  const stateDir = path.resolve(params.stateDir);
  const orchestratorPath = path.resolve(
    params.orchestratorPath ?? path.join(stateDir, "orchestrator.json"),
  );
  const issuesDir = path.resolve(params.issuesDir ?? path.join(stateDir, "issues"));
  const stateMdPath = path.resolve(
    params.stateMdPath ?? path.join(path.dirname(stateDir), "STATE.md"),
  );
  const missing: string[] = [];
  const errors: string[] = [];
  const issues: CanonicalStateIssue[] = [];
  let orchestrator: CanonicalStateOrchestrator | undefined;
  let derivedState: CanonicalDerivedState | undefined;

  try {
    const snapshot = readFileSnapshot(orchestratorPath);
    if (!snapshot) {
      missing.push(orchestratorPath);
    } else {
      orchestrator = normalizeOrchestratorRecord(snapshot, parseJsonSnapshot(snapshot));
    }
  } catch (err) {
    errors.push(`ORCHESTRATOR_STATE_READ_FAILED:${orchestratorPath}:${String(err)}`);
  }

  try {
    const entries = fs.existsSync(issuesDir)
      ? fs.readdirSync(issuesDir, { withFileTypes: true })
      : undefined;
    if (!entries) {
      missing.push(issuesDir);
    } else {
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }
        const issuePath = path.join(issuesDir, entry.name);
        try {
          const snapshot = readFileSnapshot(issuePath);
          if (snapshot) {
            issues.push(normalizeIssueRecord(snapshot, parseJsonSnapshot(snapshot)));
          }
        } catch (err) {
          errors.push(`ISSUE_STATE_READ_FAILED:${issuePath}:${String(err)}`);
        }
      }
      if (issues.length === 0) {
        missing.push(`${issuesDir}/*.json`);
      }
    }
  } catch (err) {
    errors.push(`ISSUES_STATE_LIST_FAILED:${issuesDir}:${String(err)}`);
  }

  const renderState = renderStateSummary(orchestrator, issues);

  try {
    const stateMd = readFileSnapshot(stateMdPath);
    if (stateMd) {
      derivedState = parseDerivedState(stateMd, renderState);
    }
  } catch (err) {
    errors.push(`DERIVED_STATE_READ_FAILED:${stateMdPath}:${String(err)}`);
  }

  const rootIssue = params.rootIssue?.trim() || undefined;
  const selectedIssue = selectIssue(issues, rootIssue);
  if (rootIssue && !selectedIssue) {
    missing.push(`issue:${rootIssue}`);
  }
  const queriedIssues = selectedIssue ? [selectedIssue] : issues;
  const issueStateHash = issueStateHashFor(queriedIssues);
  const nowMs = Number.isFinite(params.nowMs) ? Number(params.nowMs) : Date.now();
  const maxAgeMs = Number.isFinite(params.maxAgeMs) ? Number(params.maxAgeMs) : undefined;
  const staleByAge = Boolean(
    maxAgeMs != null &&
    maxAgeMs >= 0 &&
    [orchestrator?.mtimeMs, ...queriedIssues.map((issue) => issue.mtimeMs)]
      .filter((mtime): mtime is number => typeof mtime === "number")
      .some((mtime) => nowMs - mtime > maxAgeMs),
  );
  const derivedStateStale = derivedState?.stale === true;
  return {
    helperId: CANONICAL_ORCHESTRATOR_STATE_QUERY_HELPER_ID,
    helperVersion: CANONICAL_ORCHESTRATOR_STATE_QUERY_HELPER_VERSION,
    ok: Boolean(
      orchestrator && selectedIssue && errors.length === 0 && !derivedStateStale && !staleByAge,
    ),
    stateDir,
    ...(rootIssue ? { rootIssue } : {}),
    queriedAt: new Date(nowMs).toISOString(),
    ...(orchestrator ? { orchestrator } : {}),
    issues,
    ...(selectedIssue ? { selectedIssue } : {}),
    ...(issueStateHash ? { issueStateHash } : {}),
    renderState,
    ...(derivedState ? { derivedState } : {}),
    derivedStateStale,
    staleByAge,
    missing,
    errors,
  };
}

export function checkCanonicalOrchestratorStateAtStartup(
  params: Parameters<typeof queryCanonicalOrchestratorState>[0],
): {
  ok: boolean;
  query: CanonicalOrchestratorStateQuery;
  reasonCode?: typeof STATE_DERIVED_STALE;
} {
  const query = queryCanonicalOrchestratorState(params);
  return {
    ok: query.ok,
    query,
    ...(query.derivedStateStale ? { reasonCode: STATE_DERIVED_STALE } : {}),
  };
}
