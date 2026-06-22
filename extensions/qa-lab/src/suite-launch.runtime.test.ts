import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runQaFlowSuite, runQaTestFileScenarios } = vi.hoisted(() => ({
  runQaFlowSuite: vi.fn(),
  runQaTestFileScenarios: vi.fn(),
}));

vi.mock("./suite.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./suite.js")>()),
  runQaFlowSuite,
}));

vi.mock("./test-file-scenario-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./test-file-scenario-runner.js")>()),
  runQaTestFileScenarios,
}));

import { runQaSuite } from "./suite-launch.runtime.js";

const tempRoots: string[] = [];

async function makeTempRepo(prefix: string) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(repoRoot);
  return repoRoot;
}

async function writeEvidence(pathLocal: string) {
  await fs.mkdir(path.dirname(pathLocal), { recursive: true });
  await fs.writeFile(
    pathLocal,
    `${JSON.stringify(
      {
        kind: "openclaw.qa.evidence-summary",
        schemaVersion: 2,
        generatedAt: "2026-06-14T00:00:00.000Z",
        evidenceMode: "full",
        entries: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("qa suite runtime launcher", () => {
  beforeEach(() => {
    runQaFlowSuite.mockReset();
    runQaTestFileScenarios.mockReset();
    runQaFlowSuite.mockImplementation(async (params: { outputDir?: string } | undefined) => {
      const outputDir = params?.outputDir ?? "/tmp/qa-flow";
      const evidencePath = path.join(outputDir, "qa-evidence.json");
      await writeEvidence(evidencePath);
      return {
        outputDir,
        evidencePath,
        reportPath: path.join(outputDir, "qa-suite-report.md"),
        summaryPath: path.join(outputDir, "qa-suite-summary.json"),
        report: "# QA Suite Report\n",
        scenarios: [
          {
            name: "channel-chat-baseline",
            status: "pass",
            steps: [],
          },
        ],
        watchUrl: "http://127.0.0.1:43124",
      };
    });
    runQaTestFileScenarios.mockImplementation(
      async (params: {
        outputDir: string;
        scenarios: Array<{ id: string; execution: { kind: "script" | "vitest" | "playwright" } }>;
      }) => {
        const [scenario] = params.scenarios;
        if (!scenario) {
          throw new Error("expected scenario");
        }
        const evidencePath = path.join(params.outputDir, "qa-evidence.json");
        await writeEvidence(evidencePath);
        return {
          outputDir: params.outputDir,
          executionKind: scenario.execution.kind,
          evidencePath,
          results: params.scenarios.map((scenarioItem) => ({
            durationMs: 1,
            logPath: path.join(params.outputDir, `${scenarioItem.id}.log`),
            scenario: scenarioItem,
            status: "pass",
          })),
        };
      },
    );
  });

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("routes selected flow scenarios to the flow suite engine", async () => {
    const result = await runQaSuite({
      repoRoot: process.cwd(),
      providerMode: "mock-openai",
      scenarioIds: ["channel-chat-baseline"],
    });

    expect(result).toMatchObject({
      executionKind: "flow",
      result: {
        summaryPath: "/tmp/qa-flow/qa-suite-summary.json",
      },
    });
    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(runQaFlowSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: process.cwd(),
        providerMode: "mock-openai",
        scenarioIds: ["channel-chat-baseline"],
      }),
    );
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
  });

  it("routes selected Playwright scenarios to the Playwright scenario runner", async () => {
    const repoRoot = await makeTempRepo("qa-suite-launch-");
    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/scenario-test",
      scenarioIds: ["control-ui-chat-flow-playwright"],
    });

    expect(result).toMatchObject({
      executionKind: "suite",
      result: {
        evidencePath: path.join(
          repoRoot,
          ".artifacts",
          "qa-e2e",
          "scenario-test",
          "qa-evidence.json",
        ),
        summaryPath: path.join(
          repoRoot,
          ".artifacts",
          "qa-e2e",
          "scenario-test",
          "qa-suite-summary.json",
        ),
      },
    });
    expect(runQaFlowSuite).not.toHaveBeenCalled();
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
    const [call] = runQaTestFileScenarios.mock.calls[0] ?? [];
    expect(call).toMatchObject({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-test", "playwright"),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
    });
    expect(
      call.scenarios.map((scenario: { id: string; execution: { kind: string } }) => ({
        id: scenario.id,
        kind: scenario.execution.kind,
      })),
    ).toEqual([{ id: "control-ui-chat-flow-playwright", kind: "playwright" }]);
  });

  it("runs mixed flow and Vitest/Playwright scenarios as one suite", async () => {
    const repoRoot = await makeTempRepo("qa-suite-mixed-");
    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/mixed",
      scenarioIds: ["channel-chat-baseline", "control-ui-chat-flow-playwright"],
    });

    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mixed");
    expect(result).toMatchObject({
      executionKind: "suite",
      result: {
        evidencePath: path.join(outputDir, "qa-evidence.json"),
        summaryPath: path.join(outputDir, "qa-suite-summary.json"),
      },
    });
    expect(runQaFlowSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow"),
        scenarioIds: ["channel-chat-baseline"],
      }),
    );
    expect(runQaTestFileScenarios).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDir: path.join(outputDir, "playwright"),
      }),
    );
    await expect(fs.access(path.join(outputDir, "qa-suite-summary.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(outputDir, "qa-evidence.json"))).resolves.toBeUndefined();
    const summary = JSON.parse(
      await fs.readFile(path.join(outputDir, "qa-suite-summary.json"), "utf8"),
    ) as {
      run?: { scenarioIds?: unknown };
      scenarios?: Array<{ details?: unknown; name?: unknown; status?: unknown }>;
    };
    expect(summary.run?.scenarioIds).toEqual([
      "channel-chat-baseline",
      "control-ui-chat-flow-playwright",
    ]);
    expect(summary.scenarios).toMatchObject([
      { name: "channel-chat-baseline", status: "pass" },
      { name: "Control UI chat flow Playwright coverage", status: "pass" },
    ]);
    expect(JSON.stringify(summary)).not.toContain(repoRoot);
    expect(summary.scenarios?.[1]?.details).toContain(
      "log=.artifacts/qa-e2e/mixed/playwright/control-ui-chat-flow-playwright.log",
    );
  });

  it("rejects runtime-pair requests for Vitest/Playwright scenarios", async () => {
    await expect(
      runQaSuite({
        repoRoot: process.cwd(),
        runtimePair: ["openclaw", "codex"],
        scenarioIds: ["control-ui-chat-flow-playwright"],
      }),
    ).rejects.toThrow("--runtime-pair requires execution.kind: flow scenarios");

    expect(runQaFlowSuite).not.toHaveBeenCalled();
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
  });

  it("rejects repo-local symlink output directories before running Vitest/Playwright scenarios", async () => {
    const repoRoot = await makeTempRepo("qa-suite-symlink-root-");
    const outsideRoot = await makeTempRepo("qa-suite-symlink-outside-");
    await fs.symlink(outsideRoot, path.join(repoRoot, "artifacts-link"));

    await expect(
      runQaSuite({
        repoRoot,
        outputDir: "artifacts-link/qa-out",
        scenarioIds: ["control-ui-chat-flow-playwright"],
      }),
    ).rejects.toThrow("QA suite outputDir must not traverse symlinks");

    expect(runQaFlowSuite).not.toHaveBeenCalled();
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
  });
});
