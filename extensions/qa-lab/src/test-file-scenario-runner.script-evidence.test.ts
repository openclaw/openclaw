import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  projectQaEvidenceScenarioOutcomes,
  validateQaEvidenceSummaryJson,
} from "./evidence-summary.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import { resolveQaScriptRuntimeExecutable } from "./test-file-scenario-runner-commands.js";
import { runQaTestFileScenarios } from "./test-file-scenario-runner.js";
import {
  buildScriptProducerEvidence,
  QA_TEST_RUNNER_DEFAULTS,
  createScenarioRunnerTestHarness,
  makeTestFileScenario,
  writeScriptProducerEvidence,
  resolveScriptAttemptOutputDir,
} from "./test-file-scenario-runner.test-support.js";

const harness = createScenarioRunnerTestHarness();
const makeTempRepo = (prefix: string) => harness.makeTempRepo(prefix);

afterEach(async () => {
  await harness.cleanup();
});

describe("qa test file scenario runner", () => {
  it("preserves the selected original failure when a continued producer is blocked", async () => {
    const status = "blocked";

    const repoRoot = await makeTempRepo("qa-script-continued-");
    const outputDir = path.join(repoRoot, "evidence");
    const scenarios = [makeTestFileScenario("script", "scripts/evidence-producer.ts")];
    const run = (
      next: "fail" | "blocked",
      continuation?: ReturnType<typeof validateQaEvidenceSummaryJson>,
    ) =>
      runQaTestFileScenarios({
        repoRoot,
        outputDir,
        scenarios,
        ...QA_TEST_RUNNER_DEFAULTS,
        ...(continuation?.schemaVersion === 3
          ? {
              evidenceAnchors: continuation.occurrences.filter(
                (item) => item.scenario?.kind === "instance",
              ),
              evidenceContinuation: continuation,
            }
          : {}),
        runCommand: async (command) => {
          await writeScriptProducerEvidence({
            outputDir: resolveScriptAttemptOutputDir(command),
            status: next,
            failureReason: next === "fail" ? "original failure" : "later nonpass",
          });
          return { exitCode: 0, stdout: next, stderr: "" };
        },
      });
    const first = await run("fail");
    const later = await run(status, first.evidence);
    expect(later.results[0]).toMatchObject({
      status: "fail",
      failureMessage: "original failure",
      evidenceOccurrenceId: first.results[0]!.evidenceOccurrenceId,
      logPath: first.results[0]!.logPath,
    });
    expect(projectQaEvidenceScenarioOutcomes(later.evidence)[0]).toMatchObject({
      status: "fail",
      occurrenceId: first.results[0]!.evidenceOccurrenceId,
    });
    expect(later.evidence.entries.map((row) => row.result.status)).toEqual(["fail", status]);
  });

  it.each(
    (
      [
        { evidence: "missing", expectedFailure: /without writing fresh producer QA evidence/u },
        { evidence: "empty", expectedFailure: /without reporting an executed producer check/u },
        { evidence: "malformed", expectedFailure: /invalid JSON/u },
        { evidence: "outside", expectedFailure: /inside its scenario output directory/u },
      ] as const
    ).map(({ evidence, expectedFailure }) => ({
      evidence,
      expectedFailure,
      evidenceMode: evidence === "empty" ? ("slim" as const) : ("full" as const),
    })),
  )(
    "retains $evidence producer failure alongside passing evidence in $evidenceMode mode",
    async ({ evidence, evidenceMode, expectedFailure }) => {
      const repoRoot = await makeTempRepo(`qa-script-${evidence}-producer-evidence-`);
      const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script");

      const result = await runQaTestFileScenarios({
        repoRoot,
        outputDir,
        ...QA_TEST_RUNNER_DEFAULTS,
        evidenceMode,
        scenarios: [
          makeTestFileScenario("script", "scripts/evidence-producer.ts"),
          {
            ...makeTestFileScenario("script", "scripts/healthy-evidence-producer.ts"),
            id: "healthy-scenario",
          },
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
            await fs.writeFile(
              attemptEvidencePath,
              JSON.stringify({
                kind: "openclaw.qa.evidence-summary",
                schemaVersion: 2,
                generatedAt: new Date().toISOString(),
                evidenceMode: "full",
                entries: [],
              }),
              "utf8",
            );
          } else if (evidence === "malformed") {
            await fs.writeFile(attemptEvidencePath, "{not valid JSON", "utf8");
          } else if (evidence === "outside") {
            await writeScriptProducerEvidence({
              outputDir: attemptOutputDir,
              scenarioId: "different-script-scenario",
              status: "pass",
            });
            await fs.writeFile(
              attemptRunPath,
              JSON.stringify({
                qaEvidence: path.join(
                  attemptOutputDir,
                  "different-script-scenario",
                  "run-1",
                  "qa-evidence.json",
                ),
              }),
              "utf8",
            );
          }
          return { exitCode: 0, stdout: "script exited successfully\n", stderr: "" };
        },
      });

      expect(result.results[0]).toMatchObject({ status: "fail" });
      expect(result.results[0]?.failureMessage).toMatch(expectedFailure);
      expect(result.results[1]).toMatchObject({ status: "pass" });
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
    const producerStatus = "pass";

    const commandName = path.basename(resolveQaScriptRuntimeExecutable());
    const tempRoot = await makeTempRepo("qa-script-terminal-exit-pass-");
    const outputDir = path.join(tempRoot, "out");
    const scriptPath = path.join(tempRoot, "terminal-evidence-producer.mjs");
    const producerEvidence = buildScriptProducerEvidence({
      additionalEntries: buildScriptProducerEvidence({
        producerId: "producer-diagnostic",
        status: "pass",
      }).entries,
      artifacts: [{ kind: "log", path: "producer.log" }],
      producerId: "scenario-script",
      status: producerStatus,
    });
    const result = await runQaTestFileScenarios({
      repoRoot: process.cwd(),
      outputDir,
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [makeTestFileScenario("script", scriptPath)],
      commandTimeoutMs: 1_000,
      runCommand: async (command) => {
        const attemptOutputDir = resolveScriptAttemptOutputDir(command);
        const artifactBase = path.join(attemptOutputDir, "scenario-script");
        expect(command.args).toEqual([
          "--import",
          "tsx",
          scriptPath,
          "--once",
          "--artifact-base",
          artifactBase,
        ]);
        expect(command.timeoutMs).toBe(1_000);

        const runRoot = path.join(artifactBase, "run-1");
        await fs.mkdir(runRoot, { recursive: true });
        await fs.writeFile(path.join(runRoot, "producer.log"), "producer evidence\n", "utf8");
        await fs.writeFile(
          path.join(runRoot, "qa-evidence.json"),
          JSON.stringify(producerEvidence),
          "utf8",
        );
        await fs.writeFile(
          path.join(artifactBase, "latest-run.json"),
          JSON.stringify({ qaEvidence: "run-1/qa-evidence.json" }),
          "utf8",
        );

        return {
          exitCode: 7,
          signal: null,
          stdout: "",
          stderr: "",
        };
      },
    });

    expect(result.results[0]).toMatchObject({
      failureMessage: `${commandName} exited with 7`,
      status: "fail",
    });
    expect(result.evidence.entries).toHaveLength(3);
    expect(
      result.evidence.entries.find((entry) => entry.test.id === "scenario-script"),
    ).toMatchObject({
      coverage: [],
      execution: {
        artifacts: [{ kind: "log", path: expect.stringContaining("producer.log") }],
        runner: "evidence-producer-script",
      },
      result: { status: producerStatus },
    });
    expect(
      result.evidence.entries.find((entry) => entry.test.id === "producer-diagnostic"),
    ).toMatchObject({ result: { status: "pass" } });
    expect(result.evidence.entries[2]).toMatchObject({
      test: { id: "scenario-script", kind: "script-test" },
      coverage: [],
      result: {
        failure: {
          reason: `${commandName} exited with 7`,
        },
        status: "fail",
      },
    });
  });

  it("carries the suite profile into merged producer evidence", async () => {
    const repoRoot = await makeTempRepo("qa-script-profile-");
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script-profile");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir,
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [makeTestFileScenario("script", "scripts/evidence-producer.ts")],
      runCommand: async (command) => {
        const attemptOutputDir = resolveScriptAttemptOutputDir(command);
        await writeScriptProducerEvidence({
          evidenceLocation: "scenario-root",
          latestRun: "none",
          outputDir: attemptOutputDir,
          profile: "smoke-ci",
          status: "pass",
        });
        return { exitCode: 0, stdout: "script pass\n", stderr: "" };
      },
      env: {
        OPENCLAW_QA_REF: "scenario-ref",
        OPENCLAW_QA_PROFILE: "smoke-ci",
      } as NodeJS.ProcessEnv,
    });

    expect(result.evidence.profile).toBe("smoke-ci");
  });
  it("imports coverage-free structured evidence through the real script lifecycle", async () => {
    const tempRoot = await harness.makeTempDir("qa-script-real-evidence-");
    const outputDir = path.join(tempRoot, "out");
    const scriptPath = path.join(tempRoot, "minimal-evidence-producer.mjs");
    const producerEvidence = buildScriptProducerEvidence({
      artifacts: [{ kind: "log", path: "artifact.log" }],
      coverage: [],
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
        "const runRoot = path.join(artifactBase, 'run-1');",
        "await fs.mkdir(runRoot, { recursive: true });",
        "await fs.writeFile(path.join(runRoot, 'artifact.log'), 'structured evidence\\n', 'utf8');",
        `const evidence = ${JSON.stringify(producerEvidence)};`,
        "await fs.writeFile(path.join(runRoot, 'qa-evidence.json'), JSON.stringify(evidence), 'utf8');",
        "await fs.writeFile(path.join(artifactBase, 'latest-run.json'), JSON.stringify({ qaEvidence: 'run-1/qa-evidence.json' }), 'utf8');",
      ].join("\n"),
      "utf8",
    );
    const infrastructureFixture: QaSeedScenarioWithSource = {
      id: "scenario-script",
      title: "Temporary script evidence fixture",
      surface: "qa-lab",
      objective: "Exercise structured evidence import through the real script lifecycle.",
      successCriteria: ["The runner imports coverage-free producer evidence and artifacts."],
      codeRefs: ["external/qa/minimal-evidence-producer.mjs"],
      sourcePath: "external/qa/minimal-evidence-scenario.yaml",
      execution: {
        kind: "script",
        path: scriptPath,
        args: ["--artifact-base", "${outputDir}"],
      },
    };

    const result = await runQaTestFileScenarios({
      repoRoot: process.cwd(),
      outputDir,
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [infrastructureFixture],
      commandTimeoutMs: 20_000,
      env: { OPENCLAW_QA_REF: "temporary-script-fixture" } as NodeJS.ProcessEnv,
    });

    expect(result.executionKind).toBe("script");
    expect(result.results[0]).toMatchObject({
      status: "pass",
      producerEvidence: {
        entries: [{ test: { id: "script-producer.web-ui.smoke" } }],
      },
    });
    expect(result.evidence.entries[0]).toMatchObject({
      coverage: [],
      execution: {
        artifacts: [
          {
            kind: "log",
            path: path.join(
              path.dirname(result.results[0]!.logPath),
              "scenario-script",
              "run-1",
              "artifact.log",
            ),
          },
        ],
      },
      test: { id: "script-producer.web-ui.smoke" },
    });
  });
});
