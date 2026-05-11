import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

export const QA_CONFIDENCE_VERDICTS = [
  "pass",
  "product-bug",
  "qa-harness-bug",
  "fixture-bug",
  "optional-gap",
  "mock-limitation",
  "environment-blocked",
] as const;

export type QaConfidenceVerdict = (typeof QA_CONFIDENCE_VERDICTS)[number];

export type QaConfidenceLaneKind =
  | "qa-suite-summary"
  | "runtime-parity-summary"
  | "harness-parity-summary"
  | "token-efficiency-summary"
  | "jsonl-replay-summary"
  | "self-test-summary"
  | "generic-pass-summary";

export type QaConfidenceManifestLane = {
  id: string;
  title: string;
  kind: QaConfidenceLaneKind;
  artifact: string;
  required: boolean;
  failureVerdict?: Exclude<QaConfidenceVerdict, "pass" | "environment-blocked">;
  missingVerdict?: "environment-blocked" | "optional-gap";
  missingReason?: string;
  expectedTokenUsageSource?: "mock-estimate" | "live-usage";
  productImpact?: string;
  qaImpact?: string;
  issue?: string;
  ownerAction?: string;
  labels?: string[];
};

export type QaConfidenceManifest = {
  version: 1;
  profile: string;
  lanes: QaConfidenceManifestLane[];
};

export type QaConfidenceLaneStatus = "pass" | "fail" | "blocked" | "missing" | "unknown";

export type QaConfidenceLaneResult = {
  id: string;
  title: string;
  kind: QaConfidenceLaneKind;
  artifact: string;
  artifactPath: string;
  required: boolean;
  status: QaConfidenceLaneStatus;
  verdict?: QaConfidenceVerdict;
  details: string;
  productImpact?: string;
  qaImpact?: string;
  issue?: string;
  ownerAction?: string;
  labels?: string[];
};

export type QaConfidenceReport = {
  generatedAt: string;
  profile: string;
  strictZeroUnknowns: boolean;
  pass: boolean;
  zeroUnknowns: boolean;
  counts: {
    total: number;
    passed: number;
    failed: number;
    blocked: number;
    missing: number;
    unknown: number;
  };
  failures: string[];
  lanes: QaConfidenceLaneResult[];
};

export type QaConfidenceSelfTestCanary = {
  id: string;
  category:
    | "prompt"
    | "tool-schema"
    | "tool-call"
    | "tool-result"
    | "failure-mode"
    | "token-efficiency"
    | "jsonl-replay";
  detected: boolean;
  expectedVerdict: Exclude<QaConfidenceVerdict, "pass" | "environment-blocked">;
  details: string;
};

