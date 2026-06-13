import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateQaEvidenceSummaryJson } from "./evidence-summary.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import type { QaScenarioCommandExecution } from "./scenario-command-runner.js";
import { runQaVitestScenarios } from "./vitest-scenario-runner.js";

const tempRoots: string[] = [];

function makeVitestScenario(pathLocal: string): QaSeedScenarioWithSource {
  return {
    id: "scenario-vitest",
    title: "vitest scenario",
    surface: "qa-lab",
    category: "qa-lab.coverage",
    coverage: {
      primary: ["qa.coverage"],
      secondary: ["qa.reporting"],
    },
    objective: "Exercise Vitest scenario evidence.",
    successCriteria: ["The scenario produces a failed evidence entry."],
    docsRefs: ["docs/concepts/qa-e2e-automation.md"],
    codeRefs: [pathLocal],
    sourcePath: "qa/scenarios/lab/scenario-vitest.md",
    execution: {
      kind: "vitest",
      path: pathLocal,
    },
  };
}

async function makeTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-vitest-scenario-"));
  tempRoots.push(repoRoot);
  await fs.mkdir(path.join(repoRoot, ".artifacts", "qa-e2e"), { recursive: true });
  return repoRoot;
}

describe("qa vitest scenario runner", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("runs the declared test path and writes Vitest evidence", async () => {
    const repoRoot = await makeTempRepo();
    const commands: QaScenarioCommandExecution[] = [];
    const result = await runQaVitestScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-vitest"),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      scenarios: [makeVitestScenario("extensions/qa-lab/src/coverage-report.test.ts")],
      runCommand: async (command) => {
        commands.push(command);
        return {
          exitCode: 1,
          stdout: "",
          stderr: "failed\n",
        };
      },
    });

    expect(commands.map((command) => command.args)).toEqual([
      [
        "scripts/run-vitest.mjs",
        "extensions/qa-lab/src/coverage-report.test.ts",
        "--reporter=verbose",
      ],
    ]);
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    expect(evidence.entries[0]).toMatchObject({
      test: {
        kind: "vitest-test",
        id: "scenario-vitest",
        source: {
          path: "extensions/qa-lab/src/coverage-report.test.ts",
        },
      },
      mapping: {
        coverage: [
          {
            id: "qa.coverage",
            role: "primary",
          },
          {
            id: "qa.reporting",
            role: "secondary",
          },
        ],
      },
      execution: {
        runner: "vitest",
        artifacts: [
          {
            kind: "report",
            path: ".artifacts/qa-e2e/scenario-vitest/qa-vitest-report.md",
            source: "vitest",
          },
          {
            kind: "log",
            path: ".artifacts/qa-e2e/scenario-vitest/scenario-vitest.log",
            source: "vitest",
          },
        ],
      },
      result: {
        status: "fail",
        failure: {
          reason: "node exited with 1",
        },
      },
    });
  });
});
