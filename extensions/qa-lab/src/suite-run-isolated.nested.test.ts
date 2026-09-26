// Register shared mocks before loading the real suite modules.
import "./suite-run-isolated.test-mocks.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { QaSuiteCleanupError } from "./errors.js";
import {
  projectQaEvidenceScenarioOutcomes,
  type QaEvidenceSummaryV3Json,
} from "./evidence-summary.js";
import * as gatewayChild from "./gateway-child.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import * as scenarioCatalog from "./scenario-catalog.js";
import { runQaSuiteWithInfraRetry } from "./suite-launch.runtime.js";
import { runQaFlowSuiteIsolated } from "./suite-run-isolated.js";
import {
  createCleanupTestLab,
  createCleanupTestContext,
  mocks,
  tempDirs,
} from "./suite-run-isolated.test-support.js";
import { runQaFlowSuiteStandard } from "./suite-run-standard.js";
import { runQaFlowSuiteFromRuntime } from "./suite-run.runtime.js";
import * as gatewayRuntime from "./suite-runtime-gateway.js";
import { readQaSuiteFailedScenarioCountFromFile } from "./suite-summary.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteRunner, QaSuiteScenarioResult, QaSuiteScenarioRunner } from "./suite-types.js";
import * as suite from "./suite.js";

