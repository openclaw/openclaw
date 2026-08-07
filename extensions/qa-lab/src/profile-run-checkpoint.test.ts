import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { validateQaEvidenceSummaryJson, type QaEvidenceSummaryJson } from "./evidence-summary.js";
import { readQaScenarioById } from "./scenario-catalog.js";

const atomicState = vi.hoisted(() => ({
  checkpointFailures: 0,
  finalEvidenceFailures: 0,
  writes: [] as string[],
}));
const cryptoState = vi.hoisted(() => ({ fixedHash: false }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    createHash: (...args: Parameters<typeof actual.createHash>) => {
      if (!cryptoState.fixedHash) {
        return actual.createHash(...args);
      }
      const fixed = {
        update: () => fixed,
        digest: () => "0".repeat(64),
      };
      return fixed as unknown as ReturnType<typeof actual.createHash>;
    },
  };
});

vi.mock("openclaw/plugin-sdk/json-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/json-store")>();
  return {
    ...actual,
    writeJsonFileAtomically: async (filePath: string, value: unknown) => {
      atomicState.writes.push(filePath);
      if (
        filePath.endsWith("qa-profile-run-checkpoint.json") &&
        atomicState.checkpointFailures > 0
      ) {
        atomicState.checkpointFailures -= 1;
        throw new Error("checkpoint disk full");
      }
      if (filePath.endsWith("qa-evidence.json") && atomicState.finalEvidenceFailures > 0) {
        atomicState.finalEvidenceFailures -= 1;
        throw new Error("final evidence disk full");
      }
      await actual.writeJsonFileAtomically(filePath, value);
    },
  };
});

import { createQaProfileRunCheckpoint } from "./profile-run-checkpoint.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scenario = readQaScenarioById("channel-chat-baseline");
const secondScenario = readQaScenarioById("dm-chat-baseline");
const cell = {
  scenarioId: scenario.id,
  executionKind: "flow" as const,
  channel: "qa-channel",
};
const secondCell = {
  scenarioId: secondScenario.id,
  executionKind: "flow" as const,
  channel: "qa-channel",
};

function evidence(
  generatedAt = "2026-08-06T00:00:00.000Z",
  testId = scenario.id,
): QaEvidenceSummaryJson {
  return validateQaEvidenceSummaryJson({
    kind: "openclaw.qa.evidence-summary",
    schemaVersion: 2,
    generatedAt,
    evidenceMode: "full",
    entries: [
      {
        test: { kind: "flow", id: testId, title: testId },
        coverage: [],
        refs: [],
        result: { status: "pass" },
      },
    ],
  });
}

function emptyEvidence(): QaEvidenceSummaryJson {
  return validateQaEvidenceSummaryJson({
    kind: "openclaw.qa.evidence-summary",
    schemaVersion: 2,
    generatedAt: "2026-08-06T00:00:00.000Z",
    evidenceMode: "full",
    entries: [],
  });
}

