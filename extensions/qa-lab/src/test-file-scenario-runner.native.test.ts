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

afterEach(async () => {
  await harness.cleanup();
});

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
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-playwright"),
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [
        makeTestFileScenario(
          "playwright",
          "ui/src/e2e/chat-flow.e2e.test.ts",
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
        source: {
          path: "ui/src/e2e/chat-flow.e2e.test.ts",
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
          path: "ui/src/e2e/chat-flow.e2e.test.ts",
        },
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
      result: {
        status: "pass",
      },
    });
  });

  it("can return aggregate evidence without retaining a duplicate evidence file", async () => {
    const repoRoot = await makeTempRepo("qa-playwright-memory-evidence-");
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-playwright");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "qa-evidence.json"), "stale evidence\n", "utf8");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir,
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [makeTestFileScenario("playwright", "ui/src/e2e/chat-flow.e2e.test.ts")],
      writeEvidenceFile: false,
      runCommand: async (command) => {
        await writeNativeVitestReport(command, { passed: 1 });
        return {
          exitCode: 0,
          stdout: "pass\n",
          stderr: "",
        };
      },
    });

    expect(result.evidence.entries).toHaveLength(1);
    await expect(fs.access(result.evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a Playwright child that exits successfully without passing any tests", async () => {
    const executionKind = "playwright";

    const repoRoot = await makeTempRepo(`qa-${executionKind}-executed-tests-`);
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", `scenario-${executionKind}`);
    const scenarioPath = "ui/src/e2e/chat-flow.e2e.test.ts";
    const commands: QaScenarioCommandExecution[] = [];
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir,
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [makeTestFileScenario(executionKind, scenarioPath)],
      runCommand: async (command) => {
        commands.push(command);
        await writeNativeVitestReport(command, { passed: 0 });
        return { exitCode: 0, stdout: "child exited successfully\n", stderr: "" };
      },
    });

    expect(result.results[0]).toMatchObject({ status: "fail" });
    expect(result.evidence.entries[0]?.result.status).toBe("fail");
    expect(commands.filter((command) => command.args[0] === "scripts/run-vitest.mjs")).toHaveLength(
      1,
    );
    expect(result.results[0]?.failureMessage).toBe(
      "Vitest exited successfully without reporting a successfully executed test.",
    );
  });

  it("rejects a passing Playwright report for an unrelated test file", async () => {
    const executionKind = "playwright";

    const repoRoot = await makeTempRepo(`qa-${executionKind}-wrong-report-file-`);
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", `scenario-${executionKind}`);
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir,
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [makeTestFileScenario(executionKind, "ui/src/e2e/chat-flow.e2e.test.ts")],
      runCommand: async (command) => {
        await writeNativeVitestReport(command, {
          passed: 1,
          testFilePath: "extensions/qa-lab/src/unrelated.test.ts",
        });
        return { exitCode: 0, stdout: "unrelated test passed\n", stderr: "" };
      },
    });

    expect(result.results[0]).toMatchObject({
      failureMessage: expect.stringContaining("requested test file"),
      status: "fail",
    });
    expect(result.evidence.entries[0]?.result.status).toBe("fail");
  });

  it("rejects a passing Playwright report when the requested test file does not exist", async () => {
    const executionKind = "playwright";

    const repoRoot = await makeTempRepo(`qa-${executionKind}-missing-requested-test-`);
    const scenarioPath = "ui/src/e2e/chat-flow.e2e.test.ts";
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", `scenario-${executionKind}`),
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [makeTestFileScenario(executionKind, scenarioPath)],
      runCommand: async (command) => {
        await writeNativeVitestReport(command, {
          createRequestedTestFile: false,
          passed: 1,
        });
        return { exitCode: 0, stdout: "missing test reportedly passed\n", stderr: "" };
      },
    });

    expect(result.results[0]).toMatchObject({
      failureMessage: expect.stringContaining("existing requested test file"),
      status: "fail",
    });
    expect(result.evidence.entries[0]?.result.status).toBe("fail");
  });

  it("rejects a passing Playwright report that misses the requested test name", async () => {
    const repoRoot = await makeTempRepo("qa-playwright-wrong-report-test-");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-playwright"),
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [
        makeTestFileScenario(
          "playwright",
          "ui/src/e2e/chat-flow.e2e.test.ts",
          "required visual assertion",
        ),
      ],
      runCommand: async (command) => {
        await writeNativeVitestReport(command, {
          passed: 1,
          testName: "unrelated visual assertion",
        });
        return { exitCode: 0, stdout: "unrelated assertion passed\n", stderr: "" };
      },
    });

    expect(result.results[0]).toMatchObject({
      failureMessage: expect.stringContaining("requested test name"),
      status: "fail",
    });
    expect(result.evidence.entries[0]?.result.status).toBe("fail");
  });

  it("records invalid Playwright test-name patterns as failed scenario evidence", async () => {
    const repoRoot = await makeTempRepo("qa-playwright-invalid-report-pattern-");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-playwright"),
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [makeTestFileScenario("playwright", "ui/src/e2e/chat-flow.e2e.test.ts", "[")],
      runCommand: async (command) => {
        await writeNativeVitestReport(command, {
          passed: 1,
          testName: "executed visual assertion",
        });
        return { exitCode: 0, stdout: "visual assertion passed\n", stderr: "" };
      },
    });

    expect(result.results[0]).toMatchObject({
      failureMessage: expect.stringContaining("invalid requested test name pattern"),
      status: "fail",
    });
    expect(result.evidence.entries[0]?.result.status).toBe("fail");
  });

  it("does not reuse a prior passing Playwright report when the next child writes none", async () => {
    const executionKind = "playwright";

    const repoRoot = await makeTempRepo(`qa-${executionKind}-stale-vitest-report-`);
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", `scenario-${executionKind}`);
    const scenarioPath = "ui/src/e2e/chat-flow.e2e.test.ts";
    const reportName = `scenario-${executionKind}.vitest-report.json`;
    let writeReport = true;
    const runParams = {
      repoRoot,
      outputDir,
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [makeTestFileScenario(executionKind, scenarioPath)],
      runCommand: async (command: QaScenarioCommandExecution) => {
        if (writeReport) {
          await writeNativeVitestReport(command, { passed: 1 });
        }
        return { exitCode: 0, stdout: "child exited successfully\n", stderr: "" };
      },
    };

    const firstRun = await runQaTestFileScenarios(runParams);
    expect(firstRun.results[0]).toMatchObject({ status: "pass" });
    const reportPath = path.join(path.dirname(firstRun.results[0]!.logPath), reportName);
    const firstBytes = await fs.readFile(reportPath);

    writeReport = false;
    const secondRun = await runQaTestFileScenarios(runParams);
    const secondReportPath = path.join(path.dirname(secondRun.results[0]!.logPath), reportName);
    expect(secondReportPath).not.toBe(reportPath);
    expect(secondRun.results[0]).toMatchObject({
      failureMessage: `Vitest exited successfully without writing a valid JSON test report at ${secondReportPath}.`,
      status: "fail",
    });
    expect(secondRun.evidence.entries[0]?.result.status).toBe("fail");
    await expect(fs.access(secondReportPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(reportPath)).toEqual(firstBytes);
  });

  it("stops native scenarios after the first failure in fail-fast mode", async () => {
    const failFast = true;
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
      failFast,
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

    const requestedTestFile = path.join(repoRoot, testPath);
    await fs.mkdir(path.dirname(requestedTestFile), { recursive: true });
    await fs.writeFile(requestedTestFile, "// native scenario fixture\n", "utf8");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", scenario.id),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      scenarios: [scenario],
      runCommand: async (command) => {
        commands.push(command);
        const reportArg = command.args.find((arg) => arg.startsWith("--outputFile.json="));
        if (!reportArg) {
          throw new Error("native Vitest scenario did not request a JSON test report");
        }
        await fs.writeFile(
          reportArg.slice("--outputFile.json=".length),
          JSON.stringify({
            numFailedTests: 0,
            numPassedTests: 1,
            success: true,
            testResults: [
              {
                name: path.join(repoRoot, testPath),
                status: "passed",
                assertionResults: [{ fullName: "runs paired node inference", status: "passed" }],
              },
            ],
          }),
          "utf8",
        );
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
