import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateQaEvidenceSummaryJson } from "./evidence-summary.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import {
  runQaTestFileScenarios,
  type QaScenarioCommandExecution,
} from "./test-file-scenario-runner.js";

const tempRoots: string[] = [];

function makeTestFileScenario(
  executionKind: "vitest" | "playwright",
  pathLocal: string,
): QaSeedScenarioWithSource {
  return {
    id: `scenario-${executionKind}`,
    title: `${executionKind} scenario`,
    surface: executionKind === "playwright" ? "control-ui" : "qa-lab",
    category:
      executionKind === "playwright"
        ? "browser-control-ui-and-webchat.browser-ui"
        : "qa-lab.coverage",
    coverage: {
      primary: [executionKind === "playwright" ? "ui.control" : "qa.coverage"],
      secondary: [executionKind === "playwright" ? "ui.streaming" : "qa.reporting"],
    },
    objective: `Exercise ${executionKind} scenario evidence.`,
    successCriteria: ["The scenario writes structured evidence."],
    docsRefs: ["docs/concepts/qa-e2e-automation.md"],
    codeRefs: [pathLocal],
    sourcePath: `qa/scenarios/ui/scenario-${executionKind}.md`,
    execution: {
      kind: executionKind,
      path: pathLocal,
    },
  };
}

async function makeTempRepo(prefix: string) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(repoRoot);
  await fs.mkdir(path.join(repoRoot, ".artifacts", "qa-e2e"), { recursive: true });
  return repoRoot;
}

describe("qa test file scenario runner", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("runs Playwright scenarios with the repo UI e2e command and writes Playwright evidence", async () => {
    const repoRoot = await makeTempRepo("qa-playwright-scenario-");
    const commands: QaScenarioCommandExecution[] = [];
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-playwright"),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      scenarios: [makeTestFileScenario("playwright", "ui/src/ui/e2e/chat-flow.e2e.test.ts")],
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

    expect(result.executionKind).toBe("playwright");
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
      coverage: [
        {
          id: "ui.control",
          role: "primary",
        },
        {
          id: "ui.streaming",
          role: "secondary",
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
      execution: {
        runner: "playwright",
        artifacts: [
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
  });

  it("runs Vitest scenarios with the declared test path and writes Vitest evidence", async () => {
    const repoRoot = await makeTempRepo("qa-vitest-scenario-");
    const commands: QaScenarioCommandExecution[] = [];
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-vitest"),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      scenarios: [makeTestFileScenario("vitest", "extensions/qa-lab/src/coverage-report.test.ts")],
      runCommand: async (command) => {
        commands.push(command);
        return {
          exitCode: 1,
          stdout: "",
          stderr: "failed\n",
        };
      },
    });

    expect(result.executionKind).toBe("vitest");
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
      execution: {
        runner: "vitest",
        artifacts: [
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
