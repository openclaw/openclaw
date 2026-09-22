import { spawnSync } from "node:child_process";
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
import { qaMaturityTaxonomyIdentity, readQaMaturityTaxonomySource } from "./scorecard-taxonomy.js";
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

afterEach(async () => {
  await harness.cleanup();
});

describe("producer coverage claims", () => {
  it.each(["full", "slim"] as const)(
    "retains bound child assertions when the parent caps primary coverage in %s mode",
    async (evidenceMode) => {
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
      const original = child.snapshot({ generatedAt: "2026-09-14T00:00:00Z", evidenceMode });
      const bytes = Buffer.from(JSON.stringify(original));
      let evidencePath = "";
      const result = await runQaTestFileScenarios({
        repoRoot,
        outputDir: path.join(repoRoot, "out"),
        ...QA_TEST_RUNNER_DEFAULTS,
        evidenceMode,
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
      for (const occurrence of original.occurrences) {
        expect(summary.occurrences.find((item) => item.id === occurrence.id)).toEqual(occurrence);
      }
      expect(await fs.readFile(evidencePath)).toEqual(bytes);
      expect(
        summary.occurrences
          .flatMap((item) => item.receipts)
          .find((receipt) => receipt.artifact.kind === "producer-evidence")?.artifact.sha256,
      ).toBe(createHash("sha256").update(bytes).digest("hex"));
      const scenario = makeTestFileScenario("script", "producer.mjs");
      const cell = { scenarioId: scenario.id, executionKind: "script" as const, channel: null };
      const profilePlan = qaProfileEvidencePlan.build({
        profile: "all",
        taxonomyIdentity: { version: 1, sha256: "a".repeat(64) },
        membershipScenarios: [scenario],
        selectedScenarios: [scenario],
        excludedScenarios: [],
        expectedCells: [cell],
        observedCells: [cell],
        proofRequirements: coverage.map(({ id }) => ({
          id,
          coverageId: id,
          obligation: "required",
          owner: "fixture-owner",
          acceptedRef: "qa/fixtures/coverage",
          retryAcceptance: "selected-attempt",
          alternatives: [{ sourceRef: "fixture-child" }],
        })),
      });
      for (const retryAcceptance of ["selected-attempt", "all-recorded-attempts"] as const) {
        const proof = qaProfileEvidencePlan.evaluateProof(
          {
            ...profilePlan,
            proofRequirements: profilePlan.proofRequirements!.map((item) =>
              Object.assign({}, item, { retryAcceptance }),
            ),
          },
          summary,
        );
        expect(proof.map((item) => [item.coverageId, item.qualified])).toEqual([
          ["qa.coverage", true],
          ["qa.reporting", false],
          ["other.claim", false],
        ]);
      }
      const coverageIds = coverage.map(({ id }) => id);
      const scorecard = await attachQaProfileScorecardEvidenceToFile({
        evidencePath: result.evidencePath,
        evidenceMode,
        profile: "all",
        profilePlan,
        filters: {},
        categories: [
          {
            id: "qa.coverage",
            taxonomySurfaceId: "qa",
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
      expect(scorecard.coverageIds).toMatchObject({
        total: 3,
        fulfilled: 1,
        missing: 2,
      });
      expect(scorecard.categoryReports[0]?.coverageIds.secondaryOnly).toBe(1);
      expect(getEffectiveQaEvidenceEntries(summary)[0]).toBe(summary.entries[0]);
      expect(
        validateQaEvidenceSummaryJson(JSON.parse(await fs.readFile(result.evidencePath, "utf8")))
          .entries,
      ).toEqual(summary.entries);
    },
  );

  it.each(["full", "slim"] as const)(
    "caps producer coverage without promoting or inventing claims in %s mode",
    async (evidenceMode) => {
      const repoRoot = await harness.makeTempRepo("qa-script-coverage-claims-");
      const outputDir = path.join(repoRoot, "out");
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
        outputDir,
        ...QA_TEST_RUNNER_DEFAULTS,
        evidenceMode,
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
        expect(imported?.test).toEqual(original.test);
        expect(imported?.result).toEqual(original.result);
        if (evidenceMode === "slim") {
          expect(imported?.execution).toBeUndefined();
        } else {
          expect(imported?.execution).toEqual({
            ...original.execution,
            artifacts: [
              {
                ...original.execution?.artifacts[0],
                path: `<repo-root>/${path
                  .relative(
                    repoRoot,
                    path.join(
                      path.dirname(result.results[0]!.logPath),
                      "scenario-script/run-1/producer.log",
                    ),
                  )
                  .split(path.sep)
                  .join("/")}`,
              },
            ],
          });
        }
      }
    },
  );
});

describe.skipIf(process.platform === "win32")("onboarding assertion attribution", () => {
  it.each(["full", "slim"] as const)(
    "fulfills only the passing boundary through producer, importer, scorecard and renderer in %s mode",
    async (evidenceMode) => {
      const repoRoot = process.cwd();
      const tempRoot = await harness.makeTempDir("qa-onboarding-attribution-");
      const outputDir = path.join(tempRoot, "evidence");
      const binDir = path.join(tempRoot, "bin");
      await fs.mkdir(binDir);
      // Exercise the real producer and marker parser without invoking Docker.
      // The child reports exactly one completed boundary before failing.
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
      const features = coverageIds.map((id) => ({ name: id, coverageIds: [id] }));
      const docsRoot = path.join(tempRoot, "docs");
      await fs.mkdir(docsRoot);
      const taxonomyPath = path.join(tempRoot, "taxonomy.json");
      const scoresPath = path.join(tempRoot, "scores.json");
      const surface = { id: "cli", name: "CLI", family: "core", level: "experimental" };
      const scores = {
        quality: { score: 0, label: "Experimental" },
        completeness: { score: 0, label: "Experimental" },
      };
      await fs.writeFile(
        taxonomyPath,
        JSON.stringify({
          version: 1,
          title: "Onboarding attribution fixture",
          levels: [{ id: "experimental", code: "M1", label: "Experimental" }],
          surfaces: [
            {
              ...surface,
              categories: [
                {
                  id: "onboarding-and-auth-setup",
                  name: "Onboarding",
                  features,
                  category_note: "Four independently asserted onboarding boundaries",
                  docs: [],
                },
              ],
            },
          ],
        }),
      );
      await fs.writeFile(
        scoresPath,
        JSON.stringify({
          version: 1,
          process_version: 1,
          counts: { active_surfaces: 1, category_scores: 1 },
          rollups: { surface_average: scores, category_average: scores },
          surfaces: [
            {
              ...surface,
              scores,
              categories: [
                {
                  name: "Onboarding",
                  ...scores,
                  lts: { supported: false, human_override: false },
                },
              ],
              lts: { supported_categories: 0, total_categories: 1, status: "none" },
            },
          ],
        }),
      );
      const profilePlan = {
        profile: "all" as const,
        taxonomyIdentity: qaMaturityTaxonomyIdentity(readQaMaturityTaxonomySource(taxonomyPath)),
        membership: [],
        selected: [],
        excluded: [],
        expectedCells: [],
        observedCells: [],
        missingCells: [],
        counts: {
          membership: 0,
          selected: 0,
          excluded: 0,
          expectedCells: 0,
          observedCells: 0,
          missingCells: 0,
        },
      };
      const result = await runQaTestFileScenarios({
        repoRoot,
        outputDir,
        ...QA_TEST_RUNNER_DEFAULTS,
        evidenceMode,
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
      const scorecard = await attachQaProfileScorecardEvidenceToFile({
        evidencePath: result.evidencePath,
        evidenceMode,
        profile: "all",
        profilePlan,
        filters: {},
        categories: [
          {
            id: "cli.onboarding-and-auth-setup",
            taxonomySurfaceId: "cli",
            taxonomyCategoryName: "Onboarding",
            inventoryStatus: "complete",
            profiles: ["all"],
            features,
            coverageIds,
            inventoriedCoverageIds: coverageIds,
            inventoryRefs: [],
            scenarioRefs: [],
            missingCoverageIds: [],
            missingInventoryRefs: [],
          },
        ],
      });
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
        expect(imported?.test).toEqual(original.test);
        expect(imported?.result).toEqual(original.result);
        expect(imported?.coverage).toEqual(original.coverage);
        expect(imported?.execution).toEqual(
          evidenceMode === "slim" ? undefined : original.execution,
        );
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
      expect(written.evidenceMode).toBe(evidenceMode);
      expect(written.profilePlan).toEqual(profilePlan);

      const renderArgs = [
        "--import",
        "tsx",
        "scripts/qa/render-maturity-docs.ts",
        "--docs-root",
        docsRoot,
        "--taxonomy",
        taxonomyPath,
        "--scores",
        scoresPath,
        "--evidence-dir",
        outputDir,
        "--output-dir",
        path.join(tempRoot, "rendered"),
      ];
      const rejected = spawnSync(process.execPath, renderArgs, { cwd: repoRoot, encoding: "utf8" });
      expect(rejected.status, rejected.stderr).toBe(1);
      expect(rejected.stderr).toContain("maturity docs require passing QA evidence");
      expect(rejected.stderr).toContain("cli-onboarding (fail)");
      const rendered = spawnSync(process.execPath, [...renderArgs, "--allow-failures"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(rendered.status, rendered.stderr).toBe(0);
      const markdown = await fs.readFile(
        path.join(tempRoot, "rendered/maturity/scorecard.md"),
        "utf8",
      );
      expect(markdown).toContain("25%");
      expect(markdown).toContain("1 passed, 4 failed");
      expect(markdown).toContain("Current taxonomy evidence");

      const historical = structuredClone(written);
      if (!historical.profilePlan) {
        throw new Error("expected captured profile plan");
      }
      delete historical.profilePlan.taxonomyIdentity;
      const historicalDir = path.join(tempRoot, "historical");
      const historicalOutput = path.join(tempRoot, "historical-rendered");
      await fs.mkdir(historicalDir);
      await fs.writeFile(path.join(historicalDir, "qa-evidence.json"), JSON.stringify(historical));
      const historicalRender = spawnSync(
        process.execPath,
        [
          ...renderArgs.map((arg, index) =>
            renderArgs[index - 1] === "--evidence-dir"
              ? historicalDir
              : renderArgs[index - 1] === "--output-dir"
                ? historicalOutput
                : arg,
          ),
          "--allow-failures",
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );
      expect(historicalRender.status, historicalRender.stderr).toBe(0);
      const historicalMarkdown = await fs.readFile(
        path.join(historicalOutput, "maturity/scorecard.md"),
        "utf8",
      );
      expect(historicalMarkdown).toContain("Coverage Unscored");
      expect(historicalMarkdown).toContain("Historical evidence: taxonomy identity unknown");
      expect(historicalMarkdown).toContain("1 passed, 4 failed");
      expect(historicalMarkdown).not.toContain("Current taxonomy evidence");
    },
    60_000,
  );
});
