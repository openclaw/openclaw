import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateQaEvidenceSummaryJson } from "./evidence-summary.js";
import { resolveQaScriptRuntimeExecutable } from "./test-file-scenario-runner-commands.js";
import {
  buildScriptProducerEvidence,
  createScenarioRunnerTestHarness,
  makeTestFileScenario,
  writeScriptProducerEvidence,
  resolveScriptAttemptOutputDir,
  runQaTestFileScenariosWithCommand as runQaTestFileScenarios,
  QA_TEST_RUNNER_DEFAULTS,
  writeFixtureJson,
} from "./test-file-scenario-runner.test-support.js";

const harness = createScenarioRunnerTestHarness();
afterEach(() => harness.cleanup());
type RunOptions = Parameters<typeof runQaTestFileScenarios>[0];
const scriptScenario = (script = "scripts/evidence-producer.ts") =>
  makeTestFileScenario("script", script);
const runScript = (repoRoot: string, options: Partial<RunOptions>) =>
  runQaTestFileScenarios({
    repoRoot,
    ...QA_TEST_RUNNER_DEFAULTS,
    scenarios: [scriptScenario()],
    outputDir: path.join(repoRoot, "out"),
    ...options,
  });

describe("qa test file scenario runner", () => {
  it.each([
    ["missing", /without writing fresh producer QA evidence/u],
    ["empty", /without reporting an executed producer check/u],
    ["malformed", /invalid JSON/u],
    ["outside", /inside its scenario output directory/u],
  ] as const)(
    "retains %s producer failure alongside passing evidence",
    async (evidence, expectedFailure) => {
      const evidenceMode = evidence === "empty" ? "slim" : "full";
      const repoRoot = await harness.makeTempRepo(`qa-script-${evidence}-producer-evidence-`);
      const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script");

      const result = await runScript(repoRoot, {
        outputDir,
        evidenceMode,
        scenarios: [
          scriptScenario(),
          { ...scriptScenario("scripts/healthy-evidence-producer.ts"), id: "healthy-scenario" },
        ],
        runCommand: async (command) => {
          const attemptOutputDir = resolveScriptAttemptOutputDir(command);
          const attemptScenarioDir = path.join(attemptOutputDir, "scenario-script");
          const attemptRunPath = path.join(attemptScenarioDir, "latest-run.json");
          const attemptEvidencePath = path.join(attemptScenarioDir, "qa-evidence.json");
          if (command.args.includes("scripts/healthy-evidence-producer.ts")) {
            await writeScriptProducerEvidence({
              outputDir: attemptOutputDir,
              scenarioId: "healthy-scenario",
              producerId: "healthy-check",
              status: "pass",
            });
            return { exitCode: 0, stdout: "healthy check passed\n", stderr: "" };
          }
          await fs.mkdir(attemptScenarioDir, { recursive: true });
          if (evidence === "empty") {
            await writeFixtureJson(attemptEvidencePath, {
              kind: "openclaw.qa.evidence-summary",
              schemaVersion: 2,
              generatedAt: new Date().toISOString(),
              evidenceMode: "full",
              entries: [],
            });
          } else if (evidence === "malformed") {
            await fs.writeFile(attemptEvidencePath, "{not valid JSON", "utf8");
          } else if (evidence === "outside") {
            const outside = await writeScriptProducerEvidence({
              outputDir: attemptOutputDir,
              scenarioId: "different-script-scenario",
              status: "pass",
            });
            await writeFixtureJson(attemptRunPath, { qaEvidence: outside.evidencePath });
          }
          return { exitCode: 0, stdout: "script exited successfully\n", stderr: "" };
        },
      });

      expect(result.results).toMatchObject([
        { status: "fail", failureMessage: expect.stringMatching(expectedFailure) },
        { status: "pass" },
      ]);
      const exportedEvidence = validateQaEvidenceSummaryJson(
        JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
      );
      expect(exportedEvidence.evidenceMode).toBe(evidenceMode);
      expect(exportedEvidence.entries).toMatchObject([
        { test: { id: "scenario-script" }, result: { status: "fail" } },
        { test: { id: "healthy-check" }, result: { status: "pass" } },
      ]);
      if (evidenceMode === "slim") {
        expect(exportedEvidence.entries.every((entry) => entry.execution === undefined)).toBe(true);
      }
    },
  );

  it("retains a terminal failure beside colliding passing producer evidence", async () => {
    const commandName = path.basename(resolveQaScriptRuntimeExecutable());
    const tempRoot = await harness.makeTempRepo("qa-script-terminal-exit-pass-");
    const outputDir = path.join(tempRoot, "out");
    const scriptPath = path.join(tempRoot, "terminal-evidence-producer.mjs");
    const result = await runScript(process.cwd(), {
      outputDir,
      scenarios: [scriptScenario(scriptPath)],
      runCommand: async (command) => {
        const { evidenceDir } = await writeScriptProducerEvidence({
          outputDir: resolveScriptAttemptOutputDir(command),
          producerId: "scenario-script",
          status: "pass",
          additionalEntries: buildScriptProducerEvidence({
            producerId: "producer-diagnostic",
            status: "pass",
          }).entries,
          artifacts: [{ kind: "log", path: "producer.log" }],
          latestRun: "relative",
        });
        await fs.writeFile(path.join(evidenceDir, "producer.log"), "producer evidence\n", "utf8");
        return { exitCode: 7, signal: null, stdout: "", stderr: "" };
      },
    });

    expect(result.results[0]).toMatchObject({
      failureMessage: `${commandName} exited with 7`,
      status: "fail",
    });
    expect(result.evidence.entries).toMatchObject([
      {
        test: { id: "scenario-script" },
        coverage: [],
        execution: {
          artifacts: [{ kind: "log", path: expect.stringContaining("producer.log") }],
          runner: "evidence-producer-script",
        },
        result: { status: "pass" },
      },
      { test: { id: "producer-diagnostic" }, result: { status: "pass" } },
      {
        test: { id: "scenario-script", kind: "script-test" },
        coverage: [],
        result: {
          failure: { reason: `${commandName} exited with 7` },
          status: "fail",
        },
      },
    ]);
  });
});
