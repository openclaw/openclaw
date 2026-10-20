// QA Lab suite selection keeps scenario requirements on their declared provider lane.
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QaTransportAdapterFactory } from "./qa-transport-registry.js";
import { runQaSuite } from "./suite-launch.runtime.js";
import { runQaFlowSuiteFromRuntime } from "./suite-run.runtime.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { makeTempDir, cleanup } = createTempDirHarness();
afterEach(cleanup);
const failStartup = () =>
  vi.fn(async () => {
    throw new Error("selected provider lane reached lab startup");
  });
function expectScenarioFailure(result: Awaited<ReturnType<typeof runQaSuite>>, details: string) {
  expect(result.executionKind).toBe("suite");
  expect(result.result.scenarios).toEqual([
    expect.objectContaining({ status: "fail", details: expect.stringContaining(details) }),
  ]);
}

describe("qa suite provider selection", () => {
  it.each([
    {
      scenarioId: "matrix-room-block-streaming",
      channelDriver: "live" as const,
      channelId: "matrix",
      adapterFactories: [
        {
          id: "matrix",
          supportsModuleFlows: true,
          matches: ({ driver, channelId }) => driver === "live" && channelId === "matrix",
          create: async () => {
            throw new Error("Matrix adapter creation must remain unreachable");
          },
        } satisfies QaTransportAdapterFactory,
      ],
    },
    { scenarioId: "subagent-completion-direct-fallback", adapterFactories: undefined },
  ])("adopts the provider requirement for directly selected $scenarioId", async (selection) => {
    const repoRoot = await makeTempDir("qa-suite-provider-lane-");
    const startLab = failStartup();
    await expect(
      runQaFlowSuiteFromRuntime({
        repoRoot,
        scenarioIds: [selection.scenarioId],
        ...("channelDriver" in selection
          ? { channelDriver: selection.channelDriver, channelId: selection.channelId }
          : {}),
        adapterFactories: selection.adapterFactories,
        startLab,
      }),
    ).rejects.toThrow("selected provider lane reached lab startup");
    expect(startLab).toHaveBeenCalledOnce();
  });

  it("invalidates prior terminal artifacts before replacement startup fails", async () => {
    const repoRoot = await makeTempDir("qa-suite-generation-");
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "replacement");
    const artifactPaths = [
      path.join(outputDir, "qa-suite-summary.json"),
      path.join(outputDir, "qa-evidence.json"),
      path.join(outputDir, "qa-suite-report.md"),
    ];
    await mkdir(outputDir, { recursive: true });
    await Promise.all(artifactPaths.map((artifactPath) => writeFile(artifactPath, "stale\n")));

    await expect(
      runQaFlowSuiteFromRuntime({
        repoRoot,
        outputDir,
        scenarioIds: ["goal-context-next-turn"],
        concurrency: 1,
        startLab: async () => {
          throw new Error("replacement startup failed");
        },
      }),
    ).rejects.toThrow("replacement startup failed");
    for (const artifactPath of artifactPaths) {
      await expect(access(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("adopts a single runtime-partitioned flow scenario's required provider", async () => {
    const repoRoot = await makeTempDir("qa-suite-unified-provider-");
    const startLab = failStartup();
    const result = await runQaSuite({
      repoRoot,
      scenarioIds: ["long-context-progress-watchdog"],
      startLab,
    });

    expectScenarioFailure(result, "selected provider lane reached lab startup");
    expect(startLab).toHaveBeenCalledOnce();
    const summary = JSON.parse(await readFile(result.result.summaryPath, "utf8")) as {
      run: { providerMode: string; primaryModel: string; alternateModel: string };
    };
    expect(summary.run).toMatchObject({
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-terra",
    });
    expect(summary.run.primaryModel).not.toBe(summary.run.alternateModel);
  });

  it("keeps an explicit unified provider override ahead of a scenario requirement", async () => {
    const repoRoot = await makeTempDir("qa-suite-unified-override-");
    const startLab = vi.fn();

    const result = await runQaSuite({
      repoRoot,
      providerMode: "mock-openai",
      scenarioIds: ["long-context-progress-watchdog"],
      startLab,
    });

    expectScenarioFailure(result, "providerMode=live-frontier");
    expect(startLab).not.toHaveBeenCalled();
  });
});
