// Register shared mocks before loading the real suite modules.
import "./suite-run-isolated.test-mocks.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { projectQaEvidenceScenarioOutcomes } from "./evidence-summary.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import * as scenarioCatalog from "./scenario-catalog.js";
import { runQaFlowSuiteIsolated } from "./suite-run-isolated.js";
import {
  createCleanupTestLab,
  createCleanupTestContext,
  mocks,
  tempDirs,
} from "./suite-run-isolated.test-support.js";
import { runQaFlowSuiteStandard } from "./suite-run-standard.js";
import { runQaFlowSuiteFromRuntime } from "./suite-run.runtime.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteRunner, QaSuiteScenarioResult, QaSuiteScenarioRunner } from "./suite-types.js";
import * as suite from "./suite.js";

describe("isolated QA suite nested publication", () => {
  it.each(
    (["full", "slim"] as const).flatMap((evidenceMode) =>
      (["pass", "skip"] as const).map((status) => ({ evidenceMode, status })),
    ),
  )(
    "continues completed parent history through a real isolated $status child in $evidenceMode mode",
    async ({ evidenceMode, status }) => {
      const context = createCleanupTestContext();
      context.repoRoot = await tempDirs.makeTempDir("qa-isolated-continuation-");
      context.outputDir = path.join(context.repoRoot, "output");
      context.channelDriver = undefined;
      const scenario = context.selectedScenarios[0]!;
      if (scenario.execution.kind !== "flow") {
        throw new Error("expected flow scenario");
      }
      scenario.execution.retryCount = 0;
      scenario.assertions = [
        {
          id: "child-result",
          meaning: "the child owns this scenario assertion",
          coverage: [{ id: "qa.coverage", role: "primary" }],
        },
      ];
      mocks.writeQaSuiteArtifacts.mockImplementation(async (params) => ({
        evidence: params.recordedEvidence,
        evidencePath: path.join(params.outputDir, "qa-evidence.json"),
        summaryPath: path.join(params.outputDir, "qa-suite-summary.json"),
        reportPath: path.join(params.outputDir, "qa-suite-report.md"),
        report: "",
      }));
      let nextStatus: "pass" | "fail" | "skip" = "fail";
      const runScenario = vi.fn<QaSuiteScenarioRunner>().mockImplementation(async () => ({
        name: context.selectedScenarios[0]!.title,
        status: nextStatus,
        steps: [],
        details: nextStatus === "fail" ? "original child failure" : "later child result",
      }));
      const runChild: QaSuiteRunner = async (params) => {
        if (!params?.outputDir) {
          throw new Error("expected owned child output");
        }
        return runQaFlowSuiteStandard(
          params,
          { ...context, outputDir: params.outputDir },
          runScenario,
        );
      };
      const params = {
        evidenceMode,
        startLab: async () => createCleanupTestLab(),
      };
      const first = await runQaFlowSuiteIsolated(params, context, runChild);
      if (first.evidence?.schemaVersion !== 3) {
        throw new Error("expected invocation evidence");
      }
      const original = structuredClone(first.evidence);
      const observations = original.occurrences.filter(
        (item) => item.scenario?.kind === "observation",
      );
      expect(observations).toHaveLength(2);
      expect(observations.every((item) => item.terminalStatus === "fail")).toBe(true);
      for (const observation of observations) {
        const isChild = first.evidence.entries.some(
          (entry) => entry.binding.occurrenceId === observation.id,
        );
        expect(observation.assertions).toEqual(isChild ? scenario.assertions : null);
      }
      const artifacts = await Promise.all(
        observations.flatMap((item) =>
          item.receipts.map(async ({ artifact }) => ({
            artifact,
            bytes: await fs.readFile(path.resolve(context.outputDir, artifact.path)),
          })),
        ),
      );
      nextStatus = status;
      const continued = await runQaFlowSuiteIsolated(
        {
          ...params,
          evidenceAnchors: original.occurrences.filter(
            (item) => item.scenario?.kind === "instance",
          ),
          evidenceContinuation: original,
        },
        context,
        runChild,
      );
      if (continued.evidence?.schemaVersion !== 3) {
        throw new Error("expected continued invocation evidence");
      }
      expect(runScenario).toHaveBeenCalledTimes(2);
      expect(continued.scenarios[0]?.status).toBe(status === "pass" ? "pass" : "fail");
      expect(projectQaEvidenceScenarioOutcomes(continued.evidence)[0]?.status).toBe(
        status === "pass" ? "pass" : "fail",
      );
      if (status === "skip") {
        expect(continued.scenarios[0]).toEqual(first.scenarios[0]);
      }
      for (const occurrence of observations) {
        expect(continued.evidence.occurrences.find((item) => item.id === occurrence.id)).toEqual(
          occurrence,
        );
      }
      for (const { artifact, bytes } of artifacts) {
        expect(await fs.readFile(path.resolve(context.outputDir, artifact.path))).toEqual(bytes);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
      }
      expect(first.evidence).toEqual(original);
    },
  );

  it("preserves repeated isolated starts and independent progress slots", async () => {
    const lab = createCleanupTestLab();
    const context = createCleanupTestContext();
    context.repoRoot = await tempDirs.makeTempDir("qa-isolated-repeated-");
    context.outputDir = path.join(context.repoRoot, "output");
    context.concurrency = 1;
    context.selectedScenarios = [makeQaSuiteTestScenario("same"), makeQaSuiteTestScenario("same")];
    let calls = 0;
    const runChild = vi.fn<QaSuiteRunner>().mockImplementation(async (params) => {
      calls += 1;
      return {
        outputDir: params!.outputDir!,
        evidencePath: "",
        reportPath: "",
        summaryPath: "",
        report: "",
        scenarios: [{ name: "same", status: calls === 1 ? "fail" : "pass", steps: [] }],
        startedScenarioIds: ["same"],
        watchUrl: lab.baseUrl,
      };
    });
    const result = await runQaFlowSuiteIsolated(
      { lab, startLab: async () => createCleanupTestLab() },
      context,
      runChild,
    );
    expect(result.startedScenarioIds).toEqual(["same", "same"]);
    expect(result.scenarios.map((item) => item.status)).toEqual(["fail", "pass"]);
    expect(
      vi
        .mocked(lab.setScenarioRun)
        .mock.calls.at(-1)?.[0]
        ?.scenarios.map((item) => item.status),
    ).toEqual(["fail", "pass"]);
  });

  it("preserves nested publication ownership through concurrent worker runtime preparation", async () => {
    vi.stubEnv("OPENCLAW_QA_SUITE_PROGRESS", "1");
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const lab = createCleanupTestLab();
    const selection = {
      capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
      channel: "telegram",
      channelDriver: "crabline",
      providerReadinessArtifactPath: "crabline-provider-readiness.json",
    } as const;
    let activeWorkers = 0;
    let maxActiveWorkers = 0;
    let releaseWorkers!: () => void;
    const bothWorkersStarted = new Promise<void>((resolve) => {
      releaseWorkers = resolve;
    });
    let releaseFirstScenario!: () => void;
    const firstScenarioStarted = new Promise<void>((resolve) => {
      releaseFirstScenario = resolve;
    });
    let releaseScenarioExecutions!: () => void;
    const bothScenarioExecutionsStarted = new Promise<void>((resolve) => {
      releaseScenarioExecutions = resolve;
    });
    const context = createCleanupTestContext();
    context.repoRoot = await tempDirs.makeTempDir("qa-nested-workers-");
    context.outputDir = path.join(context.repoRoot, "output");
    context.channelDriver = "crabline";
    context.concurrency = 2;
    context.progressEnabled = true;
    context.selectedScenarios = [
      makeQaSuiteTestScenario("first-crabline-scenario"),
      makeQaSuiteTestScenario("second-crabline-scenario"),
    ];
    const runScenario = vi
      .fn<QaSuiteScenarioRunner>()
      .mockImplementation(async (_env, scenario) => {
        if (scenario.id === "first-crabline-scenario") {
          releaseFirstScenario();
          await bothScenarioExecutionsStarted;
        } else {
          releaseScenarioExecutions();
        }
        return {
          name: scenario.title,
          status: "pass",
          steps: [],
        };
      });
    vi.spyOn(scenarioCatalog, "readQaBootstrapScenarioCatalog").mockReturnValue({
      agentIdentityMarkdown: "test",
      kickoffTask: "test",
      scenarios: context.selectedScenarios,
    });
    vi.spyOn(suite, "runQaSuiteScenarioDefinitionForRuntime").mockImplementation(runScenario);
    const runChild = vi.fn<QaSuiteRunner>().mockImplementation(async (params) => {
      if (!params) {
        throw new Error("expected nested standard run params");
      }
      activeWorkers += 1;
      maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
      if (activeWorkers === 2) {
        releaseWorkers();
      }
      await bothWorkersStarted;
      const scenarioId = params?.scenarioIds?.[0] ?? "missing-scenario";
      if (scenarioId === "second-crabline-scenario") {
        await firstScenarioStarted;
      }
      try {
        return await runQaFlowSuiteFromRuntime(params);
      } finally {
        activeWorkers -= 1;
      }
    });

    const result = await runQaFlowSuiteIsolated(
      {
        channelDriverSelection: selection,
        channelId: "telegram",
        lab,
        startLab: async () => createCleanupTestLab(),
      },
      context,
      runChild,
    );

    expect(maxActiveWorkers).toBe(2);
    expect(result.scenarios).toEqual([
      expect.objectContaining({ name: "first-crabline-scenario", status: "pass" }),
      expect.objectContaining({ name: "second-crabline-scenario", status: "pass" }),
    ]);
    expect(runScenario).toHaveBeenCalledTimes(2);
    expect(
      stderrWrite.mock.calls
        .flat()
        .join("")
        .split("\n")
        .filter((line) => line.startsWith("[qa-suite] run complete")),
    ).toEqual(["[qa-suite] run complete"]);
    expect(mocks.writeQaSuiteArtifacts).toHaveBeenCalledTimes(5);
    for (const [nonFinalArtifacts] of mocks.writeQaSuiteArtifacts.mock.calls.slice(0, -1)) {
      expect(nonFinalArtifacts).toMatchObject({ channel: "telegram", channelDriver: "crabline" });
      expect(nonFinalArtifacts.channelDriverSelection).toBeUndefined();
    }
    const finalArtifacts = mocks.writeQaSuiteArtifacts.mock.calls.at(-1)?.[0];
    expect(finalArtifacts).toMatchObject({
      channel: "telegram",
      channelDriver: "crabline",
      channelDriverSelection: selection,
    });
  });

  it.each(["pass", "skip", "failed step", "failure details"] as const)(
    "prints bounded failure progress before artifacts for a nested standard %s result",
    async (outcome) => {
      const parentLab = createCleanupTestLab();
      const childLab = createCleanupTestLab();
      const startLab = vi
        .fn<() => Promise<QaLabServerHandle>>()
        .mockResolvedValueOnce(parentLab)
        .mockResolvedValueOnce(childLab);
      const context = createCleanupTestContext();
      context.channelDriver = undefined;
      context.progressEnabled = true;
      const scenario = context.selectedScenarios[0]!;
      if (scenario.execution.kind === "flow") {
        scenario.execution.retryCount = 0;
      }
      const scenarioStatus = outcome === "pass" || outcome === "skip" ? outcome : "fail";
      const secret = "synthetic-secret-".repeat(60);
      const details = `verification refused\napiKey="${secret}"\r::error::fixture\n${"🦞".repeat(400)}`;
      const scenarioResult = {
        name: "leased-channel-scenario",
        status: scenarioStatus,
        details: outcome === "failed step" ? "unrelated scenario metadata" : details,
        steps:
          outcome === "failed step"
            ? [{ name: "Verify\nrequest", status: "fail" as const, details }]
            : [],
      } satisfies QaSuiteScenarioResult;
      const runScenario = vi.fn<QaSuiteScenarioRunner>().mockResolvedValue(scenarioResult);
      const runChild: QaSuiteRunner = async (childParams) => {
        if (!childParams) {
          throw new Error("expected nested standard run params");
        }
        return await runQaFlowSuiteStandard(
          childParams,
          {
            ...context,
            startedAt: new Date("2026-08-04T00:00:01.000Z"),
            outputDir: childParams.outputDir ?? "/qa-output/scenarios/leased-channel-scenario",
            concurrency: 1,
          },
          runScenario,
        );
      };
      const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const assertScenarioProgress = (expectedCount: number) => {
        const lines = stderrWrite.mock.calls
          .flat()
          .join("")
          .split("\n")
          .filter((line) => line.startsWith(`[qa-suite] scenario ${scenarioStatus} (`));
        expect(lines).toHaveLength(expectedCount);
        for (const line of lines) {
          const prefix = `[qa-suite] scenario ${scenarioStatus} (1/1): leased-channel-scenario`;
          if (scenarioStatus !== "fail") {
            expect(line).toBe(prefix);
            continue;
          }
          expect(line).toContain(
            outcome === "failed step"
              ? "Verify request: verification refused"
              : "verification refused",
          );
          expect(line).toContain("apiKey=<redacted>");
          expect(line).toContain(": :error::fixture");
          expect(line).not.toContain("synthetic-secret");
          expect(line).not.toContain("unrelated scenario metadata");
          expect(line).not.toMatch(/[\r\n]/u);
          expect(line.slice(prefix.length)).toMatch(/^ — /u);
          expect(line.slice(prefix.length + " — ".length).length).toBeLessThanOrEqual(512);
          expect(line.endsWith("…")).toBe(true);
          expect(Buffer.from(line).toString("utf8")).toBe(line);
        }
      };
      mocks.writeQaSuiteArtifacts.mockImplementationOnce(async () => {
        assertScenarioProgress(1);
        return {
          evidence: undefined,
          evidencePath: "/qa-output/qa-evidence.json",
          report: "",
          reportPath: "/qa-output/qa-suite-report.md",
          summaryPath: "/qa-output/qa-suite-summary.json",
        };
      });

      try {
        const result = await runQaFlowSuiteIsolated({ startLab }, context, runChild);
        assertScenarioProgress(2);
        expect(result.scenarios).toEqual([
          { ...scenarioResult, evidenceOccurrenceId: expect.any(String) },
        ]);

        const completionLines = stderrWrite.mock.calls
          .flat()
          .join("")
          .split("\n")
          .filter((line) => line.startsWith("[qa-suite] run complete"));
        expect(completionLines).toEqual(["[qa-suite] run complete"]);
        expect(runScenario).toHaveBeenCalledOnce();
        expect(childLab.stop).toHaveBeenCalledOnce();
        expect(parentLab.stop).toHaveBeenCalledOnce();
      } finally {
        stderrWrite.mockRestore();
      }
    },
  );
});
