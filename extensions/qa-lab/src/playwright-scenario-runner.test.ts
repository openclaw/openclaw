import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateQaEvidenceSummaryJson } from "./evidence-summary.js";
import { runQaPlaywrightScenarios } from "./playwright-scenario-runner.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import type { QaScenarioCommandExecution } from "./scenario-command-runner.js";

const tempRoots: string[] = [];

function makePlaywrightScenario(pathLocal: string): QaSeedScenarioWithSource {
  return {
    id: "scenario-playwright",
    title: "playwright scenario",
    surface: "control-ui",
    category: "browser-control-ui-and-webchat.browser-ui",
    coverage: {
      primary: ["ui.control"],
      secondary: ["ui.streaming"],
    },
    objective: "Exercise Playwright scenario evidence.",
    successCriteria: ["The scenario passes."],
    docsRefs: ["docs/concepts/qa-e2e-automation.md"],
    codeRefs: [pathLocal],
    sourcePath: "qa/scenarios/ui/scenario-playwright.md",
    execution: {
      kind: "playwright",
      path: pathLocal,
    },
  };
}

async function makeTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-playwright-scenario-"));
  tempRoots.push(repoRoot);
  await fs.mkdir(path.join(repoRoot, ".artifacts", "qa-e2e"), { recursive: true });
  return repoRoot;
}

describe("qa playwright scenario runner", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("runs the repo UI e2e command and writes Playwright evidence", async () => {
    const repoRoot = await makeTempRepo();
    const commands: QaScenarioCommandExecution[] = [];
    const result = await runQaPlaywrightScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-playwright"),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      scenarios: [makePlaywrightScenario("ui/src/ui/e2e/chat-flow.e2e.test.ts")],
      runCommand: async (command) => {
        commands.push(command);
        return {
          exitCode: 0,
          stdout: "pass\n",
          stderr: "",
        };
      },
      env: {
        OPENCLAW_QA_REF: "scenario-ref",
      } as NodeJS.ProcessEnv,
    });

    expect(commands.map((command) => command.args)).toEqual([
      ["scripts/ensure-playwright-chromium.mjs"],
      [
        "scripts/run-vitest.mjs",
        "run",
        "--config",
        "test/vitest/vitest.ui-e2e.config.ts",
        "--configLoader",
        "runner",
        "ui/src/ui/e2e/chat-flow.e2e.test.ts",
        "--reporter=verbose",
      ],
    ]);
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    expect(evidence.schemaVersion).toBe(2);
    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0]).toMatchObject({
      test: {
        kind: "playwright-test",
        id: "scenario-playwright",
        source: {
          path: "ui/src/ui/e2e/chat-flow.e2e.test.ts",
        },
      },
      mapping: {
        coverage: [
          {
            id: "ui.control",
            role: "primary",
            surfaceIds: ["control-ui"],
            categoryIds: ["browser-control-ui-and-webchat.browser-ui"],
          },
          {
            id: "ui.streaming",
            role: "secondary",
            surfaceIds: ["control-ui"],
            categoryIds: [],
          },
        ],
        refs: [
          {
            kind: "docs",
            path: "docs/concepts/qa-e2e-automation.md",
          },
          {
            kind: "code",
            path: "ui/src/ui/e2e/chat-flow.e2e.test.ts",
          },
        ],
      },
      execution: {
        runner: "playwright",
        artifacts: [
          {
            kind: "report",
            path: ".artifacts/qa-e2e/scenario-playwright/qa-playwright-report.md",
            source: "playwright",
          },
          {
            kind: "log",
            path: ".artifacts/qa-e2e/scenario-playwright/scenario-playwright.log",
            source: "playwright",
          },
        ],
      },
      result: {
        status: "pass",
      },
    });
    expect(await fs.readFile(result.reportPath, "utf8")).toContain("Evidence summary");
  });
});
