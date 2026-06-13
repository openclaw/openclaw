import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runQaFlowSuite, runQaTestFileScenarios } = vi.hoisted(() => ({
  runQaFlowSuite: vi.fn(),
  runQaTestFileScenarios: vi.fn(),
}));

vi.mock("./suite.js", () => ({
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

describe("qa suite runtime launcher", () => {
  beforeEach(() => {
    runQaFlowSuite.mockReset();
    runQaTestFileScenarios.mockReset();
    runQaFlowSuite.mockResolvedValue({
      outputDir: "/tmp/qa-flow",
      evidencePath: "/tmp/qa-flow/qa-evidence.json",
      reportPath: "/tmp/qa-flow/qa-suite-report.md",
      summaryPath: "/tmp/qa-flow/qa-suite-summary.json",
      report: "# QA Suite Report\n",
      scenarios: [],
      watchUrl: "http://127.0.0.1:43124",
    });
    runQaTestFileScenarios.mockResolvedValue({
      outputDir: "/tmp/qa-test-file",
      executionKind: "playwright",
      reportPath: "/tmp/qa-test-file/qa-playwright-report.md",
      evidencePath: "/tmp/qa-test-file/qa-evidence.json",
      results: [{ status: "pass" }],
    });
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
      executionKind: "playwright",
      result: {
        evidencePath: "/tmp/qa-test-file/qa-evidence.json",
      },
    });
    expect(runQaFlowSuite).not.toHaveBeenCalled();
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
    const [call] = runQaTestFileScenarios.mock.calls[0] ?? [];
    expect(call).toMatchObject({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-test"),
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

  it("rejects mixed flow and Vitest/Playwright scenarios", async () => {
    await expect(
      runQaSuite({
        repoRoot: process.cwd(),
        scenarioIds: ["channel-chat-baseline", "control-ui-chat-flow-playwright"],
      }),
    ).rejects.toThrow("qa suite cannot mix execution.kind: flow with Vitest/Playwright scenarios");

    expect(runQaFlowSuite).not.toHaveBeenCalled();
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
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
