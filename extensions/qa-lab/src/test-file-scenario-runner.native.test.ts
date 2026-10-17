import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateQaEvidenceSummaryJson } from "./evidence-summary.js";
import { readQaScenarioPack, type QaSeedScenarioWithSource } from "./scenario-catalog.js";
import {
  runQaTestFileScenarios,
  type QaScenarioCommandExecution,
} from "./test-file-scenario-runner.js";
import {
  QA_TEST_RUNNER_DEFAULTS,
  createScenarioRunnerTestHarness,
  makeTestFileScenario,
  writeNativeVitestReport,
} from "./test-file-scenario-runner.test-support.js";

const harness = createScenarioRunnerTestHarness();
const makeTempRepo = (prefix: string) => harness.makeTempRepo(prefix);
const playwrightPath = "ui/src/e2e/chat-flow.e2e.test.ts";
type RunOptions = Parameters<typeof runQaTestFileScenarios>[0];
type ReportOptions = Parameters<typeof writeNativeVitestReport>[1];

async function runPlaywright(
  options: Partial<RunOptions> = {},
  report: ReportOptions = { passed: 1 },
  stdout = "pass\n",
) {
  const repoRoot = options.repoRoot ?? (await makeTempRepo("qa-playwright-"));
  return runQaTestFileScenarios({
    repoRoot,
    outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-playwright"),
    ...QA_TEST_RUNNER_DEFAULTS,
    scenarios: [makeTestFileScenario("playwright", playwrightPath)],
    runCommand: async (command) => {
      await writeNativeVitestReport(command, report);
      return { exitCode: 0, stdout, stderr: "" };
    },
    ...options,
  });
}

function expectFailed(result: Awaited<ReturnType<typeof runPlaywright>>, failureMessage: unknown) {
  expect(result.results[0]).toMatchObject({ status: "fail", failureMessage });
  expect(result.evidence.entries[0]?.result.status).toBe("fail");
}

afterEach(() => harness.cleanup());

