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
    const producer = {
      additionalEntries: buildScriptProducerEvidence({
        producerId: "producer-diagnostic",
        status: "pass",
      }).entries,
      artifacts: [{ kind: "log", path: "producer.log" }],
      producerId: "scenario-script",
      status: "pass" as const,
    };
    const result = await runScript(process.cwd(), {
      outputDir,
      scenarios: [scriptScenario(scriptPath)],
      commandTimeoutMs: 1_000,
      runCommand: async (command) => {
        const attemptOutputDir = resolveScriptAttemptOutputDir(command);
        const artifactBase = path.join(attemptOutputDir, "scenario-script");
        expect(command).toMatchObject({
          args: ["--import", "tsx", scriptPath, "--once", "--artifact-base", artifactBase],
          timeoutMs: 1_000,
        });

        const { evidenceDir } = await writeScriptProducerEvidence({
          ...producer,
          outputDir: attemptOutputDir,
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

  it("imports coverage-free structured evidence through the real script lifecycle", async () => {
    const tempRoot = await harness.makeTempDir("qa-script-real-evidence-");
    const scriptPath = path.join(tempRoot, "minimal-evidence-producer.mjs");
    const producerEvidence = buildScriptProducerEvidence({
      artifacts: [{ kind: "log", path: "artifact.log" }],
      coverage: [],
      profile: "smoke-ci",
      status: "pass",
    });
    await fs.writeFile(
      scriptPath,
      [
        "import fs from 'node:fs/promises';",
        "import path from 'node:path';",
        "const artifactBaseIndex = process.argv.indexOf('--artifact-base');",
        "if (artifactBaseIndex < 0) throw new Error('missing --artifact-base');",
        "const artifactBase = process.argv[artifactBaseIndex + 1];",
        "const runRoot = artifactBase;",
        "await fs.mkdir(runRoot, { recursive: true });",
        "await fs.writeFile(path.join(runRoot, 'artifact.log'), 'structured evidence\\n', 'utf8');",
        `const evidence = ${JSON.stringify(producerEvidence)};`,
        "await fs.writeFile(path.join(runRoot, 'qa-evidence.json'), JSON.stringify(evidence), 'utf8');",
      ].join("\n"),
      "utf8",
    );
    const infrastructureFixture = scriptScenario(scriptPath);
    delete infrastructureFixture.coverage;

    const result = await runScript(process.cwd(), {
      outputDir: path.join(tempRoot, "out"),
      scenarios: [infrastructureFixture],
      evidenceMode: "full",
      commandTimeoutMs: 20_000,
      env: { OPENCLAW_QA_REF: "temporary-script-fixture", OPENCLAW_QA_PROFILE: "smoke-ci" },
    });

    expect(result).toMatchObject({
      executionKind: "script",
      evidence: { profile: "smoke-ci" },
      results: [
        {
          status: "pass",
          producerEvidence: { entries: [{ test: { id: "script-producer.web-ui.smoke" } }] },
        },
      ],
    });
    const artifact = path.join(
      path.dirname(result.results[0]!.logPath),
      "scenario-script",
      "artifact.log",
    );
    expect(result.evidence.entries[0]).toMatchObject({
      coverage: [],
      execution: { artifacts: [{ kind: "log", path: artifact }] },
      test: { id: "script-producer.web-ui.smoke" },
    });
  });
});
