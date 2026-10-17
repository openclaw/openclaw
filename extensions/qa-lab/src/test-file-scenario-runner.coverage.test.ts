import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import {
  getEffectiveQaEvidenceEntries,
  validateQaEvidenceSummaryJson,
  type QaEvidenceSummaryV3Json,
} from "./evidence-summary.js";
import { qaProfileEvidencePlan } from "./profile-evidence-plan.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { attachQaProfileScorecardEvidenceToFile } from "./scorecard-evidence.js";
import { resolveQaScriptRuntimeExecutable } from "./test-file-scenario-runner-commands.js";
import { runQaTestFileScenarios } from "./test-file-scenario-runner.js";
import {
  buildScriptProducerEvidence,
  createScenarioRunnerTestHarness,
  makeTestFileScenario,
  resolveScriptAttemptOutputDir,
  writeScriptProducerEvidence,
  QA_TEST_RUNNER_DEFAULTS,
} from "./test-file-scenario-runner.test-support.js";

const harness = createScenarioRunnerTestHarness();
const profilePlan = qaProfileEvidencePlan.build({
  profile: "all",
  taxonomyIdentity: { version: 1, sha256: "a".repeat(64) },
  membershipScenarios: [],
  selectedScenarios: [],
  excludedScenarios: [],
  expectedCells: [],
  observedCells: [],
});

afterEach(() => harness.cleanup());

function attachScorecard(evidencePath: string, coverageIds: string[]) {
  return attachQaProfileScorecardEvidenceToFile({
    evidencePath,
    profilePlan,
    evidenceMode: "full",
    profile: "all",
    filters: {},
    categories: [
      {
        id: "fixture.coverage",
        taxonomySurfaceId: "fixture",
        taxonomyCategoryName: "Coverage",
        inventoryStatus: "complete",
        profiles: ["all"],
        features: coverageIds.map((id) => ({ name: id, coverageIds: [id] })),
        coverageIds,
        inventoriedCoverageIds: coverageIds,
        inventoryRefs: [],
        scenarioRefs: [],
        missingCoverageIds: [],
        missingInventoryRefs: [],
      },
    ],
  });
}

describe("producer coverage claims", () => {
  it("retains bound child assertions when the parent caps primary coverage", async () => {
    const repoRoot = await harness.makeTempRepo("qa-child-coverage-cap-");
    const coverage: QaEvidenceSummaryV3Json["entries"][number]["coverage"] = [
      { id: "qa.coverage", role: "primary" },
      { id: "qa.reporting", role: "primary" },
      { id: "other.claim", role: "primary" },
    ];
    const launch = {
      source: { ref: "fixture-child", integrity: null },
      runtime: { id: null, version: null },
      package: null,
      protocol: null,
      accountRef: null,
      proofClass: null,
    };
    const observation = Buffer.from("captured fixture assertion");
    await fs.writeFile(path.join(repoRoot, "child-observation.json"), observation);
    const child = createQaEvidenceInvocation({
      scenarios: [
        {
          id: "child-check",
          execution: { kind: "script" },
          assertions: [{ id: "check", meaning: "captured child result", coverage }],
        },
      ],
      channel: null,
      launch,
    });
    const childId = child.begin(0);
    child.complete(childId, {
      status: "pass",
      entries: buildScriptProducerEvidence({ status: "pass", coverage }).entries.map((entry) =>
        Object.assign({}, entry, {
          binding: { occurrenceId: childId, assertionId: "check", receiptId: "child-receipt" },
          effective: true,
        }),
      ),
      receipts: [
        {
          id: "child-receipt",
          phase: "prepared",
          identity: launch,
          artifact: {
            kind: "fixture",
            source: "script",
            path: "<repo-root>/child-observation.json",
            sha256: createHash("sha256").update(observation).digest("hex"),
          },
        },
      ],
    });
    child.select(0, childId);
    const original = child.snapshot({ generatedAt: "2026-09-14T00:00:00Z", evidenceMode: "full" });
    const bytes = Buffer.from(JSON.stringify(original));
    let evidencePath = "";
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, "out"),
      ...QA_TEST_RUNNER_DEFAULTS,
      evidenceMode: "full",
      scenarios: [makeTestFileScenario("script", "producer.mjs")],
      runCommand: async (command) => {
        const base = command.args[command.args.indexOf("--artifact-base") + 1]!;
        evidencePath = path.join(base, "qa-evidence.json");
        await fs.writeFile(evidencePath, bytes, { flag: "wx" });
        return { exitCode: 0, stdout: "child completed", stderr: "" };
      },
    });
    expect(result.results[0]?.status).toBe("pass");
    if (result.evidence.schemaVersion !== 3) {
      throw new Error("expected occurrence evidence");
    }
    const summary: QaEvidenceSummaryV3Json = result.evidence;
    expect(summary.entries[0]).toEqual(original.entries[0]);
    expect(summary.occurrences).toEqual(expect.arrayContaining(original.occurrences));
    expect(await fs.readFile(evidencePath)).toEqual(bytes);
    expect(
      summary.occurrences
        .flatMap((item) => item.receipts)
        .find((receipt) => receipt.artifact.kind === "producer-evidence")?.artifact.sha256,
    ).toBe(createHash("sha256").update(bytes).digest("hex"));
    const coverageIds = coverage.map(({ id }) => id);
    const scorecard = await attachScorecard(result.evidencePath, coverageIds);
    expect(scorecard.coverageIds).toMatchObject({ total: 3, fulfilled: 1, missing: 2 });
    expect(scorecard.categoryReports[0]?.coverageIds.secondaryOnly).toBe(1);
    expect(getEffectiveQaEvidenceEntries(summary)[0]).toBe(summary.entries[0]);
    expect(
      validateQaEvidenceSummaryJson(JSON.parse(await fs.readFile(result.evidencePath, "utf8")))
        .entries,
    ).toEqual(summary.entries);
  });

  it("caps producer coverage without promoting or inventing claims in slim mode", async () => {
    const repoRoot = await harness.makeTempRepo("qa-script-coverage-claims-");
    const claims = [
      [],
      [{ id: "qa.coverage", role: "primary" }],
      [{ id: "qa.coverage", role: "secondary" }],
      [{ id: "qa.reporting", role: "primary" }],
      [{ id: "qa.reporting", role: "secondary" }],
      [{ id: "ui.control", role: "primary" }],
      [{ id: "qa.coverage", role: "diagnostic" }],
      [{ id: "qa.reporting", role: "diagnostic" }],
    ];
    const producerEntries = claims.flatMap(
      (coverage, index) =>
        buildScriptProducerEvidence({
          coverage,
          producerId: `claim-${index}`,
          status: "pass",
          artifacts: [{ kind: "log", path: "producer.log" }],
        }).entries,
    );
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, "out"),
      ...QA_TEST_RUNNER_DEFAULTS,
      evidenceMode: "slim",
      scenarios: [makeTestFileScenario("script", "scripts/evidence-producer.ts")],
      runCommand: async (command) => {
        await writeScriptProducerEvidence({
          outputDir: resolveScriptAttemptOutputDir(command),
          coverage: [],
          producerId: "failed-diagnostic",
          failureReason: "boundary failed without a coverage claim",
          status: "fail",
          additionalEntries: producerEntries,
        });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(result.results[0]?.status).toBe("fail");
    expect(result.evidence.entries.map((entry) => entry.coverage)).toEqual([
      [],
      [],
      [{ id: "qa.coverage", role: "primary" }],
      [{ id: "qa.coverage", role: "secondary" }],
      [{ id: "qa.reporting", role: "secondary" }],
      [{ id: "qa.reporting", role: "secondary" }],
      [],
      [{ id: "qa.coverage", role: "diagnostic" }],
      [{ id: "qa.reporting", role: "diagnostic" }],
    ]);
    expect(result.evidence.entries[0]?.result).toMatchObject({
      status: "fail",
      failure: { reason: "boundary failed without a coverage claim" },
    });
    for (const [index, original] of producerEntries.entries()) {
      const imported = result.evidence.entries[index + 1];
      expect(imported).toMatchObject({
        test: original.test,
        result: original.result,
        execution: undefined,
      });
    }
  });
});

