import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateQaEvidenceSummaryJson } from "./evidence-summary.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { attachQaProfileScorecardEvidenceToFile } from "./scorecard-evidence.js";
import { runQaTestFileScenarios } from "./test-file-scenario-runner.js";
import {
  buildScriptProducerEvidence,
  createScenarioRunnerTestHarness,
  makeTestFileScenario,
  writeScriptProducerEvidence,
  QA_TEST_RUNNER_DEFAULTS,
} from "./test-file-scenario-runner.test-support.js";

const harness = createScenarioRunnerTestHarness();

afterEach(async () => {
  await harness.cleanup();
});

describe("producer coverage claims", () => {
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
        runCommand: async () => {
          await writeScriptProducerEvidence({
            outputDir,
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
                path: "out/scenario-script/run-1/producer.log",
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
        failureMessage: `${path.basename(process.execPath)} exited with 7`,
        includeFallbackEvidence: true,
      });
      expect(result.evidence.entries.map((entry) => [entry.test.id, entry.result.status])).toEqual([
        ["cli-gateway-auth-storage", "fail"],
        ["cli-guided-onboarding", "pass"],
        ["cli-remote-onboarding", "fail"],
        ["cli-targeted-reconfiguration", "fail"],
        ["cli-onboarding", "fail"],
      ]);
      const features = coverageIds.map((id) => ({ name: id, coverageIds: [id] }));
      const scorecard = await attachQaProfileScorecardEvidenceToFile({
        evidencePath: result.evidencePath,
        evidenceMode,
        profile: "all",
        profilePlan: {
          profile: "all",
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
        },
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
      const renderArgs = [
        "--import",
        "tsx",
        "scripts/qa/render-maturity-docs.ts",
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
    },
    60_000,
  );
});
