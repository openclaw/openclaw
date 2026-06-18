import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateQaEvidenceSummaryJson } from "./evidence-summary.js";
import { readQaScenarioById, type QaSeedScenarioWithSource } from "./scenario-catalog.js";
import {
  runQaTestFileScenarios,
  type QaScenarioCommandExecution,
} from "./test-file-scenario-runner.js";

const tempRoots: string[] = [];

function makeTestFileScenario(
  executionKind: "script" | "vitest" | "playwright",
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
      ...(executionKind === "script"
        ? { args: ["--once", "--artifact-base", "${outputDir}"] }
        : {}),
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

  it("runs script scenarios and imports producer QA evidence artifacts", async () => {
    const repoRoot = await makeTempRepo("qa-script-scenario-");
    const commands: QaScenarioCommandExecution[] = [];
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script"),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      scenarios: [makeTestFileScenario("script", "scripts/evidence-producer.ts")],
      runCommand: async (command) => {
        commands.push(command);
        const scenarioArtifactBase = path.join(
          repoRoot,
          ".artifacts",
          "qa-e2e",
          "scenario-script",
          "scenario-script",
        );
        const runRoot = path.join(scenarioArtifactBase, "run-1");
        await fs.mkdir(path.join(runRoot, "surfaces", "web-ui"), { recursive: true });
        await fs.writeFile(path.join(runRoot, "surfaces", "web-ui", "screenshot.png"), "png");
        await fs.writeFile(
          path.join(runRoot, "qa-evidence.json"),
          `${JSON.stringify(
            {
              kind: "openclaw.qa.evidence-summary",
              schemaVersion: 2,
              generatedAt: "2026-06-14T00:00:00.000Z",
              evidenceMode: "full",
              entries: [
                {
                  test: {
                    kind: "script-producer-check",
                    id: "script-producer.web-ui.smoke",
                    title: "Script producer: web-ui smoke",
                    source: { path: "scripts/evidence-producer.ts" },
                  },
                  coverage: [{ id: "ui.control", role: "primary" }],
                  execution: {
                    runner: "evidence-producer-script",
                    environment: {
                      ref: "scenario-ref",
                      os: "darwin",
                      nodeVersion: "v24.0.0",
                    },
                    provider: {
                      id: "script-producer",
                      live: false,
                      model: { name: null, ref: null },
                      fixture: "mocked-script-evidence",
                    },
                    packageSource: { kind: "source-checkout", sha: "abc123" },
                    artifacts: [
                      {
                        kind: "screenshot",
                        path: "surfaces/web-ui/screenshot.png",
                        source: "script-producer:web-ui:smoke",
                      },
                    ],
                  },
                  result: { status: "pass", timing: { wallMs: 1 } },
                },
              ],
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        await fs.writeFile(
          path.join(scenarioArtifactBase, "latest-run.json"),
          `${JSON.stringify({ qaEvidence: path.join(runRoot, "qa-evidence.json") }, null, 2)}\n`,
          "utf8",
        );
        return {
          exitCode: 0,
          stdout: "script pass\n",
          stderr: "",
        };
      },
      env: {
        OPENCLAW_QA_REF: "scenario-ref",
      } as NodeJS.ProcessEnv,
    });

    expect(result.executionKind).toBe("script");
    expect(commands.map((command) => command.args)).toEqual([
      [
        "--import",
        "tsx",
        "scripts/evidence-producer.ts",
        "--once",
        "--artifact-base",
        path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script", "scenario-script"),
      ],
    ]);
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0]).toMatchObject({
      test: {
        kind: "script-producer-check",
        id: "script-producer.web-ui.smoke",
      },
      coverage: [
        {
          id: "ui.control",
          role: "primary",
        },
      ],
      execution: {
        runner: "evidence-producer-script",
        artifacts: [
          {
            kind: "screenshot",
            path: ".artifacts/qa-e2e/scenario-script/scenario-script/run-1/surfaces/web-ui/screenshot.png",
            source: "script-producer:web-ui:smoke",
          },
        ],
      },
      result: {
        status: "pass",
      },
    });
  });

  it("imports producer QA evidence artifacts from failed script scenarios", async () => {
    const repoRoot = await makeTempRepo("qa-script-failed-scenario-");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script-failed"),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      scenarios: [makeTestFileScenario("script", "scripts/evidence-producer.ts")],
      runCommand: async () => {
        const scenarioArtifactBase = path.join(
          repoRoot,
          ".artifacts",
          "qa-e2e",
          "scenario-script-failed",
          "scenario-script",
        );
        const runRoot = path.join(scenarioArtifactBase, "run-1");
        await fs.mkdir(runRoot, { recursive: true });
        await fs.writeFile(
          path.join(runRoot, "qa-evidence.json"),
          `${JSON.stringify(
            {
              kind: "openclaw.qa.evidence-summary",
              schemaVersion: 2,
              generatedAt: "2026-06-14T00:00:00.000Z",
              evidenceMode: "full",
              entries: [
                {
                  test: {
                    kind: "script-producer-check",
                    id: "script-producer.web-ui.smoke",
                    title: "Script producer: web-ui smoke",
                    source: { path: "scripts/evidence-producer.ts" },
                  },
                  coverage: [{ id: "ui.control", role: "primary" }],
                  execution: {
                    runner: "evidence-producer-script",
                    environment: {
                      ref: "scenario-ref",
                      os: "darwin",
                      nodeVersion: "v24.0.0",
                    },
                    provider: {
                      id: "script-producer",
                      live: false,
                      model: { name: null, ref: null },
                      fixture: "failed-producer-evidence",
                    },
                    packageSource: { kind: "source-checkout", sha: "abc123" },
                    artifacts: [],
                  },
                  result: {
                    status: "fail",
                    failure: {
                      reason: "Script producer check failed.",
                    },
                    timing: { wallMs: 1 },
                  },
                },
              ],
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        await fs.writeFile(
          path.join(scenarioArtifactBase, "latest-run.json"),
          `${JSON.stringify({ qaEvidence: path.join(runRoot, "qa-evidence.json") }, null, 2)}\n`,
          "utf8",
        );
        return {
          exitCode: 1,
          stdout: "",
          stderr: "script failed\n",
        };
      },
      env: {
        OPENCLAW_QA_REF: "scenario-ref",
      } as NodeJS.ProcessEnv,
    });

    expect(result.results[0]).toMatchObject({
      status: "fail",
      failureMessage: "node exited with 1",
      producerEvidence: {
        entries: [
          {
            test: {
              id: "script-producer.web-ui.smoke",
            },
            result: {
              status: "fail",
            },
          },
        ],
      },
    });
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    expect(evidence.entries).toHaveLength(2);
    expect(evidence.entries[0]).toMatchObject({
      test: {
        kind: "script-producer-check",
        id: "script-producer.web-ui.smoke",
      },
      result: {
        status: "fail",
        failure: {
          reason: "Script producer check failed.",
        },
      },
    });
    expect(evidence.entries[1]).toMatchObject({
      test: {
        kind: "script-test",
        id: "scenario-script",
        source: {
          path: "scripts/evidence-producer.ts",
        },
      },
      result: {
        status: "fail",
        failure: {
          reason: "node exited with 1",
        },
      },
    });
  });

  it("fails script scenario results when imported producer evidence fails", async () => {
    const repoRoot = await makeTempRepo("qa-script-producer-fail-");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script-producer-fail"),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      scenarios: [makeTestFileScenario("script", "scripts/evidence-producer.ts")],
      runCommand: async () => {
        const scenarioArtifactBase = path.join(
          repoRoot,
          ".artifacts",
          "qa-e2e",
          "scenario-script-producer-fail",
          "scenario-script",
        );
        const runRoot = path.join(scenarioArtifactBase, "run-1");
        await fs.mkdir(runRoot, { recursive: true });
        await fs.writeFile(
          path.join(runRoot, "qa-evidence.json"),
          `${JSON.stringify(
            {
              kind: "openclaw.qa.evidence-summary",
              schemaVersion: 2,
              generatedAt: "2026-06-14T00:00:00.000Z",
              evidenceMode: "full",
              entries: [
                {
                  test: {
                    kind: "script-producer-check",
                    id: "script-producer.web-ui.smoke",
                    title: "Script producer: web-ui smoke",
                    source: { path: "scripts/evidence-producer.ts" },
                  },
                  coverage: [{ id: "ui.control", role: "primary" }],
                  execution: {
                    runner: "evidence-producer-script",
                    environment: {
                      ref: "scenario-ref",
                      os: "darwin",
                      nodeVersion: "v24.0.0",
                    },
                    provider: {
                      id: "script-producer",
                      live: false,
                      model: { name: null, ref: null },
                      fixture: "mocked-script-evidence",
                    },
                    packageSource: { kind: "source-checkout", sha: "abc123" },
                    artifacts: [],
                  },
                  result: {
                    status: "fail",
                    failure: {
                      reason: "Script producer check failed.",
                    },
                    timing: { wallMs: 1 },
                  },
                },
              ],
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        await fs.writeFile(
          path.join(scenarioArtifactBase, "latest-run.json"),
          `${JSON.stringify({ qaEvidence: path.join(runRoot, "qa-evidence.json") }, null, 2)}\n`,
          "utf8",
        );
        return {
          exitCode: 0,
          stdout: "script pass\n",
          stderr: "",
        };
      },
      env: {
        OPENCLAW_QA_REF: "scenario-ref",
      } as NodeJS.ProcessEnv,
    });

    expect(result.results[0]).toMatchObject({
      status: "fail",
      failureMessage: "Script producer check failed.",
    });
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0]).toMatchObject({
      test: {
        id: "script-producer.web-ui.smoke",
      },
      result: {
        status: "fail",
      },
    });
  });

  it("carries the suite profile into merged producer evidence", async () => {
    const repoRoot = await makeTempRepo("qa-script-profile-");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script-profile"),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      scenarios: [makeTestFileScenario("script", "scripts/evidence-producer.ts")],
      runCommand: async () => {
        const scenarioOutputDir = path.join(
          repoRoot,
          ".artifacts",
          "qa-e2e",
          "scenario-script-profile",
          "scenario-script",
        );
        await fs.mkdir(scenarioOutputDir, { recursive: true });
        await fs.writeFile(
          path.join(scenarioOutputDir, "qa-evidence.json"),
          `${JSON.stringify({
            kind: "openclaw.qa.evidence-summary",
            schemaVersion: 2,
            generatedAt: "2026-06-14T00:00:00.000Z",
            evidenceMode: "full",
            entries: [
              {
                test: {
                  kind: "script-producer-check",
                  id: "script-producer.web-ui.smoke",
                  title: "Script producer: web-ui smoke",
                  source: { path: "scripts/evidence-producer.ts" },
                },
                coverage: [{ id: "ui.control", role: "primary" }],
                result: { status: "pass", timing: { wallMs: 1 } },
              },
            ],
          })}\n`,
          "utf8",
        );
        return { exitCode: 0, stdout: "script pass\n", stderr: "" };
      },
      env: {
        OPENCLAW_QA_REF: "scenario-ref",
        OPENCLAW_QA_PROFILE: "smoke-ci",
      } as NodeJS.ProcessEnv,
    });

    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    expect(evidence.profile).toBe("smoke-ci");
  });

  it("keeps producer artifacts outside the repo root absolute instead of emitting ../ paths", async () => {
    const repoRoot = await makeTempRepo("qa-script-external-artifact-");
    const externalArtifact = path.join(os.tmpdir(), "qa-external-artifact.png");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script-external"),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      scenarios: [makeTestFileScenario("script", "scripts/evidence-producer.ts")],
      runCommand: async () => {
        const scenarioOutputDir = path.join(
          repoRoot,
          ".artifacts",
          "qa-e2e",
          "scenario-script-external",
          "scenario-script",
        );
        await fs.mkdir(scenarioOutputDir, { recursive: true });
        await fs.writeFile(
          path.join(scenarioOutputDir, "qa-evidence.json"),
          `${JSON.stringify({
            kind: "openclaw.qa.evidence-summary",
            schemaVersion: 2,
            generatedAt: "2026-06-14T00:00:00.000Z",
            evidenceMode: "full",
            entries: [
              {
                test: {
                  kind: "script-producer-check",
                  id: "script-producer.web-ui.smoke",
                  title: "Script producer: web-ui smoke",
                  source: { path: "scripts/evidence-producer.ts" },
                },
                coverage: [{ id: "ui.control", role: "primary" }],
                execution: {
                  runner: "evidence-producer-script",
                  environment: { ref: "scenario-ref", os: "darwin", nodeVersion: "v24.0.0" },
                  provider: {
                    id: "script-producer",
                    live: false,
                    model: { name: null, ref: null },
                    fixture: "mocked-script-evidence",
                  },
                  packageSource: { kind: "source-checkout", sha: "abc123" },
                  artifacts: [
                    {
                      kind: "screenshot",
                      path: externalArtifact,
                      source: "script-producer:web-ui:smoke",
                    },
                  ],
                },
                result: { status: "pass", timing: { wallMs: 1 } },
              },
            ],
          })}\n`,
          "utf8",
        );
        return { exitCode: 0, stdout: "script pass\n", stderr: "" };
      },
      env: { OPENCLAW_QA_REF: "scenario-ref" } as NodeJS.ProcessEnv,
    });

    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    const artifactPath = evidence.entries[0]?.execution?.artifacts[0]?.path;
    expect(artifactPath).toBe(path.normalize(externalArtifact));
    expect(artifactPath?.includes("..")).toBe(false);
  });

  it("runs the UX Matrix script producer and imports its evidence bundle", async () => {
    const repoRoot = process.cwd();
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-ux-matrix-script-"));
    tempRoots.push(outputDir);
    const scenario = readQaScenarioById("ux-matrix-evidence-dashboard");

    expect(scenario.execution.kind).toBe("script");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir,
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      scenarios: [scenario],
      env: {
        OPENCLAW_QA_REF: "scenario-ref",
      } as NodeJS.ProcessEnv,
    });

    expect(result.executionKind).toBe("script");
    expect(result.results[0]?.producerEvidence?.entries).toHaveLength(3);
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    expect(evidence.entries.map((entry) => entry.test.id)).toEqual([
      "ux-matrix.qa-lab.producer-artifact-fixture",
      "ux-matrix.control-ui.screenshot-artifact",
      "ux-matrix.cli.entrypoint-help",
    ]);
    expect(
      evidence.entries.flatMap((entry) => entry.coverage.map((coverage) => coverage.id)),
    ).toEqual(
      expect.arrayContaining([
        "qa.artifact-safety",
        "tools.evidence",
        "workspace.artifacts",
        "ui.control",
        "gateway.control-ui-hosting",
        "cli.entrypoint",
        "cli.status-snapshots",
      ]),
    );
    const artifactKinds = evidence.entries.flatMap(
      (entry) => entry.execution?.artifacts.map((artifact) => artifact.kind) ?? [],
    );
    expect(artifactKinds).toEqual(expect.arrayContaining(["html", "log"]));
    const fixtureEntry = evidence.entries.find(
      (entry) => entry.test.id === "ux-matrix.qa-lab.producer-artifact-fixture",
    );
    expect(fixtureEntry?.execution?.artifacts.map((artifact) => artifact.path)).toContain(
      path.join(
        outputDir,
        "ux-matrix-evidence-dashboard",
        "surfaces",
        "qa-lab",
        "stages",
        "producer-artifact-fixture",
        "producer-artifact-fixture.html",
      ),
    );
  });
});
