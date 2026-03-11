import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { stableStringify } from "../stable-stringify.js";
import {
  getExecutionSandboxTemplate,
  isExecutionSandboxTemplateId,
  materializeExecutionSandboxTemplate,
  type ExecutionSandboxTemplateId,
} from "./execution-template.js";

export const SIMULATION_LANE_MANIFEST_FILENAME = "simulation-lane.json";
export const SIMULATION_LANE_LOG_FILENAME = "decision-log.jsonl";
export const SIMULATION_LANE_WORKSPACE_DIRNAME = "workspace";

export type SimulationLaneMode = "historical-replay" | "backtest";

export type SimulationLaneCostAssumptions = {
  feesBps: number;
  slippageBps: number;
  spreadBps?: number;
  fundingBpsPerDay?: number;
  borrowBpsPerDay?: number;
  latencyMs?: number;
  partialFillRate?: number;
  marketImpactBps?: number;
};

export type SimulationLaneRequest = {
  laneId: string;
  objective: string;
  mode: SimulationLaneMode;
  venue: string;
  instrument: string;
  timeframe: string;
  templateId: ExecutionSandboxTemplateId;
  window: {
    start: string;
    end: string;
  };
  costAssumptions: SimulationLaneCostAssumptions;
  notes?: string;
};

export type SimulationLaneValidationIssue = {
  path: string;
  message: string;
};

export type SimulationLaneManifest = SimulationLaneRequest & {
  version: 1;
  createdAt: string;
  liveExecutionAllowed: false;
  templateFingerprint: string;
  artifacts: {
    manifestFile: typeof SIMULATION_LANE_MANIFEST_FILENAME;
    decisionLogFile: typeof SIMULATION_LANE_LOG_FILENAME;
    workspaceDir: typeof SIMULATION_LANE_WORKSPACE_DIRNAME;
  };
};

export type SimulationLaneMetadataPayload = {
  manifestHash: string;
  laneId: string;
  mode: SimulationLaneMode;
  venue: string;
  instrument: string;
  timeframe: string;
  window: SimulationLaneRequest["window"];
  costAssumptions: SimulationLaneCostAssumptions;
  templateId: ExecutionSandboxTemplateId;
  templateFingerprint: string;
  liveExecutionAllowed: false;
};

export type SimulationLaneDecisionPayload = {
  stepId: string;
  decidedAt: string;
  action: string;
  rationale: string;
  confidence?: number;
  inputs?: Record<string, unknown>;
};

export type SimulationLaneOutcomePayload = {
  stepId: string;
  recordedAt: string;
  status: "accepted" | "rejected" | "error";
  summary?: string;
  metrics?: Record<string, number>;
};

export type SimulationLaneLogKind = "metadata" | "decision" | "outcome";

export type SimulationLaneLogPayloadByKind = {
  metadata: SimulationLaneMetadataPayload;
  decision: SimulationLaneDecisionPayload;
  outcome: SimulationLaneOutcomePayload;
};

export type SimulationLaneLogEntry<TKind extends SimulationLaneLogKind = SimulationLaneLogKind> = {
  seq: number;
  kind: TKind;
  recordedAt: string;
  prevHash: string | null;
  hash: string;
  payload: SimulationLaneLogPayloadByKind[TKind];
};

export type SimulationLaneVerificationResult =
  | { ok: true }
  | { ok: false; index: number; message: string };

export type MaterializedSimulationLane = {
  manifest: SimulationLaneManifest;
  metadataEntry: SimulationLaneLogEntry<"metadata">;
  manifestPath: string;
  decisionLogPath: string;
  workspaceDir: string;
};