describe("isolated QA suite nested publication", () => {
  it("publishes an unstarted standard schedule after readiness and unconfirmed cleanup fail", async () => {
    const context = createCleanupTestContext();
    context.channelDriver = undefined;
    context.selectedScenarios = [makeQaSuiteTestScenario("same"), makeQaSuiteTestScenario("same")];
    const lab = createCleanupTestLab();
    const readinessError = new Error("transport never became ready");
    const cleanupError = new Error("gateway process is still alive");
    const gateway = gatewayChild.createQaGatewayChild();
    const stop = vi.spyOn(gateway, "stop").mockResolvedValue({
      process: "unconfirmed",
      errors: [cleanupError],
    });
    vi.spyOn(gatewayChild, "createQaGatewayChild").mockReturnValueOnce(gateway);
    vi.mocked(gatewayRuntime.waitForTransportReady)
      .mockRejectedValueOnce(readinessError)
      .mockRejectedValueOnce(readinessError);
    const actual =
      await vi.importActual<typeof import("./suite-artifacts.js")>("./suite-artifacts.js");
    const publishing = createDeferred<void>();
    const release = createDeferred<void>();
    mocks.writeQaSuiteArtifacts.mockImplementationOnce(async (params) => {
      publishing.resolve();
      await release.promise;
      return actual.writeQaSuiteArtifacts(params);
    });
    const runScenario = vi.fn<QaSuiteScenarioRunner>();
    const started = vi.fn();
    const settled = vi.fn((error: unknown) => error);
    const run = runQaFlowSuiteStandard(
      { lab, onScenarioStarted: started },
      context,
      runScenario,
    ).catch(settled);
    try {
      await Promise.race([publishing.promise, run]);
      expect(mocks.writeQaSuiteArtifacts).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
      expect(mocks.disposeRegisteredAgentHarnesses).toHaveBeenCalledOnce();
      expect(settled).not.toHaveBeenCalled();
      expect(runScenario).not.toHaveBeenCalled();
      expect(started).not.toHaveBeenCalled();
      const written = mocks.writeQaSuiteArtifacts.mock.calls[0]![0];
      expect(written.scenarios.map(({ status }) => status)).toEqual(["fail", "fail"]);
      expect(
        projectQaEvidenceScenarioOutcomes(written.recordedEvidence!).map(({ status }) => status),
      ).toEqual(["fail", "fail"]);
      expect(
        new Set(written.scenarios.map(({ evidenceOccurrenceId }) => evidenceOccurrenceId)).size,
      ).toBe(2);
      expect(written.recordedEvidence!.entries.every(({ coverage }) => coverage.length === 0)).toBe(
        true,
      );
      release.resolve();
      const failure = await run;
      expect(failure).toBeInstanceOf(QaSuiteCleanupError);
      if (!(failure instanceof QaSuiteCleanupError)) {
        throw new Error("expected fatal cleanup", { cause: failure });
      }
      expect(failure.cause).toBe(readinessError);
      expect(failure.errors).toHaveLength(2);
      expect(failure.errors[0]).toBe(readinessError);
      const cleanup = failure.errors[1];
      expect(cleanup).toBeInstanceOf(QaSuiteCleanupError);
      if (!(cleanup instanceof QaSuiteCleanupError)) {
        throw new Error("expected gateway cleanup marker", { cause: cleanup });
      }
      expect(cleanup.errors).toHaveLength(1);
      expect(cleanup.errors[0]).toBe(cleanupError);
      expect(cleanup.cause).toBe(cleanupError);
      await expect(
        readQaSuiteFailedScenarioCountFromFile(
          path.join(context.outputDir, "qa-suite-summary.json"),
        ),
      ).resolves.toBe(2);
      expect(lab.setScenarioRun).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: "completed",
          scenarios: [
            expect.objectContaining({ id: "same", status: "fail" }),
            expect.objectContaining({ id: "same", status: "fail" }),
          ],
        }),
      );
      expect(vi.mocked(lab.setLatestReport).mock.invocationCallOrder[0]).toBeLessThan(
        settled.mock.invocationCallOrder[0]!,
      );
    } finally {
      release.resolve();
      await run;
    }
  });

  it("restores a standard continuation cancelled after retryable confirmed-resource cleanup", async () => {
    const context = createCleanupTestContext();
    context.channelDriver = undefined;
    context.selectedScenarios = [makeQaSuiteTestScenario("same"), makeQaSuiteTestScenario("same")];
    const lab = createCleanupTestLab();
    const controller = new AbortController();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const cleanupError = Object.assign(new Error("cleanup socket reset"), { code: "ECONNRESET" });
    mocks.disposeRegisteredAgentHarnesses.mockRejectedValueOnce(cleanupError);
    const startGateway = mocks.startQaGatewayChild.getMockImplementation()!;
    mocks.startQaGatewayChild.mockImplementation(async (params) => {
      if (mocks.startQaGatewayChild.mock.calls.length === 2) {
        entered.resolve();
        await release.promise;
      }
      return await startGateway(params);
    });
    const actual =
      await vi.importActual<typeof import("./suite-artifacts.js")>("./suite-artifacts.js");
    const defaultWrite = mocks.writeQaSuiteArtifacts.getMockImplementation()!;
    mocks.writeQaSuiteArtifacts.mockImplementation(actual.writeQaSuiteArtifacts);
    const runScenario = vi.fn<QaSuiteScenarioRunner>().mockResolvedValue({
      name: "same",
      status: "pass",
      details: "retained original",
      steps: [],
    });
    const started = vi.fn();
    const failures: unknown[] = [];
    let continuation: QaEvidenceSummaryV3Json | undefined;
    const run = runQaSuiteWithInfraRetry(
      () =>
        runQaFlowSuiteStandard(
          {
            lab,
            signal: controller.signal,
            evidenceAnchors: continuation?.occurrences.filter(
              ({ scenario }) => scenario?.kind === "instance",
            ),
            evidenceContinuation: continuation,
            onEvidence: (summary) => {
              continuation = structuredClone(summary);
            },
            onScenarioStarted: started,
          },
          context,
          runScenario,
        ),
      1,
      controller.signal,
      {
        onAttemptFailure: (error) => {
          failures.push(error);
        },
      },
    ).catch((error: unknown) => error);
    try {
      await entered.promise;
      expect(failures).toHaveLength(1);
      expect(failures[0]).toBeInstanceOf(AggregateError);
      expect(failures[0]).not.toBeInstanceOf(QaSuiteCleanupError);
      expect(failures[0]).toMatchObject({ cause: cleanupError, errors: [cleanupError] });
      const original = structuredClone(continuation!);
      const startedIds = original.occurrences
        .filter(({ scenario }) => scenario?.kind === "instance")
        .map(({ id }) => id);
      expect(started.mock.calls.flat()).toEqual(startedIds);
      expect(new Set(startedIds).size).toBe(2);
      const artifacts = await Promise.all(
        original.occurrences.flatMap(({ receipts }) =>
          receipts.map(async ({ artifact }) => ({
            path: path.resolve(context.outputDir, artifact.path),
            bytes: await fs.readFile(path.resolve(context.outputDir, artifact.path)),
          })),
        ),
      );
      const reason = new Error("stop during retry startup");
      controller.abort(reason);
      release.resolve();
      expect(await run).toBe(reason);
      expect(failures).toHaveLength(2);
      expect(failures[1]).toBe(reason);
      expect(runScenario).toHaveBeenCalledTimes(2);
      expect(mocks.startQaGatewayChild).toHaveBeenCalledTimes(2);
      expect(mocks.disposeRegisteredAgentHarnesses).toHaveBeenCalledTimes(2);
      expect(mocks.writeQaSuiteArtifacts).toHaveBeenCalledTimes(2);
      expect(started.mock.calls.flat()).toEqual(startedIds);
      const first = mocks.writeQaSuiteArtifacts.mock.calls[0]![0];
      const final = mocks.writeQaSuiteArtifacts.mock.calls[1]![0];
      expect(final.scenarios).toEqual(first.scenarios);
      expect(final.recordedEvidence?.entries).toEqual(original.entries);
      expect(final.recordedEvidence).toMatchObject({ occurrences: original.occurrences });
      await expect(
        readQaSuiteFailedScenarioCountFromFile(
          path.join(context.outputDir, "qa-suite-summary.json"),
        ),
      ).resolves.toBe(0);
      const terminal = vi.mocked(lab.setScenarioRun).mock.calls.at(-1)![0]!;
      expect(terminal.status).toBe("completed");
      expect(terminal.scenarios.map(({ status }) => status)).toEqual(["pass", "pass"]);
      for (const scenario of terminal.scenarios) {
        expect(scenario).not.toHaveProperty("startedAt");
      }
      for (const artifact of artifacts) {
        expect(await fs.readFile(artifact.path)).toEqual(artifact.bytes);
      }
    } finally {
      release.resolve();
      await run;
      mocks.startQaGatewayChild.mockReset().mockImplementation(startGateway);
      mocks.writeQaSuiteArtifacts.mockReset().mockImplementation(defaultWrite);
      mocks.disposeRegisteredAgentHarnesses.mockReset().mockResolvedValue(undefined);
    }
  });

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
        channelDriver: "crabline",
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
      expect(nonFinalArtifacts.transportArtifacts).toBeUndefined();
    }
    const finalArtifacts = mocks.writeQaSuiteArtifacts.mock.calls.at(-1)?.[0];
    expect(finalArtifacts).toMatchObject({
      channel: "telegram",
      channelDriver: "crabline",
      transportArtifacts: {
        artifacts: [
          { kind: "channel-capability-matrix", path: "capabilities.json" },
          { kind: "channel-driver-smoke", path: "readiness.json" },
        ],
      },
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