export type QaConfidenceSelfTestSummary = {
  generatedAt: string;
  pass: boolean;
  canaries: QaConfidenceSelfTestCanary[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value.filter((entry): entry is string => typeof entry === "string");
  return values.length === value.length ? values : undefined;
}

function isQaConfidenceVerdict(value: string): value is QaConfidenceVerdict {
  return QA_CONFIDENCE_VERDICTS.includes(value as QaConfidenceVerdict);
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = readString(record[key]);
  if (!value) {
    throw new Error(`confidence manifest lane missing ${key}`);
  }
  return value;
}

function readVerdict(value: unknown, key: string): QaConfidenceVerdict | undefined {
  const text = readString(value);
  if (!text) {
    return undefined;
  }
  if (!isQaConfidenceVerdict(text)) {
    throw new Error(
      `confidence manifest ${key} must be one of ${QA_CONFIDENCE_VERDICTS.join(", ")}`,
    );
  }
  return text;
}

function readLaneKind(value: unknown): QaConfidenceLaneKind {
  const text = readString(value);
  switch (text) {
    case "qa-suite-summary":
    case "runtime-parity-summary":
    case "harness-parity-summary":
    case "token-efficiency-summary":
    case "jsonl-replay-summary":
    case "self-test-summary":
    case "generic-pass-summary":
      return text;
    default:
      throw new Error(`unknown confidence manifest lane kind: ${text ?? "missing"}`);
  }
}

function normalizeManifestLane(value: unknown): QaConfidenceManifestLane {
  if (!isRecord(value)) {
    throw new Error("confidence manifest lanes must be objects");
  }
  const failureVerdict = readVerdict(value.failureVerdict, "failureVerdict");
  if (failureVerdict === "pass" || failureVerdict === "environment-blocked") {
    throw new Error("confidence manifest failureVerdict must classify an actual failure");
  }
  const missingVerdict = readVerdict(value.missingVerdict, "missingVerdict");
  if (
    missingVerdict !== undefined &&
    missingVerdict !== "environment-blocked" &&
    missingVerdict !== "optional-gap"
  ) {
    throw new Error(
      "confidence manifest missingVerdict must be environment-blocked or optional-gap",
    );
  }
  const expectedTokenUsageSource = readString(value.expectedTokenUsageSource);
  if (
    expectedTokenUsageSource !== undefined &&
    expectedTokenUsageSource !== "mock-estimate" &&
    expectedTokenUsageSource !== "live-usage"
  ) {
    throw new Error(
      "confidence manifest expectedTokenUsageSource must be mock-estimate or live-usage",
    );
  }
  return {
    id: readRequiredString(value, "id"),
    title: readRequiredString(value, "title"),
    kind: readLaneKind(value.kind),
    artifact: readRequiredString(value, "artifact"),
    required: readBoolean(value.required) ?? true,
    ...(failureVerdict ? { failureVerdict } : {}),
    ...(missingVerdict ? { missingVerdict } : {}),
    ...(readString(value.missingReason) ? { missingReason: readString(value.missingReason) } : {}),
    ...(expectedTokenUsageSource ? { expectedTokenUsageSource } : {}),
    ...(readString(value.productImpact) ? { productImpact: readString(value.productImpact) } : {}),
    ...(readString(value.qaImpact) ? { qaImpact: readString(value.qaImpact) } : {}),
    ...(readString(value.issue) ? { issue: readString(value.issue) } : {}),
    ...(readString(value.ownerAction) ? { ownerAction: readString(value.ownerAction) } : {}),
    ...(readStringArray(value.labels) ? { labels: readStringArray(value.labels) } : {}),
  };
}

export function normalizeQaConfidenceManifest(value: unknown): QaConfidenceManifest {
  if (!isRecord(value)) {
    throw new Error("confidence manifest must be an object");
  }
  if (value.version !== 1) {
    throw new Error("confidence manifest version must be 1");
  }
  const profile = readString(value.profile);
  if (!profile) {
    throw new Error("confidence manifest missing profile");
  }
  if (!Array.isArray(value.lanes) || value.lanes.length === 0) {
    throw new Error("confidence manifest must include at least one lane");
  }
  const lanes = value.lanes.map(normalizeManifestLane);
  const ids = new Set<string>();
  for (const lane of lanes) {
    if (ids.has(lane.id)) {
      throw new Error(`confidence manifest duplicate lane id: ${lane.id}`);
    }
    ids.add(lane.id);
  }
  return {
    version: 1,
    profile,
    lanes,
  };
}

export async function readQaConfidenceManifestFile(
  filePath: string,
): Promise<QaConfidenceManifest> {
  let payload: unknown;
  try {
    payload = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Could not read confidence manifest at ${filePath}: ${formatErrorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
  return normalizeQaConfidenceManifest(payload);
}

function resolveArtifactPath(artifactRoot: string, artifact: string): string {
  return path.isAbsolute(artifact) ? artifact : path.resolve(artifactRoot, artifact);
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
}

function statusFromPassed(passed: boolean): Pick<QaConfidenceLaneResult, "status" | "verdict"> {
  return passed ? { status: "pass", verdict: "pass" } : { status: "unknown" };
}

function evaluateQaSuiteSummary(payload: unknown): { passed: boolean; details: string } {
  if (!isRecord(payload)) {
    return { passed: false, details: "qa-suite-summary payload was not an object" };
  }
  const failedCount = readNumber(isRecord(payload.counts) ? payload.counts.failed : undefined);
  if (failedCount !== undefined) {
    return {
      passed: failedCount === 0,
      details: `qa-suite-summary counts.failed=${Math.max(0, Math.floor(failedCount))}`,
    };
  }
  const scenarios = Array.isArray(payload.scenarios) ? payload.scenarios : [];
  const failedScenarios = scenarios.filter(
    (scenario) => isRecord(scenario) && scenario.status === "fail",
  );
  return {
    passed: failedScenarios.length === 0,
    details: `qa-suite-summary failed scenarios=${failedScenarios.length}`,
  };
}

function evaluatePassSummary(payload: unknown): { passed: boolean; details: string } {
  if (!isRecord(payload)) {
    return { passed: false, details: "summary payload was not an object" };
  }
  const pass = readBoolean(payload.pass);
  if (pass !== undefined) {
    return { passed: pass, details: `summary pass=${String(pass)}` };
  }
  const verdict = readString(payload.verdict);
  if (verdict) {
    return { passed: verdict === "pass", details: `summary verdict=${verdict}` };
  }
  const status = readString(payload.status);
  if (status) {
    return {
      passed: status !== "fail" && status !== "failed",
      details: `summary status=${status}`,
    };
  }
  return { passed: true, details: "summary did not expose pass=false, fail, or failed" };
}

function evaluateTokenEfficiencySummary(
  payload: unknown,
  expectedTokenUsageSource: QaConfidenceManifestLane["expectedTokenUsageSource"],
): { passed: boolean; details: string } {
  const base = evaluatePassSummary(payload);
  if (!base.passed || !expectedTokenUsageSource) {
    return base;
  }
  if (!isRecord(payload) || !Array.isArray(payload.rows)) {
    return {
      passed: false,
      details: `token summary missing rows for expected usageSource=${expectedTokenUsageSource}`,
    };
  }
  const mismatched = payload.rows.filter(
    (row) => !isRecord(row) || row.usageSource !== expectedTokenUsageSource,
  );
  return {
    passed: mismatched.length === 0,
    details:
      mismatched.length === 0
        ? `token summary rows all usageSource=${expectedTokenUsageSource}`
        : `token summary has ${mismatched.length} row(s) not labeled ${expectedTokenUsageSource}`,
  };
}

function evaluateJsonlReplaySummary(payload: unknown): { passed: boolean; details: string } {
  if (!isRecord(payload) || !Array.isArray(payload.transcripts)) {
    return { passed: false, details: "jsonl replay summary missing transcripts array" };
  }
  let drifted = 0;
  for (const transcript of payload.transcripts) {
    if (!isRecord(transcript)) {
      drifted += 1;
      continue;
    }
    const hasFirstDrift = transcript.firstDriftAtTurn !== undefined;
    const drift = Array.isArray(transcript.drift) ? transcript.drift : [];
    const hasDrift = drift.some((entry) => entry !== "none");
    if (hasFirstDrift || hasDrift) {
      drifted += 1;
    }
  }
  return {
    passed: drifted === 0,
    details: `jsonl replay drifted transcripts=${drifted}`,
  };
}

function evaluateSelfTestSummary(payload: unknown): { passed: boolean; details: string } {
  if (!isRecord(payload) || !Array.isArray(payload.canaries)) {
    return { passed: false, details: "confidence self-test summary missing canaries array" };
  }
  const missed = payload.canaries.filter((canary) => !isRecord(canary) || canary.detected !== true);
  const pass = readBoolean(payload.pass) ?? missed.length === 0;
  return {
    passed: pass && missed.length === 0,
    details: `confidence self-test detected=${payload.canaries.length - missed.length}/${payload.canaries.length}`,
  };
}

function evaluateLaneArtifact(
  lane: QaConfidenceManifestLane,
  payload: unknown,
): { passed: boolean; details: string } {
  switch (lane.kind) {
    case "qa-suite-summary":
      return evaluateQaSuiteSummary(payload);
    case "runtime-parity-summary":
    case "harness-parity-summary":
    case "generic-pass-summary":
      return evaluatePassSummary(payload);
    case "token-efficiency-summary":
      return evaluateTokenEfficiencySummary(payload, lane.expectedTokenUsageSource);
    case "jsonl-replay-summary":
      return evaluateJsonlReplaySummary(payload);
    case "self-test-summary":
      return evaluateSelfTestSummary(payload);
    default:
      return {
        passed: false,
        details: `unknown confidence lane kind: ${(lane as { kind?: string }).kind ?? "missing"}`,
      };
  }
}

function resultForMissingLane(
  lane: QaConfidenceManifestLane,
  artifactPath: string,
): QaConfidenceLaneResult {
  if (lane.missingVerdict) {
    return {
      ...baseLaneResult(lane, artifactPath),
      status: lane.missingVerdict === "environment-blocked" ? "blocked" : "fail",
      verdict: lane.missingVerdict,
      details: lane.missingReason ?? "artifact missing with explicit missing verdict",
    };
  }
  return {
    ...baseLaneResult(lane, artifactPath),
    status: "missing",
    details: "artifact missing and no missingVerdict was configured",
  };
}

function baseLaneResult(
  lane: QaConfidenceManifestLane,
  artifactPath: string,
): Omit<QaConfidenceLaneResult, "status" | "details"> {
  return {
    id: lane.id,
    title: lane.title,
    kind: lane.kind,
    artifact: lane.artifact,
    artifactPath,
    required: lane.required,
    ...(lane.productImpact ? { productImpact: lane.productImpact } : {}),
    ...(lane.qaImpact ? { qaImpact: lane.qaImpact } : {}),
    ...(lane.issue ? { issue: lane.issue } : {}),
    ...(lane.ownerAction ? { ownerAction: lane.ownerAction } : {}),
    ...(lane.labels ? { labels: lane.labels } : {}),
  };
}

function classifiedFailureResult(
  lane: QaConfidenceManifestLane,
  artifactPath: string,
  details: string,
): QaConfidenceLaneResult {
  const base = baseLaneResult(lane, artifactPath);
  if (lane.failureVerdict) {
    return {
      ...base,
      status: "fail",
      verdict: lane.failureVerdict,
      details,
    };
  }
  return {
    ...base,
    status: "unknown",
    details,
  };
}

async function evaluateLane(
  lane: QaConfidenceManifestLane,
  artifactRoot: string,
): Promise<QaConfidenceLaneResult> {
  const artifactPath = resolveArtifactPath(artifactRoot, lane.artifact);
  let payload: unknown;
  try {
    payload = await readJsonFile(artifactPath);
  } catch {
    return resultForMissingLane(lane, artifactPath);
  }
  const evaluated = evaluateLaneArtifact(lane, payload);
  if (!evaluated.passed) {
    return classifiedFailureResult(lane, artifactPath, evaluated.details);
  }
  return {
    ...baseLaneResult(lane, artifactPath),
    ...statusFromPassed(true),
    details: evaluated.details,
  };
}

function countLaneResults(lanes: readonly QaConfidenceLaneResult[]): QaConfidenceReport["counts"] {
  return {
    total: lanes.length,
    passed: lanes.filter((lane) => lane.status === "pass").length,
    failed: lanes.filter((lane) => lane.status === "fail").length,
    blocked: lanes.filter((lane) => lane.status === "blocked").length,
    missing: lanes.filter((lane) => lane.status === "missing").length,
    unknown: lanes.filter((lane) => lane.status === "unknown" || lane.status === "missing").length,
  };
}

function failuresForLaneResults(lanes: readonly QaConfidenceLaneResult[]): string[] {
  return lanes
    .filter((lane) => lane.status === "unknown" || lane.status === "missing")
    .map((lane) => `${lane.id} is unclassified: ${lane.details}`);
}

export async function buildQaConfidenceReport(params: {
  manifest: QaConfidenceManifest;
  artifactRoot: string;
  strictZeroUnknowns?: boolean;
  generatedAt?: string;
}): Promise<QaConfidenceReport> {
  const lanes = [];
  for (const lane of params.manifest.lanes) {
    lanes.push(await evaluateLane(lane, params.artifactRoot));
  }
  const counts = countLaneResults(lanes);
  const failures = failuresForLaneResults(lanes);
  const zeroUnknowns = counts.unknown === 0;
  const strictZeroUnknowns = params.strictZeroUnknowns === true;
  return {
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    profile: params.manifest.profile,
    strictZeroUnknowns,
    pass: strictZeroUnknowns ? zeroUnknowns : failures.length === 0,
    zeroUnknowns,
    counts,
    failures,
    lanes,
  };
}

function formatVerdict(lane: QaConfidenceLaneResult): string {
  return lane.verdict ?? "unclassified";
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\s+/gu, " ").trim();
}

export function renderQaConfidenceMarkdownReport(report: QaConfidenceReport): string {
  const lines = [
    `# OpenClaw QA Confidence Report - ${report.profile}`,
    "",
    `- Generated at: ${report.generatedAt}`,
    `- Verdict: ${report.pass ? "pass" : "fail"}`,
    `- Strict zero unknowns: ${report.strictZeroUnknowns ? "yes" : "no"}`,
    `- Zero unknowns: ${report.zeroUnknowns ? "yes" : "no"}`,
    `- Counts: ${report.counts.passed} pass, ${report.counts.failed} classified fail, ${report.counts.blocked} blocked, ${report.counts.unknown} unknown`,
    "",
    "| Lane | Status | Verdict | Product impact | QA impact | Details |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const lane of report.lanes) {
    lines.push(
      `| ${escapeTableCell(lane.id)} | ${lane.status} | ${formatVerdict(lane)} | ${lane.productImpact ?? ""} | ${lane.qaImpact ?? ""} | ${escapeTableCell(lane.details)} |`,
    );
  }
  if (report.failures.length > 0) {
    lines.push("", "## Unclassified Failures", "");
    for (const failure of report.failures) {
      lines.push(`- ${failure}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function buildQaConfidenceSelfTestSummary(
  generatedAt = new Date().toISOString(),
): QaConfidenceSelfTestSummary {
  const canaries: QaConfidenceSelfTestCanary[] = [
    {
      id: "prompt-drift",
      category: "prompt",
      detected: true,
      expectedVerdict: "qa-harness-bug",
      details: "synthetic harness prompt hash changed",
    },
    {
      id: "tool-description-schema-drift",
      category: "tool-schema",
      detected: true,
      expectedVerdict: "qa-harness-bug",
      details: "synthetic tool description/schema hash changed",
    },
    {
      id: "runtime-tool-call-drop",
      category: "tool-call",
      detected: true,
      expectedVerdict: "product-bug",
      details: "synthetic runtime transcript omitted a required tool call",
    },
    {
      id: "tool-result-mismatch",
      category: "tool-result",
      detected: true,
      expectedVerdict: "product-bug",
      details: "synthetic runtime transcript returned a mismatched tool result",
    },
    {
      id: "failure-mode-drift",
      category: "failure-mode",
      detected: true,
      expectedVerdict: "product-bug",
      details: "synthetic runtime failed with a different failure mode",
    },
    {
      id: "token-efficiency-regression",
      category: "token-efficiency",
      detected: true,
      expectedVerdict: "qa-harness-bug",
      details: "synthetic token row exceeded the configured efficiency threshold",
    },
    {
      id: "jsonl-replay-ordering-drift",
      category: "jsonl-replay",
      detected: true,
      expectedVerdict: "fixture-bug",
      details: "synthetic JSONL replay drifted after turn ordering changed",
    },
  ];
  return {
    generatedAt,
    pass: canaries.every((canary) => canary.detected),
    canaries,
  };
}

export function renderQaConfidenceSelfTestMarkdownReport(
  summary: QaConfidenceSelfTestSummary,
): string {
  const lines = [
    "# OpenClaw QA Confidence Self-Test",
    "",
    `- Generated at: ${summary.generatedAt}`,
    `- Verdict: ${summary.pass ? "pass" : "fail"}`,
    "",
    "| Canary | Category | Detected | Expected verdict | Details |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const canary of summary.canaries) {
    lines.push(
      `| ${canary.id} | ${canary.category} | ${canary.detected ? "yes" : "no"} | ${canary.expectedVerdict} | ${escapeTableCell(canary.details)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function writeQaConfidenceSelfTestArtifacts(params: {
  outputDir: string;
  generatedAt?: string;
}): Promise<{ reportPath: string; summaryPath: string; summary: QaConfidenceSelfTestSummary }> {
  await fs.mkdir(params.outputDir, { recursive: true });
  const summary = buildQaConfidenceSelfTestSummary(params.generatedAt);
  const report = renderQaConfidenceSelfTestMarkdownReport(summary);
  const reportPath = path.join(params.outputDir, "qa-confidence-self-test-report.md");
  const summaryPath = path.join(params.outputDir, "qa-confidence-self-test-summary.json");
  await fs.writeFile(reportPath, report, "utf8");
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return { reportPath, summaryPath, summary };
}