export function validateSimulationLaneRequest(
  request: SimulationLaneRequest,
): SimulationLaneValidationIssue[] {
  const issues: SimulationLaneValidationIssue[] = [];

  requireNonEmptyString(issues, "laneId", request.laneId);
  requireNonEmptyString(issues, "objective", request.objective);
  requireNonEmptyString(issues, "venue", request.venue);
  requireNonEmptyString(issues, "instrument", request.instrument);
  requireNonEmptyString(issues, "timeframe", request.timeframe);
  requireNonEmptyString(issues, "window.start", request.window?.start);
  requireNonEmptyString(issues, "window.end", request.window?.end);

  if (!isExecutionSandboxTemplateId(request.templateId)) {
    issues.push({
      path: "templateId",
      message: `Unknown execution sandbox template: ${String(request.templateId)}`,
    });
  }

  const startMs = parseTimestamp(request.window?.start);
  const endMs = parseTimestamp(request.window?.end);
  if (startMs === null) {
    issues.push({ path: "window.start", message: "window.start must be a valid ISO timestamp." });
  }
  if (endMs === null) {
    issues.push({ path: "window.end", message: "window.end must be a valid ISO timestamp." });
  }
  if (startMs !== null && endMs !== null && startMs >= endMs) {
    issues.push({
      path: "window.end",
      message: "window.end must be later than window.start for historical replay/backtesting.",
    });
  }

  requireFiniteNonNegativeNumber(
    issues,
    "costAssumptions.feesBps",
    request.costAssumptions?.feesBps,
  );
  requireFiniteNonNegativeNumber(
    issues,
    "costAssumptions.slippageBps",
    request.costAssumptions?.slippageBps,
  );
  requireOptionalNonNegativeNumber(
    issues,
    "costAssumptions.spreadBps",
    request.costAssumptions?.spreadBps,
  );
  requireOptionalNonNegativeNumber(
    issues,
    "costAssumptions.fundingBpsPerDay",
    request.costAssumptions?.fundingBpsPerDay,
  );
  requireOptionalNonNegativeNumber(
    issues,
    "costAssumptions.borrowBpsPerDay",
    request.costAssumptions?.borrowBpsPerDay,
  );
  requireOptionalNonNegativeNumber(
    issues,
    "costAssumptions.latencyMs",
    request.costAssumptions?.latencyMs,
  );
  requireOptionalNonNegativeNumber(
    issues,
    "costAssumptions.marketImpactBps",
    request.costAssumptions?.marketImpactBps,
  );

  const partialFillRate = request.costAssumptions?.partialFillRate;
  if (partialFillRate !== undefined) {
    if (!Number.isFinite(partialFillRate) || partialFillRate < 0 || partialFillRate > 1) {
      issues.push({
        path: "costAssumptions.partialFillRate",
        message: "costAssumptions.partialFillRate must be between 0 and 1.",
      });
    }
  }

  return issues;
}

export function createSimulationLaneManifest(params: {
  request: SimulationLaneRequest;
  createdAt?: string;
}): SimulationLaneManifest {
  const issues = validateSimulationLaneRequest(params.request);
  if (issues.length > 0) {
    throw new Error(formatSimulationLaneIssues(issues));
  }

  const template = getExecutionSandboxTemplate(params.request.templateId);
  return {
    version: 1,
    createdAt: params.createdAt ?? new Date().toISOString(),
    liveExecutionAllowed: false,
    templateFingerprint: template.fingerprint,
    artifacts: {
      manifestFile: SIMULATION_LANE_MANIFEST_FILENAME,
      decisionLogFile: SIMULATION_LANE_LOG_FILENAME,
      workspaceDir: SIMULATION_LANE_WORKSPACE_DIRNAME,
    },
    ...cloneSimulationLaneRequest(params.request),
  };
}

export function createSimulationLaneMetadataEntry(
  manifest: SimulationLaneManifest,
): SimulationLaneLogEntry<"metadata"> {
  return appendSimulationLaneLogEntry({
    entries: [],
    kind: "metadata",
    recordedAt: manifest.createdAt,
    payload: {
      manifestHash: hashValue(manifest),
      laneId: manifest.laneId,
      mode: manifest.mode,
      venue: manifest.venue,
      instrument: manifest.instrument,
      timeframe: manifest.timeframe,
      window: { ...manifest.window },
      costAssumptions: { ...manifest.costAssumptions },
      templateId: manifest.templateId,
      templateFingerprint: manifest.templateFingerprint,
      liveExecutionAllowed: false,
    },
  });
}

export function appendSimulationLaneDecision(
  entries: SimulationLaneLogEntry[],
  payload: SimulationLaneDecisionPayload,
): SimulationLaneLogEntry<"decision"> {
  return appendSimulationLaneLogEntry({
    entries,
    kind: "decision",
    recordedAt: payload.decidedAt,
    payload: cloneDecisionPayload(payload),
  });
}

export function appendSimulationLaneOutcome(
  entries: SimulationLaneLogEntry[],
  payload: SimulationLaneOutcomePayload,
): SimulationLaneLogEntry<"outcome"> {
  return appendSimulationLaneLogEntry({
    entries,
    kind: "outcome",
    recordedAt: payload.recordedAt,
    payload: cloneOutcomePayload(payload),
  });
}

