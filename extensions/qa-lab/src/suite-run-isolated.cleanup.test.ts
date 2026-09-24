// Register shared mocks before loading the real suite modules.
import "./suite-run-isolated.test-mocks.js";
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { QaSuiteArtifactError, QaSuiteCleanupError } from "./errors.js";
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
import { runQaFlowSuiteFromRuntime } from "./suite-run.runtime.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteRunner, QaSuiteScenarioRunner, QaSuiteScenarioResult } from "./suite-types.js";
import * as suite from "./suite.js";

describe("isolated QA suite transport cleanup", () => {
  it("retains the ordinary child error when required failure evidence cannot be published", async () => {
    const lab = createCleanupTestLab();
    const context = createCleanupTestContext();
    const original = new Error("ordinary child failure");
    const runChild = vi.fn<QaSuiteRunner>().mockImplementation(async () => {
      const artifactDir = path.join(context.outputDir, "artifacts");
      await fs.mkdir(artifactDir, { recursive: true });
      await fs.writeFile(path.join(artifactDir, "occurrences"), "blocked evidence directory");
      throw original;
    });
    const failure = await runQaFlowSuiteIsolated(
      { lab, startLab: async () => lab },
      context,
      runChild,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QaSuiteCleanupError);
    expect(failure).toMatchObject({
      errors: [original, expect.objectContaining({ code: "publication_failed" })],
      cause: expect.objectContaining({ code: "publication_failed" }),
    });
    if (!(failure instanceof QaSuiteCleanupError)) {
      throw new Error("expected terminal evidence reconciliation failure", { cause: failure });
    }
    expect(failure.errors[0]).toBe(original);
    expect(failure.cause).toBe(failure.errors[1]);
    expect(runChild).toHaveBeenCalledOnce();
    expect(mocks.writeQaSuiteArtifacts).not.toHaveBeenCalled();
    expect(lab.setScenarioRun).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("withholds terminal artifacts when a child reports canonical cleanup failure", async () => {
    const lab = createCleanupTestLab();
    const context = createCleanupTestContext();
    const run = runQaFlowSuiteIsolated({ lab, startLab: async () => lab }, context, async () => {
      suite.throwQaSuiteCleanupErrors({
        cleanupFailures: [{ phase: "gateway stop", error: new Error("still running") }],
        runFailed: false,
        runError: undefined,
      });
      throw new Error("expected cleanup failure");
    });
    await expect(run).rejects.toThrow("still running");
    expect(mocks.writeQaSuiteArtifacts).not.toHaveBeenCalled();
    expect(lab.setLatestReport).not.toHaveBeenCalled();
    expect(mocks.disposeRegisteredAgentHarnesses).toHaveBeenCalledOnce();
  });

  it.each(
    ["cleanup", "publication"].flatMap((kind) =>
      [false, true].map((reconciliationFails) => ({ kind, reconciliationFails })),
    ),
  )(
    "retains captured child evidence before terminal $kind failure (reconciliation fails=$reconciliationFails)",
    async ({ kind, reconciliationFails }) => {
      const lab = createCleanupTestLab();
      const context = createCleanupTestContext();
      context.selectedScenarios[0]!.assertions = [
        { id: "child-result", meaning: "the child owns its result", coverage: [] },
      ];
      const cause = new Error("child finalization failed");
      const original =
        kind === "cleanup"
          ? new QaSuiteCleanupError([cause], cause.message, { cause })
          : new QaSuiteArtifactError("publication_failed", cause.message, { cause });
      const reconciliationError = new Error("parent evidence callback failed");
      const snapshots: QaEvidenceSummaryV3Json[] = [];
      const runChild = vi.fn<QaSuiteRunner>().mockImplementation(async (params) => {
        const child = await createQaSuiteEvidenceInvocation(params, {
          ...context,
          outputDir: params!.outputDir!,
        });
        const id = child.invocation.begin(0);
        await child.record(0, id, { name: "child passed", status: "pass", steps: [] });
        throw original;
      });
      const error = await runQaFlowSuiteIsolated(
        {
          lab,
          startLab: async () => lab,
          onEvidence: (summary) => {
            snapshots.push(summary);
            if (
              reconciliationFails &&
              summary.entries.some((entry) => entry.result.failure?.reason === original.message)
            ) {
              throw reconciliationError;
            }
          },
        },
        context,
        runChild,
      ).catch((failure: unknown) => failure);
      if (reconciliationFails) {
        expect(error).toBeInstanceOf(QaSuiteCleanupError);
        expect(error).toMatchObject({ cause: original, errors: [original, reconciliationError] });
      } else {
        expect(error).toBe(original);
      }
      const final = snapshots.at(-1)!;
      expect(final.entries.map((entry) => entry.result.status)).toEqual(["pass", "fail"]);
      expect(final.entries[1]!.coverage).toEqual([]);
      const childId = final.entries[0]!.binding.occurrenceId;
      expect(final.occurrences.find((item) => item.id === childId)?.assertions).toEqual(
        context.selectedScenarios[0]!.assertions,
      );
      expect(runChild).toHaveBeenCalledOnce();
      expect(mocks.writeQaSuiteArtifacts).not.toHaveBeenCalled();
      expect(lab.setScenarioRun).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: "completed" }),
      );
      expect(mocks.disposeRegisteredAgentHarnesses).toHaveBeenCalledOnce();
    },
  );

  it("retains the original pre-result error after the child's initial snapshot", async () => {
    const lab = createCleanupTestLab();
    const context = createCleanupTestContext();
    context.selectedScenarios[0]!.assertions = [
      { id: "child-result", meaning: "the child owns its result", coverage: [] },
    ];
    const original = new Error("child failed before its first result");
    const snapshots: QaEvidenceSummaryV3Json[] = [];
    const result = await runQaFlowSuiteIsolated(
      { lab, startLab: async () => lab, onEvidence: (summary) => snapshots.push(summary) },
      context,
      async (params) => {
        await createQaSuiteEvidenceInvocation(params, {
          ...context,
          outputDir: params!.outputDir!,
        });
        throw original;
      },
    );
    expect(result.scenarios[0]).toMatchObject({ status: "fail", details: original.message });
    expect(snapshots.at(-1)!.entries).toMatchObject([
      {
        coverage: [],
        result: { status: "fail", failure: { reason: original.message } },
      },
    ]);
    expect(projectQaEvidenceScenarioOutcomes(snapshots.at(-1)!)[0]).toMatchObject({
      status: "fail",
      occurrenceId: result.scenarios[0]!.evidenceOccurrenceId,
    });
    expect(snapshots.at(-1)!.occurrences.every((item) => item.assertions === null)).toBe(true);
  });

  it.each(["missing result", "cleanup failure"] as const)(
    "retains the child's pass when its %s prevents a returned result",
    async (failure) => {
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
        if (failure === "cleanup failure") {
          throw new Error("child cleanup failed");
        }
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
    },
  );

  it("allocates different worker roots for repeated scenario labels", async () => {
    const lab = createCleanupTestLab();
    const context = createCleanupTestContext();
    context.selectedScenarios.push(context.selectedScenarios[0]!);
    const roots: string[] = [];
    const runChild = vi.fn<QaSuiteRunner>().mockImplementation(async (params) => {
      roots.push(params!.outputDir!);
      const child = await createQaSuiteEvidenceInvocation(params, {
        ...context,
        outputDir: params!.outputDir!,
        selectedScenarios: [context.selectedScenarios[0]!],
      });
      const id = child.invocation.begin(0);
      const result = await child.record(0, id, { name: "same", status: "pass", steps: [] });
      return {
        outputDir: params!.outputDir!,
        evidence: child.snapshot(),
        evidencePath: "unused",
        reportPath: "unused",
        summaryPath: "unused",
        report: "",
        scenarios: [result],
        startedScenarioIds: [context.selectedScenarios[0]!.id],
        watchUrl: lab.baseUrl,
      };
    });
    await runQaFlowSuiteIsolated({ lab, startLab: async () => lab }, context, runChild);
    const final = mocks.writeQaSuiteArtifacts.mock.calls.at(-1)![0].recordedEvidence!;
    expect(new Set(roots).size).toBe(2);
    expect(projectQaEvidenceScenarioOutcomes(final).map((outcome) => outcome.status)).toEqual([
      "pass",
      "pass",
    ]);
    expect(
      new Set(projectQaEvidenceScenarioOutcomes(final).map((outcome) => outcome.occurrenceId)).size,
    ).toBe(2);
  });

  it.each(["running", "pass", "fail"])(
    "preserves the %s progress publication exception boundary",
    async (status) => {
      const lab = createCleanupTestLab();
      const context = createCleanupTestContext();
      context.selectedScenarios[0]!.assertions = [
        { id: "child-result", meaning: "the child owns its result", coverage: [] },
      ];
      const snapshots: QaEvidenceSummaryV3Json[] = [];
      const publicationError = new Error("progress publication rejected");
      vi.mocked(lab.setScenarioRun).mockImplementation((next) => {
        if (next?.scenarios[0]?.status === status) {
          throw publicationError;
        }
      });
      const runChild = vi.fn<QaSuiteRunner>().mockResolvedValue({
        outputDir: "/qa-child",
        evidencePath: "/qa-child/qa-evidence.json",
        reportPath: "/qa-child/qa-suite-report.md",
        summaryPath: "/qa-child/qa-suite-summary.json",
        report: "",
        scenarios: [{ name: "worker result", status: "pass", steps: [] }],
        startedScenarioIds: ["leased-channel-scenario"],
        watchUrl: lab.baseUrl,
      });
      if (status === "fail") {
        runChild.mockRejectedValueOnce(new Error("worker failed"));
      }
      const run = runQaFlowSuiteIsolated(
        { lab, startLab: async () => lab, onEvidence: (summary) => snapshots.push(summary) },
        context,
        runChild,
      );
      if (status === "pass") {
        await expect(run).resolves.toMatchObject({
          scenarios: [{ status: "fail", details: publicationError.message }],
        });
        expect(snapshots.at(-1)!.occurrences.every((item) => item.assertions === null)).toBe(true);
      } else {
        await expect(run).rejects.toBe(publicationError);
        expect(mocks.writeQaSuiteArtifacts).not.toHaveBeenCalled();
      }
      expect(runChild).toHaveBeenCalledTimes(status === "running" ? 0 : 1);
      expect(mocks.disposeRegisteredAgentHarnesses).toHaveBeenCalledOnce();
    },
  );

  it.each(["success", "caught write failure", "queue rejection"] as const)(
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
        evidence: undefined,
        evidencePath: "/qa-output/qa-evidence.json",
        report: "",
        reportPath: "/qa-output/qa-suite-report.md",
        summaryPath: "/qa-output/qa-suite-summary.json",
      };
      mocks.writeQaSuiteArtifacts.mockImplementationOnce(async () => {
        partialStarted.resolve();
        await partialWrite.promise;
        order.push("partial write settled");
        if (partialOutcome !== "success") {
          throw writeError;
        }
        return artifacts;
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
          scenarios: [{ name: id, status: "pass", steps: [] }],
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
        if (partialOutcome !== "success") {
          expect(stderrWrite.mock.calls.flat().join("")).toContain(writeError.message);
        }
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
      evidence: undefined,
      evidencePath: "/qa-output/qa-evidence.json",
      report: "",
      reportPath: "/qa-output/qa-suite-report.md",
      summaryPath: "/qa-output/qa-suite-summary.json",
    };
    mocks.writeQaSuiteArtifacts.mockImplementationOnce(async () => {
      await partialWrite.promise;
      return artifacts;
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
        scenarios: [results[index]!],
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
    const runChild = vi.fn<QaSuiteRunner>().mockResolvedValue({
      outputDir: "/qa-child",
      evidencePath: "/qa-child/qa-evidence.json",
      reportPath: "/qa-child/qa-suite-report.md",
      summaryPath: "/qa-child/qa-suite-summary.json",
      report: "",
      scenarios: [{ name: "leased-channel-scenario", status: "pass", steps: [] }],
      startedScenarioIds: ["leased-channel-scenario"],
      watchUrl: lab.baseUrl,
    });
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

  it.each(["cleanup", "cleanupAfterGatewayStop"] as const)(
    "retries a failed parent %s phase before disposing its owned lab",
    async (cleanupPhase) => {
      const lab = createCleanupTestLab();
      const releaseError = new Error("credential release failed");
      const release = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(releaseError)
        .mockResolvedValueOnce(undefined);
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
            [cleanupPhase]: release,
          };
        },
      };
      const runChild = vi.fn<QaSuiteRunner>();

      await expect(
        runQaFlowSuiteIsolated(
          {
            adapterFactories: [factory],
            channelDriver: "live",
            channelId: "leased",
            startLab: async () => lab,
          },
          createCleanupTestContext(),
          runChild,
        ),
      ).rejects.toBe(releaseError);

      expect(release).toHaveBeenCalledTimes(2);
      expect(runChild).not.toHaveBeenCalled();
      expect(lab.stop).toHaveBeenCalledOnce();
    },
  );
});