describe.skipIf(process.platform === "win32")("onboarding assertion attribution", () => {
  it("fulfills only the passing boundary through producer, importer and persisted scorecard", async () => {
    const tempRoot = await harness.makeTempDir("qa-onboarding-attribution-");
    const binDir = path.join(tempRoot, "bin");
    await fs.mkdir(binDir);
    // Report one completed boundary through the real producer without Docker.
    await fs.writeFile(
      path.join(binDir, "bash"),
      [
        "#!/bin/sh",
        '[ "$1" = "scripts/e2e/onboard-docker.sh" ] || exit 91',
        '[ "$OPENCLAW_ONBOARD_E2E_CASES" = "guided-skip-ui,local-auth-refs,local-password,remote-non-interactive,reset,skills" ] || exit 92',
        "echo 'QA_ASSERT cli.guided-onboarding pass'",
        "exit 7",
      ].join("\n"),
      { mode: 0o755 },
    );
    const scenario = readQaScenarioById("cli-onboarding");
    const coverageIds = [
      "cli.gateway-auth-storage",
      "cli.guided-onboarding",
      "cli.remote-onboarding",
      "cli.targeted-reconfiguration",
    ];
    const result = await runQaTestFileScenarios({
      repoRoot: process.cwd(),
      outputDir: path.join(tempRoot, "evidence"),
      ...QA_TEST_RUNNER_DEFAULTS,
      evidenceMode: "full",
      scenarios: [scenario],
      env: { PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
    });
    expect(result.results[0]).toMatchObject({
      status: "fail",
      failureMessage: `${path.basename(resolveQaScriptRuntimeExecutable())} exited with 7`,
      includeFallbackEvidence: true,
    });
    expect(result.evidence.entries.map((entry) => [entry.test.id, entry.result.status])).toEqual([
      ["cli-gateway-auth-storage", "fail"],
      ["cli-guided-onboarding", "pass"],
      ["cli-remote-onboarding", "fail"],
      ["cli-targeted-reconfiguration", "fail"],
      ["cli-onboarding", "fail"],
    ]);
    const scorecard = await attachScorecard(result.evidencePath, coverageIds);
    expect(scorecard.coverageIds).toEqual({
      total: 4,
      fulfilled: 1,
      missing: 3,
      fulfillmentPercent: 25,
    });
    const producer = result.results[0]?.producerEvidence;
    expect(producer?.entries.map((entry) => entry.coverage)).toEqual(
      coverageIds.map((id) => [{ id, role: "primary" }]),
    );
    for (const [index, original] of (producer?.entries ?? []).entries()) {
      const imported = result.evidence.entries[index];
      expect(imported).toMatchObject(original);
    }
    for (const index of [0, 2, 3]) {
      expect(result.evidence.entries[index]?.result.failure?.reason).toContain(
        "missing executable assertion marker(s):",
      );
    }
    const written = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    expect(written.entries).toEqual(result.evidence.entries);
    expect(written).toMatchObject({ evidenceMode: "full", profilePlan });
  }, 60_000);
});
