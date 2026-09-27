import fs from "node:fs/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  projectQaEvidenceScenarioOutcomes,
  validateQaEvidenceSummaryJson,
} from "./evidence-summary.js";
import {
  prepareQaTransportAdapterFactories,
  type QaTransportAdapterFactory,
} from "./qa-transport-registry.js";
import { expandQaScenarioExecutionCells } from "./scenario-lane.js";
import { runQaSuite } from "./suite-launch.runtime.js";
import { runQaFlowSuiteFromRuntime } from "./suite-run.runtime.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuitePublishedArtifacts } from "./suite-types.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";
import { makeTestFileScenario } from "./test-file-scenario-runner.test-support.js";

const tempDirs = createTempDirHarness();
afterEach(() => tempDirs.cleanup());

async function readPublished(artifacts: QaSuitePublishedArtifacts, count: number) {
  const evidence = validateQaEvidenceSummaryJson(
    JSON.parse(await fs.readFile(artifacts.evidencePath, "utf8")),
  );
  expect(projectQaEvidenceScenarioOutcomes(evidence).map(({ status }) => status)).toEqual(
    Array(count).fill("fail"),
  );
  expect(evidence.entries.every((entry) => entry.coverage.length === 0)).toBe(true);
  expect(JSON.parse(await fs.readFile(artifacts.summaryPath, "utf8"))).toMatchObject({
    run: { status: "completed" },
    counts: { total: count, failed: count },
  });
  expect(await fs.readFile(artifacts.reportPath, "utf8")).toBe(artifacts.report);
}

describe("QA suite evidence admission", () => {
  it.each(["standard", "isolated", "parity"] as const)(
    "publishes pre-aborted %s diagnostics without preparing or starting resources",
    async (mode) => {
      const repoRoot = await tempDirs.makeTempDir("qa-suite-admission-");
      const scenarios = [
        makeQaSuiteTestScenario("one", { channel: "slack" }),
        makeQaSuiteTestScenario("two", { channel: "slack" }),
      ];
      const reason = new Error("accepted run stopped during planning");
      const published = vi.fn<(artifacts: QaSuitePublishedArtifacts) => void>();
      const started = vi.fn();
      const startLab = vi.fn();
      const prepare = vi.fn();
      const create = vi.fn();
      await expect(
        runQaFlowSuiteFromRuntime({
          repoRoot,
          outputDir: "out",
          scenarioDefinitions: scenarios,
          scenarioIds: scenarios.map(({ id }) => id),
          providerMode: "mock-openai",
          channelDriver: "live",
          channelId: "slack",
          adapterFactories: [
            { id: "held", matches: () => true, prepareSelectedScenarios: prepare, create },
          ],
          startLab,
          signal: AbortSignal.abort(reason),
          concurrency: mode === "isolated" ? 2 : 1,
          ...(mode === "parity"
            ? { runtimePair: ["openclaw", "codex"] as ["openclaw", "codex"] }
            : {}),
          onScenarioStarted: started,
          onArtifactsPublished: published,
        }),
      ).rejects.toBe(reason);
      expect(prepare).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(startLab).not.toHaveBeenCalled();
      expect(started).not.toHaveBeenCalled();
      expect(published).toHaveBeenCalledOnce();
      await readPublished(published.mock.calls[0]![0], scenarios.length);
    },
  );

  it("publishes every queued mixed instance without starting flow, native or script work", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-mixed-admission-");
    const scenarios = [
      makeQaSuiteTestScenario("one"),
      makeTestFileScenario("vitest", "test/never.test.ts"),
      makeTestFileScenario("script", "scripts/never.ts"),
    ];
    const startLab = vi.fn();
    const started = vi.fn();
    const published = vi.fn<(artifacts: QaSuitePublishedArtifacts) => void>();
    const result = await runQaSuite({
      repoRoot,
      outputDir: "out",
      scenarioDefinitions: scenarios,
      scenarioIds: scenarios.map(({ id }) => id),
      providerMode: "mock-openai",
      startLab,
      signal: AbortSignal.abort(new Error("stop before scheduling")),
      onScenarioStarted: started,
      onArtifactsPublished: published,
    });
    expect(result.executionKind).toBe("suite");
    expect(result.observedCells).toEqual([]);
    expect(startLab).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(published).toHaveBeenCalledOnce();
    await readPublished(published.mock.calls[0]![0], scenarios.length);
  });

  it("joins a held preparation after its sibling rejects and preserves the original failure", async () => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const reason = new Error("first preparation failed");
    const factories: QaTransportAdapterFactory[] = ["slack", "telegram"].map((channel) => ({
      id: channel,
      matches: ({ channelId }) => channelId === channel,
      create: vi.fn(),
      prepareSelectedScenarios: async () => {
        if (channel === "slack") {
          throw reason;
        }
        entered.resolve();
        await release.promise;
      },
    }));
    const pending = prepareQaTransportAdapterFactories({
      factories,
      driver: "live",
      cells: expandQaScenarioExecutionCells({
        scenarios: factories.map(({ id }) => makeQaSuiteTestScenario(id, { channel: id })),
        channelDriver: "live",
        expandChannels: true,
      }),
    });
    const settled = vi.fn();
    void pending.then(settled, settled);
    try {
      await entered.promise;
      expect(settled).not.toHaveBeenCalled();
      release.resolve();
      await expect(pending).rejects.toBe(reason);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  });

  it.each([false, true])(
    "joins cancelled preparation and retains its actual failure (reject=%s)",
    async (reject) => {
      const repoRoot = await tempDirs.makeTempDir("qa-preparation-admission-");
      const scenario = makeQaSuiteTestScenario("held", { channel: "slack" });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const controller = new AbortController();
      const cancellation = new Error("stop during preparation");
      const failure = new Error("transport preparation failed");
      const published = vi.fn<(artifacts: QaSuitePublishedArtifacts) => void>();
      const startLab = vi.fn();
      const create = vi.fn();
      const pending = runQaFlowSuiteFromRuntime({
        repoRoot,
        outputDir: "out",
        scenarioDefinitions: [scenario],
        scenarioIds: [scenario.id],
        providerMode: "mock-openai",
        channelDriver: "live",
        channelId: "slack",
        startLab,
        signal: controller.signal,
        onArtifactsPublished: published,
        adapterFactories: [
          {
            id: "held",
            matches: () => true,
            create,
            prepareSelectedScenarios: async () => {
              entered.resolve();
              await release.promise;
              if (reject) {
                throw failure;
              }
            },
          },
        ],
      });
      const settled = vi.fn();
      void pending.then(settled, settled);
      try {
        await entered.promise;
        controller.abort(cancellation);
        expect(settled).not.toHaveBeenCalled();
        expect(published).not.toHaveBeenCalled();
        release.resolve();
        await expect(pending).rejects.toBe(reject ? failure : cancellation);
        expect(startLab).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(published).toHaveBeenCalledOnce();
        const artifacts = published.mock.calls[0]![0];
        await readPublished(artifacts, 1);
        expect(artifacts.report).toContain(reject ? failure.message : "suite cancelled");
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
      }
    },
  );
});
