import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindQaEvidenceSummaryToProfileCell,
  validateQaEvidenceSummaryJson,
  type QaEvidenceStatus,
  type QaEvidenceSummaryJson,
} from "./evidence-summary.js";
import { createQaProfileRunCheckpoint } from "./profile-run-checkpoint.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import type { QaScenarioExecutionCell } from "./scenario-lane.js";

const tempRoots: string[] = [];
const firstScenario = readQaScenarioById("thread-isolation");
const secondScenario = readQaScenarioById("control-ui-chat-flow-playwright");
const expectedCells: QaScenarioExecutionCell[] = [
  { scenarioId: firstScenario.id, executionKind: "flow", channel: null },
  { scenarioId: secondScenario.id, executionKind: "playwright", channel: null },
];

function evidence(testId: string, status: QaEvidenceStatus = "pass"): QaEvidenceSummaryJson {
  return validateQaEvidenceSummaryJson({
    kind: "openclaw.qa.evidence-summary",
    schemaVersion: 2,
    generatedAt: "2026-08-06T00:00:00.000Z",
    evidenceMode: "full",
    profile: "release",
    entries: [
      {
        test: { kind: "flow", id: testId, title: testId },
        coverage: [],
        refs: [],
        result: { status },
      },
    ],
  });
}

function cellEvidence(
  cell: QaScenarioExecutionCell,
  status: QaEvidenceStatus = "pass",
  testId = cell.scenarioId,
) {
  return bindQaEvidenceSummaryToProfileCell({
    summary: evidence(testId, status),
    cell,
  });
}

async function createCheckpoint() {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-profile-checkpoint-"));
  tempRoots.push(outputDir);
  const checkpoint = await createQaProfileRunCheckpoint({
    outputDir,
    expectedCells,
    spec: {
      profile: "release",
      membershipScenarios: [firstScenario, secondScenario],
      selectedScenarios: [firstScenario, secondScenario],
      excludedScenarios: [],
      evidenceMode: "full",
      filters: {},
      categories: [],
    },
  });
  return { checkpoint, outputDir };
}

async function readCheckpoint(outputDir: string) {
  return JSON.parse(
    await fs.readFile(path.join(outputDir, "qa-profile-run-checkpoint.json"), "utf8"),
  ) as {
    cells: Array<{
      scenarioId: string;
      state: string;
      attempt: number;
      startedAt?: string;
      evidence?: { path: string; sha256: string };
    }>;
    run: { finalized: boolean; revision: number; status: string };
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("QA profile run checkpoint", () => {
  it("records each running restart as a new attempt", async () => {
    const { checkpoint, outputDir } = await createCheckpoint();
    await checkpoint.reporter.start(firstScenario.id);
    const firstStart = (await readCheckpoint(outputDir)).cells[1]?.startedAt;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2);
    });
    await checkpoint.reporter.start(firstScenario.id);

    const restarted = (await readCheckpoint(outputDir)).cells[1];
    expect(restarted).toMatchObject({
      state: "running",
      attempt: 2,
    });
    expect(restarted?.startedAt).not.toBe(firstStart);
  });

  it("serializes atomic starts and forbids terminal regression", async () => {
    const { checkpoint, outputDir } = await createCheckpoint();
    await Promise.all([
      checkpoint.reporter.start(firstScenario.id),
      checkpoint.reporter.start(secondScenario.id),
    ]);
    await checkpoint.reporter.complete({
      scenarioId: firstScenario.id,
      evidence: cellEvidence(expectedCells[0]!),
      result: "pass",
    });

    const written = await readCheckpoint(outputDir);
    expect(written.cells).toMatchObject([
      { scenarioId: secondScenario.id, state: "running", attempt: 1 },
      { scenarioId: firstScenario.id, state: "completed", attempt: 1 },
    ]);
    expect(written.run.revision).toBe(4);
    expect((await fs.readdir(outputDir)).some((entry) => entry.endsWith(".tmp"))).toBe(false);
    await expect(
      checkpoint.reporter.complete({
        scenarioId: firstScenario.id,
        evidence: cellEvidence(expectedCells[0]!),
        result: "fail",
      }),
    ).rejects.toThrow("terminal regression");
    expect((await readCheckpoint(outputDir)).cells[1]?.state).toBe("completed");
  });

  it("accepts producer-owned evidence and rejects empty or tampered durable refs", async () => {
    const { checkpoint, outputDir } = await createCheckpoint();
    await checkpoint.reporter.start(firstScenario.id);
    const emptyEvidence = validateQaEvidenceSummaryJson({
      ...cellEvidence(expectedCells[0]!),
      entries: [],
    });
    await expect(
      checkpoint.reporter.complete({
        scenarioId: firstScenario.id,
        evidence: emptyEvidence,
        result: "pass",
      }),
    ).rejects.toThrow(`contains no entries for ${firstScenario.id}`);
    expect((await readCheckpoint(outputDir)).cells[1]?.state).toBe("running");

    await expect(
      checkpoint.reporter.complete({
        scenarioId: firstScenario.id,
        evidence: cellEvidence(expectedCells[1]!, "pass", "producer-owned-check"),
        result: "pass",
      }),
    ).rejects.toThrow("is not bound to");
    expect((await readCheckpoint(outputDir)).cells[1]?.state).toBe("running");

    await checkpoint.reporter.complete({
      scenarioId: firstScenario.id,
      evidence: cellEvidence(expectedCells[0]!, "pass", "producer-owned-check"),
      result: "pass",
    });
    const ref = (await readCheckpoint(outputDir)).cells[1]?.evidence;
    expect(ref).toBeDefined();
    await fs.writeFile(path.join(outputDir, ref!.path), "{}\n", "utf8");
    await expect(checkpoint.finalize(evidence(firstScenario.id))).rejects.toThrow(
      "digest mismatch",
    );
  });

  it("preserves authoritative parent evidence without inventing observed cells", async () => {
    const { checkpoint, outputDir } = await createCheckpoint();
    await checkpoint.reporter.start(firstScenario.id);
    await checkpoint.reporter.complete({
      scenarioId: firstScenario.id,
      evidence: cellEvidence(expectedCells[0]!),
      result: "pass",
    });
    const authoritativeEvidence = validateQaEvidenceSummaryJson({
      ...evidence(firstScenario.id),
      entries: [
        ...evidence(firstScenario.id).entries,
        ...evidence(secondScenario.id, "fail").entries,
      ],
    });
    const aggregate = await checkpoint.finalize(authoritativeEvidence);
    const writtenAggregate = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(path.join(outputDir, "qa-evidence.json"), "utf8")),
    );

    expect(writtenAggregate).toEqual(aggregate);
    expect(aggregate.entries.map((entry) => entry.test.id)).toEqual([
      firstScenario.id,
      secondScenario.id,
    ]);
    expect(aggregate.scorecard?.run.evidenceEntryCount).toBe(2);
    expect(aggregate.profilePlan?.observedCells).toEqual([expectedCells[0]]);
    expect(aggregate.profilePlan?.missingCells).toEqual([expectedCells[1]]);
    expect(await readCheckpoint(outputDir)).toMatchObject({
      cells: [
        { scenarioId: secondScenario.id, state: "pending", attempt: 0 },
        { scenarioId: firstScenario.id, state: "completed", attempt: 1 },
      ],
      run: { finalized: true, status: "completed" },
    });
  });
});
