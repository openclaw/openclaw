import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { QaTransportAdapterFactory } from "./qa-transport-registry.js";
import { runQaSuite } from "./suite-launch.runtime.js";
import { runQaFlowSuiteFromRuntime } from "./suite-run.runtime.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { makeTempDir, cleanup } = createTempDirHarness();
afterEach(cleanup);
const startupError = "selected provider lane reached lab startup";
const failStartup = (message = startupError) =>
  vi.fn(async () => {
    throw new Error(message);
  });
it("adopts the required provider before starting a directly selected Matrix flow", async () => {
  const adapter: QaTransportAdapterFactory = {
    id: "matrix",
    supportsModuleFlows: true,
    matches: ({ driver, channelId }) => driver === "live" && channelId === "matrix",
    create: failStartup("Matrix adapter creation must remain unreachable"),
  };
  await expect(
    runQaFlowSuiteFromRuntime({
      repoRoot: await makeTempDir("qa-suite-provider-lane-"),
      scenarioIds: ["matrix-room-block-streaming"],
      channelDriver: "live",
      channelId: "matrix",
      adapterFactories: [adapter],
      startLab: failStartup(),
    }),
  ).rejects.toThrow(startupError);
});

it("selects the required provider and invalidates artifacts before replacement startup fails", async () => {
  const repoRoot = await makeTempDir("qa-suite-generation-");
  const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "replacement");
  const artifactPaths = ["qa-suite-summary.json", "qa-evidence.json", "qa-suite-report.md"].map(
    (name) => path.join(outputDir, name),
  );
  await mkdir(outputDir, { recursive: true });
  await Promise.all(artifactPaths.map((artifactPath) => writeFile(artifactPath, "stale\n")));

  await expect(
    runQaFlowSuiteFromRuntime({
      repoRoot,
      outputDir,
      scenarioIds: ["subagent-completion-direct-fallback"],
      concurrency: 1,
      startLab: failStartup("replacement startup failed"),
    }),
  ).rejects.toThrow("replacement startup failed");
  for (const artifactPath of artifactPaths) {
    await expect(access(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it.each([
  [undefined, 1, startupError],
  ["mock-openai", 0, "providerMode=live-frontier"],
] as const)("resolves required provider with override %s", async (providerMode, calls, details) => {
  const startLab = failStartup();
  const result = await runQaSuite({
    repoRoot: await makeTempDir("qa-suite-unified-provider-"),
    providerMode,
    scenarioIds: ["long-context-progress-watchdog"],
    startLab,
  });
  expect(result).toMatchObject({
    executionKind: "suite",
    result: { scenarios: [{ status: "fail", details: expect.stringContaining(details) }] },
  });
  expect(startLab).toHaveBeenCalledTimes(calls);
  if (providerMode === undefined) {
    const { run } = JSON.parse(await readFile(result.result.summaryPath, "utf8")) as {
      run: { providerMode: string; primaryModel: string; alternateModel: string };
    };
    expect(run).toMatchObject({
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-terra",
    });
  }
});
