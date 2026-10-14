// Register shared mocks before loading the real suite modules.
import "./suite-run-isolated.test-mocks.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  projectQaEvidenceScenarioOutcomes,
  type QaEvidenceSummaryV3Json,
} from "./evidence-summary.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import type { QaTransportAdapterFactory } from "./qa-transport-registry.js";
import * as scenarioCatalog from "./scenario-catalog.js";
import { createQaSuiteEvidenceInvocation } from "./suite-evidence.js";
import { runQaFlowSuiteIsolated } from "./suite-run-isolated.js";
import {
  createCleanupTestLab,
  createCleanupTestContext,
  mocks,
  tempDirs,
} from "./suite-run-isolated.test-support.js";
import { runQaFlowSuiteStandard } from "./suite-run-standard.js";
import { runQaFlowSuiteFromRuntime } from "./suite-run.runtime.js";
import { makeQaSuiteTestScenario, recordQaSuiteTestResults } from "./suite-test-helpers.js";
import type { QaSuiteRunner, QaSuiteScenarioRunner, QaSuiteScenarioResult } from "./suite-types.js";
import * as suite from "./suite.js";

describe("isolated QA suite transport cleanup", () => {
  it("retains the child's pass when it returns no scenario result", async () => {
    const lab = createCleanupTestLab();
    const context = createCleanupTestContext();
    context.selectedScenarios[0]!.assertions = [
      { id: "child-result", meaning: "the child owns its result", coverage: [] },
    ];
    const snapshots: QaEvidenceSummaryV3Json[] = [];
    const runChild = vi.fn<QaSuiteRunner>().mockImplementation(async (params) => {
      const child = await createQaSuiteEvidenceInvocation(params, {
        ...context,
        outputDir: params!.outputDir!,
      });
      const id = child.invocation.begin(0);
      await child.record(0, id, { name: "child passed", status: "pass", steps: [] });
      return {
        outputDir: params!.outputDir!,
        evidence: child.snapshot(),
        evidencePath: "unused",
        reportPath: "unused",
        summaryPath: "unused",
        report: "",
        scenarios: [],
        startedScenarioIds: [context.selectedScenarios[0]!.id],
        watchUrl: lab.baseUrl,
      };
    });
    const result = await runQaFlowSuiteIsolated(
      { lab, startLab: async () => lab, onEvidence: (summary) => snapshots.push(summary) },
      context,
      runChild,
    );
    expect(result.scenarios[0]?.status).toBe("fail");
    const final = snapshots.at(-1)!;
    expect(final.entries.map((entry) => entry.result.status)).toEqual(["pass", "fail"]);
    expect(final.entries[1]?.coverage).toEqual([]);
    const childId = final.entries[0]!.binding.occurrenceId;
    for (const occurrence of final.occurrences) {
      expect(occurrence.assertions).toEqual(
        occurrence.id === childId ? context.selectedScenarios[0]!.assertions : null,
      );
    }
    expect(projectQaEvidenceScenarioOutcomes(final)[0]).toMatchObject({
      status: "fail",
      occurrenceId: result.scenarios[0]!.evidenceOccurrenceId,
    });
    const childReceipt = final.occurrences
      .flatMap((occurrence) => occurrence.receipts)
      .find((receipt) => receipt.artifact.path.startsWith("scenarios/"));
    expect(childReceipt?.artifact.path).toContain(
      `scenarios/${final.occurrences[0]!.id}/artifacts/occurrences/`,
    );
  });

  it("records a failed pass-progress publication as a parent failure", async () => {
    const lab = createCleanupTestLab();
    const context = createCleanupTestContext();
    context.selectedScenarios[0]!.assertions = [
      { id: "child-result", meaning: "the child owns its result", coverage: [] },
    ];
    const snapshots: QaEvidenceSummaryV3Json[] = [];
    const publicationError = new Error("progress publication rejected");
    vi.mocked(lab.setScenarioRun).mockImplementation((next) => {
      if (next?.scenarios[0]?.status === "pass") {
        throw publicationError;
      }
    });
    const runChild = vi.fn<QaSuiteRunner>().mockImplementation(async (params) => ({
      outputDir: "/qa-child",
      evidencePath: "/qa-child/qa-evidence.json",
      reportPath: "/qa-child/qa-suite-report.md",
      summaryPath: "/qa-child/qa-suite-summary.json",
      report: "",
      ...recordQaSuiteTestResults(
        params,
        [makeQaSuiteTestScenario("leased-channel-scenario")],
        [{ name: "worker result", status: "pass", steps: [] }],
      ),
      startedScenarioIds: ["leased-channel-scenario"],
      watchUrl: lab.baseUrl,
    }));
    const run = runQaFlowSuiteIsolated(
      { lab, startLab: async () => lab, onEvidence: (summary) => snapshots.push(summary) },
      context,
      runChild,
    );
    await expect(run).resolves.toMatchObject({
      scenarios: [{ status: "fail", details: publicationError.message }],
    });
    expect(snapshots.at(-1)!.occurrences.every((item) => item.assertions === null)).toBe(true);
    expect(runChild).toHaveBeenCalledOnce();
    expect(mocks.disposeRegisteredAgentHarnesses).toHaveBeenCalledOnce();
  });

  it.each(["caught write failure", "queue rejection"] as const)(
    "drains siblings and queued artifacts after publication failure (%s)",
    async (partialOutcome) => {
      const lab = createCleanupTestLab();
      const context = createCleanupTestContext();
      context.channelDriver = undefined;
      context.progressEnabled = true;
      context.concurrency = 3;
      context.selectedScenarios = ["completed", "failing", "inflight"].map((id) =>
        makeQaSuiteTestScenario(id),
      );
      const publicationError = new Error("evidence publication failed");
      const writeError = new Error("partial artifact write failed");
      const queueError = new Error("partial progress publication failed");
      const partialStarted = createDeferred<void>();
      const partialWrite = createDeferred<void>();
      const failWorker = createDeferred<void>();
      const failureSeen = createDeferred<void>();
      const sibling = createDeferred<void>();
      const siblingRecorded = createDeferred<void>();
      const allStarted = createDeferred<void>();
      const order: string[] = [];
      let latest: QaEvidenceSummaryV3Json | undefined;
      let publicationFailed = false;
      const createTransport = suite.createQaSuiteTransportAdapter;
      vi.spyOn(suite, "createQaSuiteTransportAdapter").mockImplementation(async (params) => {
        const transport = await createTransport(params);
        return {
          ...transport,
          cleanupWithoutGateway: async () => {
            order.push("transport cleanup");
            await transport.cleanupWithoutGateway();
          },
        };
      });
      const artifacts = {
        evidencePath: "/qa-output/qa-evidence.json",
        report: "",
        reportPath: "/qa-output/qa-suite-report.md",
        summaryPath: "/qa-output/qa-suite-summary.json",
      };
      mocks.writeQaSuiteArtifacts.mockImplementationOnce(async () => {
        partialStarted.resolve();
        await partialWrite.promise;
        order.push("partial write settled");
        throw writeError;
      });
      let progressFailureReported = false;
      const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        if (
          partialOutcome === "queue rejection" &&
          !progressFailureReported &&
          String(chunk).includes(writeError.message)
        ) {
          progressFailureReported = true;
          throw queueError;
        }
        return true;
      });
      mocks.disposeRegisteredAgentHarnesses.mockImplementationOnce(async () => {
        order.push("harness cleanup");
      });
      vi.mocked(lab.stop).mockImplementation(async () => {
        order.push("lab cleanup");
      });
      const runChild = vi.fn<QaSuiteRunner>().mockImplementation(async (params) => {
        const id = params!.scenarioIds![0]!;
        if (runChild.mock.calls.length === 3) {
          allStarted.resolve();
        }
        if (id === "failing") {
          await failWorker.promise;
        }
        if (id === "inflight") {
          await sibling.promise;
          order.push("sibling settled");
        }
        return {
          ...artifacts,
          outputDir: params!.outputDir!,
          ...recordQaSuiteTestResults(
            params,
            [makeQaSuiteTestScenario(id)],
            [{ name: id, status: "pass", steps: [] }],
          ),
          startedScenarioIds: [id],
          watchUrl: lab.baseUrl,
        };
      });
      let settled = false;
      const run = runQaFlowSuiteIsolated(
        {
          startLab: async () => lab,
          workerStartStaggerMs: 0,
          onEvidence: (summary) => {
            latest = structuredClone(summary);
            if (
              !publicationFailed &&
              summary.entries.some((entry) => entry.test.id === "failing")
            ) {
              publicationFailed = true;
              failureSeen.resolve();
              throw publicationError;
            }
            if (summary.entries.some((entry) => entry.test.id === "inflight")) {
              siblingRecorded.resolve();
            }
          },
        },
        context,
        runChild,
      ).catch((error: unknown) => {
        settled = true;
        return error;
      });
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        await allStarted.promise;
        await partialStarted.promise;
        const firstReceipt = latest!.occurrences.flatMap((entry) => entry.receipts)[0]!;
        const artifactPath = path.join(context.outputDir, firstReceipt.artifact.path);
        const originalBytes = await fs.readFile(artifactPath);
        failWorker.resolve();
        await failureSeen.promise;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(settled).toBe(false);
        expect(mocks.disposeRegisteredAgentHarnesses).not.toHaveBeenCalled();
        expect(lab.stop).not.toHaveBeenCalled();
        if (partialOutcome === "queue rejection") {
          // Reject while the sibling still runs, before finally can await the queue.
          partialWrite.resolve();
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(order).toEqual(["partial write settled"]);
          expect(settled).toBe(false);
          expect(mocks.disposeRegisteredAgentHarnesses).not.toHaveBeenCalled();
          expect(lab.stop).not.toHaveBeenCalled();
          expect(unhandled).not.toHaveBeenCalled();
        }
        sibling.resolve();
        await siblingRecorded.promise;
        if (partialOutcome !== "queue rejection") {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(settled).toBe(false);
          expect(mocks.disposeRegisteredAgentHarnesses).not.toHaveBeenCalled();
          expect(lab.stop).not.toHaveBeenCalled();
          partialWrite.resolve();
        }
        const error = await run;
        if (partialOutcome === "queue rejection") {
          expect(error).toBeInstanceOf(AggregateError);
          expect((error as AggregateError).errors).toEqual([publicationError, queueError]);
          expect((error as AggregateError).cause).toBe(publicationError);
          expect((error as Error).message).toContain("partial artifacts");
        } else {
          expect(error).toBe(publicationError);
        }
        expect(stderrWrite.mock.calls.flat().join("")).toContain(writeError.message);
        expect(order).toEqual([
          ...(partialOutcome === "queue rejection"
            ? ["partial write settled", "sibling settled"]
            : ["sibling settled", "partial write settled"]),
          "transport cleanup",
          "harness cleanup",
          "lab cleanup",
        ]);
        expect(mocks.writeQaSuiteArtifacts).toHaveBeenCalledTimes(
          partialOutcome === "queue rejection" ? 1 : 2,
        );
        expect(latest!.entries.map((entry) => entry.result.status)).toEqual([
          "pass",
          "pass",
          "pass",
        ]);
        expect(new Set(latest!.entries.map((entry) => entry.binding.occurrenceId)).size).toBe(3);
        expect(projectQaEvidenceScenarioOutcomes(latest!).map(({ status }) => status)).toEqual([
          "pass",
          "pass",
          "pass",
        ]);
        expect(await fs.readFile(artifactPath)).toEqual(originalBytes);
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    },
  );

  it("keeps out-of-order progress times while draining partial artifacts before cleanup", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const at = (second: number) => new Date(Date.UTC(2026, 7, 4, 0, 0, second));
    vi.setSystemTime(at(0));
    const lab = createCleanupTestLab();
    const context = createCleanupTestContext();
    context.concurrency = 2;
    context.selectedScenarios = ["first", "second"].map((id) => {
      const scenario = makeQaSuiteTestScenario(id);
      scenario.title = `Catalog ${id}`;
      return scenario;
    });
    const snapshots: Parameters<QaLabServerHandle["setScenarioRun"]>[0][] = [];
    const completed = [createDeferred<void>(), createDeferred<void>()];
    vi.mocked(lab.setScenarioRun).mockImplementation((next) => {
      snapshots.push(structuredClone(next));
      next?.scenarios.forEach((scenario, index) => {
        if (scenario.status === "pass") {
          completed[index]!.resolve();
        }
      });
    });
    const workers = [
      createDeferred<Awaited<ReturnType<QaSuiteRunner>>>(),
      createDeferred<Awaited<ReturnType<QaSuiteRunner>>>(),
    ];
    const allStarted = createDeferred<void>();
    const runChild = vi.fn<QaSuiteRunner>().mockImplementation(() => {
      if (runChild.mock.calls.length === 2) {
        allStarted.resolve();
      }
      return workers[runChild.mock.calls.length - 1]!.promise;
    });
    const partialWrite = createDeferred<void>();
    const artifacts = {
      evidencePath: "/qa-output/qa-evidence.json",
      report: "",
      reportPath: "/qa-output/qa-suite-report.md",
      summaryPath: "/qa-output/qa-suite-summary.json",
    };
    mocks.writeQaSuiteArtifacts.mockImplementationOnce(async (params) => {
      await partialWrite.promise;
      return { ...artifacts, evidence: params.recordedEvidence };
    });
    mocks.disposeRegisteredAgentHarnesses.mockImplementationOnce(async () => {
      expect(mocks.writeQaSuiteArtifacts).toHaveBeenCalledTimes(2);
      expect(snapshots.at(-1)?.status).toBe("running");
      vi.setSystemTime(at(10));
    });
    const results: QaSuiteScenarioResult[] = [
      { name: "result first", status: "pass", steps: [] },
      {
        name: "result second",
        status: "pass",
        details: "",
        steps: [{ name: "check", status: "pass" }],
      },
    ];
    const run = runQaFlowSuiteIsolated(
      { lab, startLab: async () => lab, workerStartStaggerMs: 0 },
      context,
      runChild,
    );
    await allStarted.promise;
    for (const index of [1, 0]) {
      vi.setSystemTime(at(2 - index));
      workers[index]!.resolve({
        ...artifacts,
        outputDir: "/qa-child",
        ...recordQaSuiteTestResults(
          runChild.mock.calls[index]![0],
          [context.selectedScenarios[index]!],
          [results[index]!],
        ),
        startedScenarioIds: [context.selectedScenarios[index]!.id],
        watchUrl: lab.baseUrl,
      });
      await completed[index]!.promise;
    }
    expect(mocks.writeQaSuiteArtifacts).toHaveBeenCalledOnce();
    expect(mocks.disposeRegisteredAgentHarnesses).not.toHaveBeenCalled();
    partialWrite.resolve();
    const result = await run;

    const recordedResults = results.map((scenarioResult) => ({
      ...scenarioResult,
      evidenceOccurrenceId: expect.any(String),
    }));
    expect(result.scenarios).toEqual(recordedResults);
    expect(
      snapshots.map((snapshot) => snapshot?.scenarios.map((scenario) => scenario.status)),
    ).toEqual([
      ["pending", "pending"],
      ["running", "pending"],
      ["running", "running"],
      ["running", "pass"],
      ["pass", "pass"],
      ["pass", "pass"],
    ]);
    expect(snapshots.at(-1)).toStrictEqual({
      kind: "suite",
      status: "completed",
      startedAt: at(0).toISOString(),
      finishedAt: at(10).toISOString(),
      scenarios: context.selectedScenarios.map((scenario, index) => ({
        id: scenario.id,
        name: scenario.title,
        status: "pass",
        details: results[index]!.details,
        steps: results[index]!.steps,
        startedAt: at(0).toISOString(),
        finishedAt: at(2 - index).toISOString(),
      })),
    });
    expect(
      mocks.writeQaSuiteArtifacts.mock.calls.map(([params]) => [params.status, params.scenarios]),
    ).toEqual([
      ["running", [recordedResults[1]]],
      ["running", recordedResults],
      [undefined, recordedResults],
    ]);
    expect(mocks.disposeRegisteredAgentHarnesses.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.writeQaSuiteArtifacts.mock.invocationCallOrder[2]!,
    );
    expect(vi.mocked(lab.setLatestReport).mock.invocationCallOrder.at(-1)!).toBeLessThan(
      vi.mocked(lab.setScenarioRun).mock.invocationCallOrder.at(-1)!,
    );
  });

  it("records a rejected dispatched worker and leaves the fail-fast tail unstarted", async () => {
    const lab = createCleanupTestLab();
    const context = createCleanupTestContext();
    context.progressEnabled = true;
    context.selectedScenarios.push(makeQaSuiteTestScenario("never-started"));
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runChild = vi
      .fn<QaSuiteRunner>()
      .mockRejectedValueOnce(new Error("isolated worker gateway failed"));

    let result: Awaited<ReturnType<typeof runQaFlowSuiteIsolated>>;
    try {
      result = await runQaFlowSuiteIsolated(
        { failFast: true, lab, startLab: async () => lab },
        context,
        runChild,
      );
      expect(stderrWrite.mock.calls.flat().join("")).toContain(
        "scenario fail (1/2): leased-channel-scenario — isolated scenario worker: isolated worker gateway failed",
      );
    } finally {
      stderrWrite.mockRestore();
    }

    expect(runChild).toHaveBeenCalledOnce();
    expect(result.startedScenarioIds).toEqual(["leased-channel-scenario"]);
    expect(result.scenarios).toEqual([
      expect.objectContaining({
        name: "leased-channel-scenario",
        status: "fail",
        details: "isolated worker gateway failed",
      }),
    ]);
    expect(lab.setScenarioRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "completed",
        scenarios: [
          expect.objectContaining({ id: "leased-channel-scenario", status: "fail" }),
          expect.objectContaining({ id: "never-started", status: "pending" }),
        ],
      }),
    );
    expect(mocks.writeQaSuiteArtifacts).toHaveBeenLastCalledWith(
      expect.objectContaining({ scenarios: result.scenarios }),
    );
  });

  it("leaves only running progress when parent cleanup fails after worker completion", async () => {
    const lab = createCleanupTestLab();
    const release = vi.fn(async () => {});
    const factory: QaTransportAdapterFactory = {
      id: "leased",
      matches: ({ channelId, driver }) => channelId === "leased" && driver === "live",
      async create() {
        return {
          id: "leased",
          label: "Leased channel",
          accountId: "sut",
          requiredPluginIds: [],
          supportedActions: [],
          sendInbound: async (input) => lab.state.addInboundMessage(input),
          createGatewayConfig: () => ({}),
          async waitReady() {},
          buildAgentDelivery: ({ target }) => ({
            channel: "leased",
            to: target,
            replyChannel: "leased",
            replyTo: target,
          }),
          async handleAction() {},
          createReportNotes: () => [],
          cleanup: release,
        };
      },
    };
    const cleanupError = new Error("agent harness disposal failed");
    mocks.disposeRegisteredAgentHarnesses.mockRejectedValueOnce(cleanupError);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runChild = vi.fn<QaSuiteRunner>().mockImplementation(async (params) => ({
      outputDir: "/qa-child",
      evidencePath: "/qa-child/qa-evidence.json",
      reportPath: "/qa-child/qa-suite-report.md",
      summaryPath: "/qa-child/qa-suite-summary.json",
      report: "",
      ...recordQaSuiteTestResults(
        params,
        [makeQaSuiteTestScenario("leased-channel-scenario")],
        [{ name: "leased-channel-scenario", status: "pass", steps: [] }],
      ),
      startedScenarioIds: ["leased-channel-scenario"],
      watchUrl: lab.baseUrl,
    }));
    const context = createCleanupTestContext();
    context.progressEnabled = true;

    const thrown = await runQaFlowSuiteIsolated(
      {
        adapterFactories: [factory],
        channelDriver: "live",
        channelId: "leased",
        startLab: async () => lab,
      },
      context,
      runChild,
    ).catch((error: unknown) => error);

    expect(release).toHaveBeenCalledOnce();
    expect(mocks.disposeRegisteredAgentHarnesses).toHaveBeenCalledOnce();
    expect(lab.stop).toHaveBeenCalledOnce();
    expect(lab.setLatestReport).toHaveBeenCalledWith(
      expect.objectContaining({ outputPath: "/qa-output/qa-suite-report.md" }),
    );
    expect(mocks.writeQaSuiteArtifacts).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: "running" }),
    );
    expect(mocks.writeQaSuiteArtifacts).toHaveBeenCalledTimes(1);
    expect(mocks.writeQaSuiteArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ status: "running", writeEvidenceFile: false }),
    );
    expect(lab.setScenarioRun).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
    expect((thrown as Error).message.split("\n")[0]).toBe(
      "QA scenarios passed, but cleanup failed",
    );
    expect((thrown as Error).message).toContain(
      "failed cleanup phases: agent harnesses: agent harness disposal failed",
    );
    expect((thrown as Error).cause).toBe(cleanupError);
    expect(stderrWrite.mock.calls.flat().join("")).not.toContain("run complete");
    stderrWrite.mockRestore();
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
        return { name: scenario.title, status: "pass", steps: [] };
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
      const scenarioId = params.scenarioIds?.[0] ?? "missing-scenario";
      if (scenarioId === "second-crabline-scenario") {
        await firstScenarioStarted;
      }
      try {
        return await runQaFlowSuiteFromRuntime(params);
      } finally {
        activeWorkers -= 1;
      }
    });

    try {
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
      expect(mocks.captureTransportArtifacts).toHaveBeenCalledOnce();
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
      for (const [nonFinalArtifacts] of mocks.writeQaSuiteArtifacts.mock.calls.slice(0, -1)) {
        expect(nonFinalArtifacts.transportArtifacts).toBeUndefined();
      }
    } finally {
      stderrWrite.mockRestore();
    }
  });
});

