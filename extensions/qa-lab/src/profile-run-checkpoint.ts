// QA Lab owns durable profile-run lifecycle and normal-run aggregation.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  QA_EVIDENCE_FILENAME,
  attachQaEvidenceScorecard,
  validateQaEvidenceSummaryJson,
  type QaEvidenceStatus,
  type QaEvidenceSummaryJson,
} from "./evidence-summary.js";
import { qaProfileEvidencePlan } from "./profile-evidence-plan.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import type { QaScenarioExecutionCell } from "./scenario-lane.js";
import { buildQaProfileScorecardEvidence } from "./scorecard-evidence.js";
import type {
  QaScorecardCategoryCoverageReport,
  QaScorecardEvidenceMode,
} from "./scorecard-taxonomy.js";

type CellState = "pending" | "running" | "completed" | "failed" | "blocked" | "timed-out";
type CheckpointCell = QaScenarioExecutionCell & {
  partition: string;
  attempt: number;
  state: CellState;
  pendingAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: QaEvidenceStatus;
  evidence?: { path: string; sha256: string };
  reason?: string;
};
export type QaProfileRunSpec = {
  profile: string;
  membershipScenarios: readonly QaSeedScenarioWithSource[];
  selectedScenarios: readonly QaSeedScenarioWithSource[];
  excludedScenarios: readonly {
    scenario: QaSeedScenarioWithSource;
    reasons: readonly string[];
  }[];
  evidenceMode?: QaScorecardEvidenceMode;
  filters: { surface?: string; category?: string };
  categories: readonly QaScorecardCategoryCoverageReport[];
};
type Checkpoint = {
  kind: "openclaw.qa.profile-run-checkpoint";
  schemaVersion: 1;
  profile: {
    id: string;
    membership: string[];
    selected: string[];
    excluded: Array<{ scenarioId: string; reasons: string[] }>;
    evidenceMode: QaScorecardEvidenceMode;
  };
  plan: {
    expectedCells: QaScenarioExecutionCell[];
    partitions: string[];
    phases: ["execution", "aggregate"];
    sha256: string;
  };
  cells: CheckpointCell[];
  run: {
    status: "running" | "completed";
    phase: "execution" | "aggregate" | "completed";
    termination: null | "normal";
    revision: number;
    finalized: boolean;
    createdAt: string;
    updatedAt: string;
  };
};
function digest(value: string | object) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}
function cellPartition(cell: QaScenarioExecutionCell) {
  return `${cell.executionKind}:${cell.channel ?? "default"}`;
}
function cellKey(cell: QaScenarioExecutionCell) {
  return `${cell.scenarioId}\0${cell.executionKind}\0${cell.channel ?? ""}`;
}
async function atomicJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}
function terminalState(result: QaEvidenceStatus): CellState {
  if (result === "pass") {
    return "completed";
  }
  if (result === "fail") {
    return "failed";
  }
  return "blocked";
}
export async function createQaProfileRunCheckpoint(params: {
  outputDir: string;
  expectedCells: readonly QaScenarioExecutionCell[];
  spec: QaProfileRunSpec;
}) {
  const createdAt = new Date().toISOString();
  const initialPlan = qaProfileEvidencePlan.build({
    profile: params.spec.profile,
    membershipScenarios: params.spec.membershipScenarios,
    selectedScenarios: params.spec.selectedScenarios,
    excludedScenarios: params.spec.excludedScenarios,
    expectedCells: params.expectedCells,
    observedCells: [],
  });
  const expectedCells = initialPlan.expectedCells;
  const checkpointPath = path.join(params.outputDir, "qa-profile-run-checkpoint.json");
  const checkpoint: Checkpoint = {
    kind: "openclaw.qa.profile-run-checkpoint",
    schemaVersion: 1,
    profile: {
      id: params.spec.profile,
      membership: initialPlan.membership,
      selected: initialPlan.selected,
      excluded: initialPlan.excluded,
      evidenceMode: params.spec.evidenceMode ?? "full",
    },
    plan: {
      expectedCells,
      partitions: [...new Set(expectedCells.map(cellPartition))].toSorted(),
      phases: ["execution", "aggregate"],
      sha256: qaProfileEvidencePlan.attest(initialPlan).sha256,
    },
    cells: expectedCells.map((cell) => ({
      ...cell,
      partition: cellPartition(cell),
      attempt: 0,
      state: "pending",
      pendingAt: createdAt,
    })),
    run: {
      status: "running",
      phase: "execution",
      termination: null,
      revision: 0,
      finalized: false,
      createdAt,
      updatedAt: createdAt,
    },
  };
  let queue = Promise.resolve();
  const mutate = <T>(run: () => Promise<T>) => {
    const next = queue.then(run, run);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const writeCheckpoint = async () => {
    checkpoint.run.revision += 1;
    checkpoint.run.updatedAt = new Date().toISOString();
    await atomicJson(checkpointPath, checkpoint);
  };
  const matchingCell = (scenarioId: string, channel?: string) => {
    // Catalog scenario IDs each own one execution kind, so scenario + channel
    // identifies one expected cell without widening the runner callback API.
    const candidates = checkpoint.cells.filter(
      (cell) =>
        cell.scenarioId === scenarioId && (channel === undefined || cell.channel === channel),
    );
    if (candidates.length !== 1) {
      throw new Error(
        `QA profile checkpoint expected one cell for ${scenarioId}, found ${candidates.length}`,
      );
    }
    return candidates[0]!;
  };
  const validateRef = async (ref: { path: string; sha256: string }) => {
    const absolutePath = path.resolve(params.outputDir, ref.path);
    if (!absolutePath.startsWith(`${path.resolve(params.outputDir)}${path.sep}`)) {
      throw new Error(`QA profile evidence ref escapes output directory: ${ref.path}`);
    }
    const payload = await fs.readFile(absolutePath, "utf8");
    if (digest(payload) !== ref.sha256) {
      throw new Error(`QA profile evidence digest mismatch: ${ref.path}`);
    }
    return validateQaEvidenceSummaryJson(JSON.parse(payload));
  };
  await writeCheckpoint();
  const reporter = {
    start: (scenarioId: string, channel?: string) =>
      mutate(async () => {
        const cell = matchingCell(scenarioId, channel);
        if (cell.state !== "pending" && cell.state !== "running") {
          throw new Error(`QA profile checkpoint cannot restart terminal cell ${cellKey(cell)}`);
        }
        cell.state = "running";
        cell.attempt += 1;
        cell.startedAt = new Date().toISOString();
        await writeCheckpoint();
      }),
    complete: (input: {
      scenarioId: string;
      channel?: string;
      evidence: QaEvidenceSummaryJson;
      result: QaEvidenceStatus;
      reason?: string;
    }) =>
      mutate(async () => {
        const cell = matchingCell(input.scenarioId, input.channel);
        const evidence = validateQaEvidenceSummaryJson(input.evidence);
        if (evidence.entries.length === 0) {
          throw new Error(`QA profile evidence contains no entries for ${input.scenarioId}`);
        }
        // Producer-owned test IDs may differ from the catalog scenario. The full
        // execution-cell binding prevents unrelated evidence from completing it.
        if (!evidence.profileCell || cellKey(evidence.profileCell) !== cellKey(cell)) {
          throw new Error(`QA profile evidence is not bound to ${cellKey(cell)}`);
        }
        const payload = `${JSON.stringify(evidence, null, 2)}\n`;
        const sha256 = digest(payload);
        const relativePath = path.join("qa-profile-evidence", `${sha256}.json`);
        const ref = { path: relativePath, sha256 };
        await atomicJson(path.join(params.outputDir, relativePath), evidence);
        await validateRef(ref);
        const nextState = terminalState(input.result);
        if (cell.state !== "pending" && cell.state !== "running") {
          if (cell.state !== nextState || cell.evidence?.sha256 !== sha256) {
            throw new Error(`QA profile checkpoint terminal regression for ${cellKey(cell)}`);
          }
          return;
        }
        if (cell.state !== "running") {
          throw new Error(`QA profile checkpoint must start ${cellKey(cell)} before completion`);
        }
        Object.assign(cell, {
          state: nextState,
          result: input.result,
          reason: input.reason,
          evidence: ref,
          finishedAt: new Date().toISOString(),
        });
        await writeCheckpoint();
      }),
  };
  return {
    reporter,
    checkpointPath,
    finalize: (authoritativeEvidence: QaEvidenceSummaryJson) =>
      mutate(async () => {
        const baseEvidence = validateQaEvidenceSummaryJson(authoritativeEvidence);
        for (const cell of checkpoint.cells) {
          if (cell.evidence) {
            await validateRef(cell.evidence);
          }
        }
        const observedCells = checkpoint.cells
          .filter((cell) => cell.evidence)
          .map(({ scenarioId, executionKind, channel }) => ({
            scenarioId,
            executionKind,
            channel,
          }));
        const profilePlan = qaProfileEvidencePlan.build({
          profile: params.spec.profile,
          membershipScenarios: params.spec.membershipScenarios,
          selectedScenarios: params.spec.selectedScenarios,
          excludedScenarios: params.spec.excludedScenarios,
          expectedCells,
          observedCells,
        });
        const aggregate = attachQaEvidenceScorecard({
          summary: baseEvidence,
          evidenceMode: params.spec.evidenceMode,
          profile: params.spec.profile,
          profilePlan,
          scorecard: buildQaProfileScorecardEvidence({
            evidence: baseEvidence,
            filters: params.spec.filters,
            categories: params.spec.categories,
          }),
        });
        checkpoint.run.phase = "aggregate";
        await writeCheckpoint();
        await atomicJson(path.join(params.outputDir, QA_EVIDENCE_FILENAME), aggregate);
        checkpoint.run = {
          ...checkpoint.run,
          status: "completed",
          phase: "completed",
          termination: "normal",
          finalized: true,
        };
        await writeCheckpoint();
        return aggregate;
      }),
  };
}

export type QaProfileRunCheckpointReporter = Awaited<
  ReturnType<typeof createQaProfileRunCheckpoint>
>["reporter"];
