import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
])(
  "adopts the provider requirement for directly selected $scenarioId",
  async ({ scenarioId, ...selection }) => {
    const repoRoot = await makeTempDir("qa-suite-provider-lane-");
    const startLab = failStartup();
    await expect(
      runQaFlowSuiteFromRuntime({
        repoRoot,
        scenarioIds: [scenarioId],
        ...selection,
        startLab,
      }),
    ).rejects.toThrow("selected provider lane reached lab startup");
    expect(startLab).toHaveBeenCalledOnce();
  },
);

it("invalidates prior terminal artifacts before replacement startup fails", async () => {
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

it.each([
  [undefined, 1, "selected provider lane reached lab startup"],
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
    expect(run.primaryModel).not.toBe(run.alternateModel);
  }
});