describe("qa test file scenario runner", () => {
  it("keeps every Playwright scenario pattern aligned with an executable test", async () => {
    for (const scenario of readQaScenarioPack().scenarios) {
      const execution = scenario.execution;
      if (execution.kind !== "playwright" || !execution.testNamePattern) {
        continue;
      }
      const testSource = await fs.readFile(execution.path, "utf8");
      const testNamePattern = new RegExp(execution.testNamePattern);
      const testNames = testSource.matchAll(/\bit\s*\(\s*["'`]([^"'`\n]+)["'`]/gu);
      expect(
        Array.from(testNames, (match) => match[1] ?? "").some((name) => testNamePattern.test(name)),
        `${scenario.id} testNamePattern matches an executable test`,
      ).toBe(true);
    }
  });

  it("runs Playwright scenarios with the repo UI e2e command and writes Playwright evidence", async () => {
    const repoRoot = await makeTempRepo("qa-playwright-scenario-");
    const commands: QaScenarioCommandExecution[] = [];
    const result = await runPlaywright({
      repoRoot,
      scenarios: [
        makeTestFileScenario(
          "playwright",
          playwrightPath,
          "^chat > sends a chat turn through the GUI$",
        ),
      ],
      runCommand: async (command) => {
        commands.push(command);
        await writeNativeVitestReport(command, {
          passed: 1,
          ancestorTitles: ["chat"],
          testName: "sends a chat turn through the GUI",
        });
        return { exitCode: 0, stdout: "pass\n", stderr: "" };
      },
      env: {
        OPENCLAW_QA_REF: "scenario-ref",
      },
    });

    expect(result.executionKind).toBe("playwright");
    expect(commands.map((command) => command.args)).toEqual([
      ["--import", "tsx", "scripts/ensure-playwright-chromium.mts"],
      [
        "scripts/run-vitest.mjs",
        "run",
        "--config",
        "test/vitest/vitest.ui-e2e.config.ts",
        "--configLoader",
        "runner",
        "ui/src/e2e/chat-flow.e2e.test.ts",
        "--reporter=verbose",
        "--reporter=json",
        `--outputFile.json=${path.join(
          path.dirname(result.results[0]!.logPath),
          "scenario-playwright.vitest-report.json",
        )}`,
        "--testNamePattern",
        "^chat > sends a chat turn through the GUI$",
      ],
    ]);
    expect(commands.map((command) => command.timeoutMs)).toEqual([1_800_000, 1_800_000]);
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    expect(evidence.schemaVersion).toBe(3);
    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0]).toMatchObject({
      test: {
        kind: "playwright-test",
        id: "scenario-playwright",
        source: { path: playwrightPath },
      },
      coverage: [
        { id: "ui.control", role: "primary" },
        { id: "ui.streaming", role: "secondary" },
      ],
      refs: [
        { kind: "docs", path: "docs/concepts/qa-e2e-automation.md" },
        { kind: "code", path: playwrightPath },
      ],
      execution: {
        runner: "playwright",
        artifacts: [
          {
            kind: "log",
            path: `<repo-root>/${path.relative(repoRoot, result.results[0]!.logPath).split(path.sep).join("/")}`,
            source: "playwright",
          },
        ],
      },
      result: { status: "pass" },
    });
  });

  it("can return aggregate evidence without retaining a duplicate evidence file", async () => {
    const repoRoot = await makeTempRepo("qa-playwright-memory-evidence-");
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-playwright");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "qa-evidence.json"), "stale evidence\n", "utf8");
    const result = await runPlaywright({
      repoRoot,
      outputDir,
      writeEvidenceFile: false,
    });

    expect(result.evidence.entries).toHaveLength(1);
    await expect(fs.access(result.evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a Playwright child that exits successfully without passing any tests", async () => {
    const commands: QaScenarioCommandExecution[] = [];
    const result = await runPlaywright({
      runCommand: async (command) => {
        commands.push(command);
        await writeNativeVitestReport(command, { passed: 0 });
        return { exitCode: 0, stdout: "child exited successfully\n", stderr: "" };
      },
    });

    expectFailed(
      result,
      "Vitest exited successfully without reporting a successfully executed test.",
    );
    expect(commands.filter((command) => command.args[0] === "scripts/run-vitest.mjs")).toHaveLength(
      1,
    );
  });

  it("rejects a passing Playwright report for an unrelated test file", async () => {
    const result = await runPlaywright(
      {},
      {
        passed: 1,
        testFilePath: "extensions/qa-lab/src/unrelated.test.ts",
      },
      "unrelated test passed\n",
    );
    expectFailed(result, expect.stringContaining("requested test file"));
  });

  it("rejects a passing Playwright report when the requested test file does not exist", async () => {
    const result = await runPlaywright(
      {},
      { createRequestedTestFile: false, passed: 1 },
      "missing test reportedly passed\n",
    );
    expectFailed(result, expect.stringContaining("existing requested test file"));
  });

  it("rejects a passing Playwright report that misses the requested test name", async () => {
    const result = await runPlaywright(
      {
        scenarios: [
          makeTestFileScenario("playwright", playwrightPath, "required visual assertion"),
        ],
      },
      { passed: 1, testName: "unrelated visual assertion" },
      "unrelated assertion passed\n",
    );
    expectFailed(result, expect.stringContaining("requested test name"));
  });

  it("records invalid Playwright test-name patterns as failed scenario evidence", async () => {
    const result = await runPlaywright(
      {
        scenarios: [makeTestFileScenario("playwright", playwrightPath, "[")],
      },
      { passed: 1, testName: "executed visual assertion" },
      "visual assertion passed\n",
    );
    expectFailed(result, expect.stringContaining("invalid requested test name pattern"));
  });

  it("does not reuse a prior passing Playwright report when the next child writes none", async () => {
    const repoRoot = await makeTempRepo("qa-playwright-stale-vitest-report-");
    const reportName = "scenario-playwright.vitest-report.json";
    let writeReport = true;
    const runParams = {
      repoRoot,
      runCommand: async (command: QaScenarioCommandExecution) => {
        if (writeReport) {
          await writeNativeVitestReport(command, { passed: 1 });
        }
        return { exitCode: 0, stdout: "child exited successfully\n", stderr: "" };
      },
    };

    const firstRun = await runPlaywright(runParams);
    expect(firstRun.results[0]).toMatchObject({ status: "pass" });
    const reportPath = path.join(path.dirname(firstRun.results[0]!.logPath), reportName);
    const firstBytes = await fs.readFile(reportPath);

    writeReport = false;
    const secondRun = await runPlaywright(runParams);
    const secondReportPath = path.join(path.dirname(secondRun.results[0]!.logPath), reportName);
    expect(secondReportPath).not.toBe(reportPath);
    expectFailed(
      secondRun,
      `Vitest exited successfully without writing a valid JSON test report at ${secondReportPath}.`,
    );
    await expect(fs.access(secondReportPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(reportPath)).toEqual(firstBytes);
  });

  it("stops native scenarios after the first failure in fail-fast mode", async () => {
    const expectedScenarioIds = ["first-native-scenario"];

    const repoRoot = await makeTempRepo("qa-vitest-fail-fast-");
    const runCommand = vi.fn(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "native scenario failed\n",
    }));
    const firstScenario = {
      ...makeTestFileScenario("vitest", "extensions/qa-lab/src/coverage-report.test.ts"),
      id: "first-native-scenario",
    };
    const laterScenario = {
      ...makeTestFileScenario("vitest", "extensions/qa-lab/src/cli.test.ts"),
      id: "later-native-scenario",
    };

    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "native-fail-fast"),
      ...QA_TEST_RUNNER_DEFAULTS,
      failFast: true,
      scenarios: [firstScenario, laterScenario],
      runCommand,
    });

    expect(runCommand).toHaveBeenCalledTimes(expectedScenarioIds.length);
    expect(result.results.map((scenario) => scenario.scenario.id)).toEqual(expectedScenarioIds);
    expect(result.results.every((scenario) => scenario.status === "fail")).toBe(true);
    expect(result.evidence.entries.map((entry) => entry.test.id)).toEqual(expectedScenarioIds);
  });
});

describe("QA native Vitest scenario routing", () => {
  it("runs E2E test scenarios under the existing Gateway E2E configuration", async () => {
    const repoRoot = await fs.realpath(await makeTempRepo("openclaw-qa-vitest-e2e-routing-"));
    const commands: QaScenarioCommandExecution[] = [];
    const testPath = "extensions/ollama/src/node-inference.paired-node.e2e.test.ts";
    const scenario: QaSeedScenarioWithSource = {
      id: "ollama-paired-node-inference",
      title: "Ollama paired-node inference",
      surface: "models",
      category: "agent-runtime.local-and-self-hosted-providers",
      coverage: { primary: [], secondary: ["gateway.remote-host-commands"] },
      objective: "Run local inference through an authenticated paired Gateway node.",
      successCriteria: ["The real Gateway routes inference to its paired node."],
      docsRefs: ["docs/providers/ollama.md"],
      codeRefs: [testPath],
      sourcePath: "qa/scenarios/models/ollama-paired-node-inference.yaml",
      execution: { kind: "vitest", path: testPath },
    };

    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", scenario.id),
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [scenario],
      runCommand: async (command) => {
        commands.push(command);
        await writeNativeVitestReport(command, {
          passed: 1,
          testName: "runs paired node inference",
        });
        return { exitCode: 0, stdout: "1 passed\n", stderr: "" };
      },
    });

    expect(result.executionKind).toBe("vitest");
    expect(result.results).toMatchObject([{ status: "pass" }]);
    expect(result.evidence.entries[0]?.result.status).toBe("pass");
    expect(commands.map((command) => command.args)).toEqual([
      [
        "scripts/run-vitest.mjs",
        "run",
        "--config",
        "test/vitest/vitest.e2e.config.ts",
        testPath,
        "--reporter=verbose",
        "--reporter=json",
        `--outputFile.json=${path.join(
          path.dirname(result.results[0]!.logPath),
          `${scenario.id}.vitest-report.json`,
        )}`,
      ],
    ]);
  });
});