describe("isolated QA suite nested publication", () => {
  it("retains a failed parent history when the continued isolated child is skipped", async () => {
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
      evidenceMode: "slim" as const,
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
    nextStatus = "skip";
    const continued = await runQaFlowSuiteIsolated(
      {
        ...params,
        evidenceAnchors: original.occurrences.filter((item) => item.scenario?.kind === "instance"),
        evidenceContinuation: original,
      },
      context,
      runChild,
    );
    if (continued.evidence?.schemaVersion !== 3) {
      throw new Error("expected continued invocation evidence");
    }
    expect(runScenario).toHaveBeenCalledTimes(2);
    expect(continued.scenarios[0]?.status).toBe("fail");
    expect(projectQaEvidenceScenarioOutcomes(continued.evidence)[0]?.status).toBe("fail");
    expect(continued.scenarios[0]).toEqual(first.scenarios[0]);
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
  });

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
        ...recordQaSuiteTestResults(
          params,
          [makeQaSuiteTestScenario("same")],
          [{ name: "same", status: calls === 1 ? "fail" : "pass", steps: [] }],
        ),
        startedScenarioIds: ["same"],
        watchUrl: lab.baseUrl,
      };
    });
    const result = await runQaFlowSuiteIsolated(
      { lab, startLab: async () => createCleanupTestLab() },
      context,
      runChild,
    );
    expect(new Set(runChild.mock.calls.map(([params]) => params?.outputDir)).size).toBe(2);
    expect(result.startedScenarioIds).toEqual(["same", "same"]);
    expect(result.scenarios.map((item) => item.status)).toEqual(["fail", "pass"]);
    expect(
      vi
        .mocked(lab.setScenarioRun)
        .mock.calls.at(-1)?.[0]
        ?.scenarios.map((item) => item.status),
    ).toEqual(["fail", "pass"]);
  });

  it("prints bounded and redacted nested failure progress before artifacts", async () => {
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
    const scenarioStatus = "fail";
    const secret = "synthetic-secret-".repeat(60);
    const details = `verification refused\napiKey="${secret}"\r::error::fixture\n${"🦞".repeat(400)}`;
    const scenarioResult = {
      name: "leased-channel-scenario",
      status: scenarioStatus,
      details: "unrelated scenario metadata",
      steps: [{ name: "Verify\nrequest", status: "fail", details }],
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
        expect(line).toContain("Verify request: verification refused");
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
    mocks.writeQaSuiteArtifacts.mockImplementationOnce(async (params) => {
      assertScenarioProgress(1);
      return {
        evidence: params.recordedEvidence,
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
  });
});