export function verifySimulationLaneLog(
  entries: SimulationLaneLogEntry[],
): SimulationLaneVerificationResult {
  let previousHash: string | null = null;

  for (const [index, entry] of entries.entries()) {
    if (entry.seq !== index + 1) {
      return {
        ok: false,
        index,
        message: `Expected seq ${index + 1} but found ${entry.seq}.`,
      };
    }
    if (entry.prevHash !== previousHash) {
      return {
        ok: false,
        index,
        message: `Entry ${entry.seq} prevHash does not match the prior entry hash.`,
      };
    }

    const expectedHash = computeLogEntryHash({
      seq: entry.seq,
      kind: entry.kind,
      recordedAt: entry.recordedAt,
      prevHash: entry.prevHash,
      payload: entry.payload,
    });
    if (entry.hash !== expectedHash) {
      return {
        ok: false,
        index,
        message: `Entry ${entry.seq} hash does not match its serialized payload.`,
      };
    }

    previousHash = entry.hash;
  }

  return { ok: true };
}

export async function materializeSimulationLane(params: {
  destinationDir: string;
  request: SimulationLaneRequest;
  overwrite?: boolean;
  createdAt?: string;
}): Promise<MaterializedSimulationLane> {
  const manifest = createSimulationLaneManifest({
    request: params.request,
    createdAt: params.createdAt,
  });
  const manifestPath = path.join(params.destinationDir, SIMULATION_LANE_MANIFEST_FILENAME);
  const decisionLogPath = path.join(params.destinationDir, SIMULATION_LANE_LOG_FILENAME);
  const workspaceDir = path.join(params.destinationDir, SIMULATION_LANE_WORKSPACE_DIRNAME);
  const metadataEntry = createSimulationLaneMetadataEntry(manifest);

  await fs.mkdir(params.destinationDir, { recursive: true });
  await materializeExecutionSandboxTemplate({
    destinationDir: workspaceDir,
    id: params.request.templateId,
    overwrite: params.overwrite,
  });
  await writeUtf8File(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    params.overwrite ?? false,
  );
  await writeUtf8File(
    decisionLogPath,
    `${JSON.stringify(metadataEntry)}\n`,
    params.overwrite ?? false,
  );

  return {
    manifest,
    metadataEntry,
    manifestPath,
    decisionLogPath,
    workspaceDir,
  };
}

function appendSimulationLaneLogEntry<TKind extends SimulationLaneLogKind>(params: {
  entries: SimulationLaneLogEntry[];
  kind: TKind;
  recordedAt: string;
  payload: SimulationLaneLogPayloadByKind[TKind];
}): SimulationLaneLogEntry<TKind> {
  const lastEntry = params.entries.at(-1);
  const baseEntry = {
    seq: lastEntry ? lastEntry.seq + 1 : 1,
    kind: params.kind,
    recordedAt: params.recordedAt,
    prevHash: lastEntry?.hash ?? null,
    payload: params.payload,
  };
  return {
    ...baseEntry,
    hash: computeLogEntryHash(baseEntry),
  };
}

function computeLogEntryHash(entry: {
  seq: number;
  kind: SimulationLaneLogKind;
  recordedAt: string;
  prevHash: string | null;
  payload: SimulationLaneLogPayloadByKind[SimulationLaneLogKind];
}) {
  return hashValue(entry);
}

function cloneSimulationLaneRequest(request: SimulationLaneRequest): SimulationLaneRequest {
  return {
    ...request,
    window: { ...request.window },
    costAssumptions: { ...request.costAssumptions },
  };
}

function cloneDecisionPayload(
  payload: SimulationLaneDecisionPayload,
): SimulationLaneDecisionPayload {
  return {
    ...payload,
    inputs: payload.inputs ? { ...payload.inputs } : undefined,
  };
}

function cloneOutcomePayload(payload: SimulationLaneOutcomePayload): SimulationLaneOutcomePayload {
  return {
    ...payload,
    metrics: payload.metrics ? { ...payload.metrics } : undefined,
  };
}

function requireNonEmptyString(
  issues: SimulationLaneValidationIssue[],
  pathName: string,
  value: string | undefined,
) {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ path: pathName, message: `${pathName} must be a non-empty string.` });
  }
}

function requireFiniteNonNegativeNumber(
  issues: SimulationLaneValidationIssue[],
  pathName: string,
  value: number | undefined,
) {
  if (!Number.isFinite(value) || (value ?? -1) < 0) {
    issues.push({
      path: pathName,
      message: `${pathName} must be a finite number greater than or equal to 0.`,
    });
  }
}

function requireOptionalNonNegativeNumber(
  issues: SimulationLaneValidationIssue[],
  pathName: string,
  value: number | undefined,
) {
  if (value === undefined) {
    return;
  }
  requireFiniteNonNegativeNumber(issues, pathName, value);
}

function parseTimestamp(value: string | undefined): number | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hashValue(value: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function formatSimulationLaneIssues(issues: SimulationLaneValidationIssue[]) {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
}

async function writeUtf8File(filePath: string, content: string, overwrite: boolean) {
  await fs.writeFile(filePath, content, {
    encoding: "utf8",
    flag: overwrite ? "w" : "wx",
  });
}
