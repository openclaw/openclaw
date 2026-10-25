import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateQaEvidenceSummaryJson } from "./evidence-summary.js";
import type { QaScenarioCommandExecution } from "./test-file-scenario-command-lifecycle.js";
import {
  QA_TEST_RUNNER_DEFAULTS,
  createScenarioRunnerTestHarness,
  makeTestFileScenario,
  runQaTestFileScenariosWithCommand as runQaTestFileScenarios,
  writeNativeVitestReport,
} from "./test-file-scenario-runner.test-support.js";

const harness = createScenarioRunnerTestHarness();
const makeTempRepo = (prefix: string) => harness.makeTempRepo(prefix);
const playwrightPath = "ui/src/e2e/chat-flow.e2e.test.ts";
type RunOptions = Parameters<typeof runQaTestFileScenarios>[0];
type ReportOptions = Parameters<typeof writeNativeVitestReport>[1];

async function runNative(options: Partial<RunOptions> = {}, report: ReportOptions = { passed: 1 }) {
  const repoRoot = options.repoRoot ?? (await makeTempRepo("qa-playwright-"));
  const commands: QaScenarioCommandExecution[] = [];
  const result = await runQaTestFileScenarios({
    repoRoot,
    outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-playwright"),
    ...QA_TEST_RUNNER_DEFAULTS,
    scenarios: [makeTestFileScenario("playwright", playwrightPath)],
    runCommand: async (command) => {
      commands.push(command);
      await writeNativeVitestReport(command, report);
      return { exitCode: 0, stdout: "pass\n", stderr: "" };
    },
    ...options,
  });
  return { ...result, commands };
}

function reportArgument(result: Awaited<ReturnType<typeof runQaTestFileScenarios>>, id: string) {
  return `--outputFile.json=${path.join(path.dirname(result.results[0]!.logPath), `${id}.vitest-report.json`)}`;
}

function expectFailed(result: Awaited<ReturnType<typeof runNative>>, failureMessage: unknown) {
  expect(result.results[0]).toMatchObject({ status: "fail", failureMessage });
  expect(result.evidence.entries[0]?.result.status).toBe("fail");
}

afterEach(() => harness.cleanup());

describe("qa test file scenario runner", () => {
  it.each([
    {
      kind: "playwright" as const,
      testPath: playwrightPath,
      config: "test/vitest/vitest.ui-e2e.config.ts",
      configArgs: ["--configLoader", "runner"],
      pattern: "^chat > sends a chat turn through the GUI$",
    },
    {
      kind: "vitest" as const,
      testPath: "extensions/ollama/src/node-inference.paired-node.e2e.test.ts",
      config: "test/vitest/vitest.e2e.config.ts",
      configArgs: [],
      pattern: undefined,
    },
  ])(
    "routes $kind E2E scenarios through their existing config and persists evidence",
    async ({ kind, testPath, config, configArgs, pattern }) => {
      const repoRoot = await fs.realpath(await makeTempRepo("qa-native-routing-"));
      const scenario = makeTestFileScenario(kind, testPath, pattern);
      const result = await runNative(
        { repoRoot, scenarios: [scenario] },
        { passed: 1, ancestorTitles: ["chat"], testName: "sends a chat turn through the GUI" },
      );
      const setup =
        kind === "playwright"
          ? [["--import", "tsx", "scripts/ensure-playwright-chromium.mts"]]
          : [];
      expect(result.executionKind).toBe(kind);
      expect(result.results).toMatchObject([{ status: "pass" }]);
      expect(result.commands.map((command) => command.args)).toEqual([
        ...setup,
        [
          "scripts/run-vitest.mjs",
          "run",
          "--config",
          config,
          ...configArgs,
          testPath,
          "--reporter=verbose",
          "--reporter=json",
          reportArgument(result, scenario.id),
          ...(pattern ? ["--testNamePattern", pattern] : []),
        ],
      ]);
      expect(result.commands.map((command) => command.timeoutMs)).toEqual(
        kind === "playwright" ? [1_800_000, 1_800_000] : [1_800_000],
      );
      const evidence = validateQaEvidenceSummaryJson(
        JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
      );
      expect(evidence).toMatchObject({
        schemaVersion: 3,
        entries: [
          {
            test: { kind: `${kind}-test`, id: scenario.id },
            result: { status: "pass" },
            execution: { runner: kind },
          },
        ],
      });
    },
  );

  it("can return aggregate evidence without retaining a duplicate evidence file", async () => {
    const repoRoot = await makeTempRepo("qa-playwright-memory-evidence-");
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-playwright");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "qa-evidence.json"), "stale evidence\n", "utf8");
    const result = await runNative({
      repoRoot,
      outputDir,
      writeEvidenceFile: false,
    });

    expect(result.evidence.entries).toHaveLength(1);
    await expect(fs.access(result.evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a Playwright child that exits successfully without passing any tests", async () => {
    const result = await runNative({}, { passed: 0 });

    expectFailed(
      result,
      "Vitest exited successfully without reporting a successfully executed test.",
    );
    expect(
      result.commands.filter((command) => command.args[0] === "scripts/run-vitest.mjs"),
    ).toHaveLength(1);
  });

  it.each<{ failure: string; report: ReportOptions; pattern?: string }>([
    {
      failure: "requested test file",
      report: { passed: 1, testFilePath: "extensions/qa-lab/src/unrelated.test.ts" },
    },
    {
      failure: "existing requested test file",
      report: { passed: 1, createRequestedTestFile: false },
    },
    {
      failure: "requested test name",
      report: { passed: 1, testName: "unrelated visual assertion" },
      pattern: "required visual assertion",
    },
    {
      failure: "invalid requested test name pattern",
      report: { passed: 1, testName: "executed visual assertion" },
      pattern: "[",
    },
  ])(
    "records invalid $failure as failed Playwright evidence",
    async ({ failure, report, pattern }) => {
      const result = await runNative(
        { scenarios: [makeTestFileScenario("playwright", playwrightPath, pattern)] },
        report,
      );
      expectFailed(result, expect.stringContaining(failure));
    },
  );

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

    const firstRun = await runNative(runParams);
    expect(firstRun.results[0]).toMatchObject({ status: "pass" });
    const reportPath = path.join(path.dirname(firstRun.results[0]!.logPath), reportName);
    const firstBytes = await fs.readFile(reportPath);

    writeReport = false;
    const secondRun = await runNative(runParams);
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
    const scenario = makeTestFileScenario("vitest", "coverage-report.test.ts");
    const executed: string[] = [];
    const result = await runNative({
      failFast: true,
      scenarios: [scenario, { ...scenario, id: "later" }],
      runCommand: async ({ args }) => {
        executed.push(args[0]!);
        return { exitCode: 1, stdout: "", stderr: "native scenario failed\n" };
      },
    });
    expect(executed).toEqual(["scripts/run-vitest.mjs"]);
    expect(result.results).toMatchObject([{ scenario: { id: scenario.id }, status: "fail" }]);
    expect(result.evidence.entries.map((entry) => entry.test.id)).toEqual([scenario.id]);
  });
});