async function createCheckpoint(
  expectedCells: readonly (typeof cell)[] = [cell],
  selectedScenarios = [scenario],
  outputDir = tempDirs.make("qa-profile-checkpoint-"),
) {
  const checkpoint = await createQaProfileRunCheckpoint({
    expectedCells,
    outputDir,
    retryPhase: async (_phase, run) => await run(),
    spec: {
      profile: "release",
      membershipScenarios: selectedScenarios,
      selectedScenarios,
      excludedScenarios: [],
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
    cells: Array<typeof cell & { evidence?: { path: string; sha256: string } }>;
  };
}

describe("QA profile run checkpoint", () => {
  beforeEach(() => {
    atomicState.checkpointFailures = 0;
    atomicState.finalEvidenceFailures = 0;
    atomicState.writes.length = 0;
    cryptoState.fixedHash = false;
  });

  it("removes prior canonical evidence before checkpoint creation", async () => {
    const outputDir = tempDirs.make("qa-profile-checkpoint-stale-");
    const evidencePath = path.join(outputDir, "qa-evidence.json");
    await fs.writeFile(evidencePath, `${JSON.stringify(evidence(), null, 2)}\n`, "utf8");

    await createCheckpoint([cell], [scenario], outputDir);

    await expect(fs.access(evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.access(path.join(outputDir, "qa-profile-run-checkpoint.json")),
    ).resolves.toBeUndefined();
  });

  it("aborts checkpoint creation when canonical evidence cannot be invalidated", async () => {
    const outputDir = tempDirs.make("qa-profile-checkpoint-invalidation-");
    await fs.mkdir(path.join(outputDir, "qa-evidence.json"));

    await expect(createCheckpoint([cell], [scenario], outputDir)).rejects.toThrow();
    await expect(
      fs.access(path.join(outputDir, "qa-profile-run-checkpoint.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not expose prior canonical evidence when finalization persistence fails", async () => {
    const outputDir = tempDirs.make("qa-profile-checkpoint-finalize-");
    const evidencePath = path.join(outputDir, "qa-evidence.json");
    await fs.writeFile(evidencePath, `${JSON.stringify(evidence(), null, 2)}\n`, "utf8");
    const { checkpoint } = await createCheckpoint([cell], [scenario], outputDir);
    await checkpoint.control([cell]).complete({ scenarioId: scenario.id, evidence: evidence() });
    atomicState.finalEvidenceFailures = 1;

    await expect(checkpoint.finalize()).rejects.toThrow("final evidence disk full");
    await expect(fs.access(evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("becomes terminal only after the checkpoint snapshot commits", async () => {
    const { checkpoint, outputDir } = await createCheckpoint();
    const control = checkpoint.control([cell]);
    atomicState.checkpointFailures = 1;

    await expect(
      control.complete({ scenarioId: scenario.id, evidence: evidence() }),
    ).rejects.toThrow("checkpoint disk full");
    expect(control.hasTerminalEvidence()).toBe(false);
    expect((await readCheckpoint(outputDir)).cells[0]).not.toHaveProperty("evidence");

    await control.complete({ scenarioId: scenario.id, evidence: evidence() });
    expect(control.hasTerminalEvidence()).toBe(true);
    expect((await readCheckpoint(outputDir)).cells[0]?.evidence?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps generic empty summaries valid but rejects empty profile completion", async () => {
    expect(validateQaEvidenceSummaryJson(emptyEvidence()).entries).toEqual([]);
    const { checkpoint, outputDir } = await createCheckpoint();
    const control = checkpoint.control([cell]);

    await expect(
      control.complete({ scenarioId: scenario.id, evidence: emptyEvidence() }),
    ).rejects.toThrow("Invalid QA profile evidence");
    expect(control.hasTerminalEvidence()).toBe(false);
    expect((await readCheckpoint(outputDir)).cells[0]).not.toHaveProperty("evidence");
  });

  it("binds the canonical qa-channel cell and treats identical completion as idempotent", async () => {
    const { checkpoint, outputDir } = await createCheckpoint();
    const control = checkpoint.control([cell]);
    await control.complete({ scenarioId: scenario.id, evidence: evidence() });
    const checkpointWrites = atomicState.writes.filter((filePath) =>
      filePath.endsWith("qa-profile-run-checkpoint.json"),
    ).length;

    await control.complete({ scenarioId: scenario.id, evidence: evidence() });
    expect(
      atomicState.writes.filter((filePath) => filePath.endsWith("qa-profile-run-checkpoint.json")),
    ).toHaveLength(checkpointWrites);

    const ref = (await readCheckpoint(outputDir)).cells[0]?.evidence;
    expect(ref).toBeDefined();
    const stored = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(path.join(outputDir, ref!.path), "utf8")),
    );
    expect(stored.profileCell).toEqual(cell);
  });

  it("rejects replacement evidence after terminal completion", async () => {
    const { checkpoint } = await createCheckpoint();
    const control = checkpoint.control([cell]);
    await control.complete({ scenarioId: scenario.id, evidence: evidence() });

    await expect(
      control.complete({
        scenarioId: scenario.id,
        evidence: evidence("2026-08-06T00:00:01.000Z"),
      }),
    ).rejects.toThrow("rejects replacement evidence");
  });

  it("rejects tampered evidence refs during finalization", async () => {
    const { checkpoint, outputDir } = await createCheckpoint();
    await checkpoint.control([cell]).complete({ scenarioId: scenario.id, evidence: evidence() });
    const ref = (await readCheckpoint(outputDir)).cells[0]?.evidence;
    await fs.writeFile(path.join(outputDir, ref!.path), "{}\n", "utf8");

    await expect(checkpoint.finalize()).rejects.toThrow("evidence digest mismatch");
  });

  it("rejects digest-valid empty refs during finalization", async () => {
    cryptoState.fixedHash = true;
    const { checkpoint, outputDir } = await createCheckpoint();
    await checkpoint.control([cell]).complete({ scenarioId: scenario.id, evidence: evidence() });
    const ref = (await readCheckpoint(outputDir)).cells[0]?.evidence;
    const empty = validateQaEvidenceSummaryJson({ ...emptyEvidence(), profileCell: cell });
    await fs.writeFile(path.join(outputDir, ref!.path), `${JSON.stringify(empty, null, 2)}\n`);

    await expect(checkpoint.finalize()).rejects.toThrow("Invalid QA profile evidence");
  });

  it("finalizes refs in canonical cell order and preserves producer-owned IDs", async () => {
    const { checkpoint, outputDir } = await createCheckpoint(
      [secondCell, cell],
      [secondScenario, scenario],
    );
    await checkpoint.control([secondCell]).complete({
      scenarioId: secondScenario.id,
      evidence: evidence(undefined, "producer-second"),
    });
    await checkpoint
      .control([cell])
      .complete({ scenarioId: scenario.id, evidence: evidence(undefined, "producer-first") });

    const finalized = await checkpoint.finalize();

    expect(finalized.entries.map((entry) => entry.test.id)).toEqual([
      "producer-first",
      "producer-second",
    ]);
    expect(finalized.profileCell).toBeUndefined();
    expect(finalized.profilePlan?.observedCells).toEqual([cell, secondCell]);
    expect(
      validateQaEvidenceSummaryJson(
        JSON.parse(await fs.readFile(path.join(outputDir, "qa-evidence.json"), "utf8")),
      ),
    ).toStrictEqual(finalized);
  });

  it("projects missing cells from the refs-only aggregate", async () => {
    const { checkpoint } = await createCheckpoint([cell, secondCell], [scenario, secondScenario]);
    await checkpoint
      .control([secondCell])
      .complete({ scenarioId: secondScenario.id, evidence: evidence(undefined, "producer-owned") });

    const finalized = await checkpoint.finalize();

    expect(finalized.entries.map((entry) => entry.test.id)).toEqual(["producer-owned"]);
    expect(finalized.profilePlan?.observedCells).toEqual([secondCell]);
    expect(finalized.profilePlan?.missingCells).toEqual([cell]);
  });

  it("finalizes strict observed cells from refs", async () => {
    const { checkpoint, outputDir } = await createCheckpoint();
    await checkpoint.control([cell]).complete({ scenarioId: scenario.id, evidence: evidence() });

    const finalized = await checkpoint.finalize();

    expect(finalized.entries).toStrictEqual(evidence().entries);
    expect(finalized.profilePlan?.observedCells).toEqual([cell]);
    expect(Object.keys(finalized.profilePlan!.observedCells[0]!).toSorted()).toEqual([
      "channel",
      "executionKind",
      "scenarioId",
    ]);
    expect(
      validateQaEvidenceSummaryJson(
        JSON.parse(await fs.readFile(path.join(outputDir, "qa-evidence.json"), "utf8")),
      ),
    ).toStrictEqual(finalized);
  });
});
