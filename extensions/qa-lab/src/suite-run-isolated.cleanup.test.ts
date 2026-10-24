import "./suite-run-isolated.test-mocks.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, expect, it, vi } from "vitest";
import {
  projectQaEvidenceScenarioOutcomes,
  type QaEvidenceSummaryV3Json as Evidence,
} from "./evidence-summary.js";
import type { QaLabServerHandle as Lab } from "./lab-server.types.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import type { QaTransportAdapterFactory } from "./qa-transport-registry.js";
import * as scenarioCatalog from "./scenario-catalog.js";
import { createQaSuiteEvidenceInvocation } from "./suite-evidence.js";
import { runQaFlowSuiteIsolated } from "./suite-run-isolated.js";
import { createCleanupTestContext, mocks } from "./suite-run-isolated.test-support.js";
import { runQaFlowSuiteStandard } from "./suite-run-standard.js";
import { runQaFlowSuiteFromRuntime } from "./suite-run.runtime.js";
import {
  artifactPaths as artifacts,
  createTestLab as createCleanupTestLab,
} from "./suite-runtime-parity.test-support.js";
import {
  makeQaSuiteTestScenario as makeScenario,
  recordQaSuiteTestResults,
} from "./suite-test-helpers.js";
import type {
  QaSuiteRunner as SuiteRunner,
  QaSuiteRunParams as RunParams,
  QaSuiteScenarioRunner as ScenarioRunner,
  QaSuiteScenarioResult as ScenarioResult,
} from "./suite-types.js";
import * as suite from "./suite.js";

const {
  writeQaSuiteArtifacts: writeArtifacts,
  disposeRegisteredAgentHarnesses: disposeHarnesses,
  captureTransportArtifacts: captureArtifacts,
} = mocks;
const leasedId = "leased-channel-scenario";
const nestedIds = ["first-crabline-scenario", "second-crabline-scenario"];
let lab: Lab;
let context: ReturnType<typeof createCleanupTestContext>;
beforeEach(() => {
  lab = createCleanupTestLab();
  context = createCleanupTestContext();
});
const childAssertions = [
  { id: "child-result", meaning: "the child owns its result", coverage: [] },
];
function makeResult(name: string, overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  return { name, status: "pass", steps: [], ...overrides };
}
const withObservation = (result: ScenarioResult) => ({
  ...result,
  evidenceOccurrenceId: expect.any(String),
});

function childResult(
  params: Parameters<SuiteRunner>[0],
  scenario = makeScenario(context.selectedScenarios[0]!.id),
  result: Partial<ScenarioResult> = {},
) {
  return {
    ...artifacts,
    outputDir: params!.outputDir!,
    ...recordQaSuiteTestResults(params, [scenario], [makeResult(scenario.id, result)]),
    startedScenarioIds: [scenario.id],
    watchUrl: lab.baseUrl,
  };
}

function runIsolated(params: RunParams, child: SuiteRunner) {
  return runQaFlowSuiteIsolated({ startLab: async () => lab, ...params }, context, child);
}
const silenceStderr = () => vi.spyOn(process.stderr, "write").mockImplementation(() => true);

function controlledWorkers(ids: string[], onFinish: (id: string) => void = () => {}) {
  context.concurrency = ids.length;
  context.selectedScenarios = ids.map((id) => makeScenario(id));
  const started = createDeferred<void>();
  const workers = ids.map(() => createDeferred<Partial<ScenarioResult>>());
  const runChild = vi.fn<SuiteRunner>(async (params) => {
    const index = ids.indexOf(params!.scenarioIds![0]!);
    assert.notEqual(index, -1, "expected a selected worker scenario");
    if (runChild.mock.calls.length === ids.length) {
      started.resolve();
    }
    const result = await workers[index]!.promise;
    onFinish(ids[index]!);
    return childResult(params, context.selectedScenarios[index]!, result);
  });
  return {
    runChild,
    started: started.promise,
    finish: (index: number, result: Partial<ScenarioResult> = {}) =>
      workers[index]!.resolve(result),
  };
}
const logText = (writer: { mock: { calls: unknown[][] } }) => writer.mock.calls.flat().join("");
const logLines = (writer: Parameters<typeof logText>[0], prefix: string) =>
  logText(writer)
    .split("\n")
    .filter((line) => line.startsWith(prefix));

const entryStatuses = (evidence: Evidence) => evidence.entries.map(({ result }) => result.status);
const outcomeStatuses = (evidence: Evidence) =>
  projectQaEvidenceScenarioOutcomes(evidence).map(({ status }) => status);
const latestProgress = () => vi.mocked(lab.setScenarioRun).mock.calls.at(-1)?.[0];

function standardChild(runScenario: ScenarioRunner, startedAt = context.startedAt): SuiteRunner {
  return async (params) => {
    assert.ok(params?.outputDir, "expected owned child output");
    const childContext = { ...context, startedAt, outputDir: params.outputDir };
    return runQaFlowSuiteStandard(params, childContext, runScenario);
  };
}

async function expectDraining(settled: (error: unknown) => unknown) {
  await tick();
  expect(settled).not.toHaveBeenCalled();
  expect(disposeHarnesses).not.toHaveBeenCalled();
  expect(lab.stop).not.toHaveBeenCalled();
}

it.each(["missing child result", "rejected progress"] as const)(
  "records a parent failure after a pass: %s",
  async (failure) => {
    context.selectedScenarios[0]!.assertions = childAssertions;
    const snapshots: Evidence[] = [];
    const publicationError = new Error("progress publication rejected");
    if (failure === "rejected progress") {
      vi.mocked(lab.setScenarioRun).mockImplementation((next) => {
        if (next?.scenarios[0]?.status === "pass") {
          throw publicationError;
        }
      });
    }
    const runChild = vi.fn<SuiteRunner>(async (params) => {
      if (failure === "rejected progress") {
        return childResult(params, undefined, { name: "worker result" });
      }
      const child = await createQaSuiteEvidenceInvocation(params, {
        ...context,
        outputDir: params!.outputDir!,
      });
      await child.record(0, child.invocation.begin(0), makeResult("child passed"));
      return {
        ...artifacts,
        outputDir: params!.outputDir!,
        evidence: child.snapshot(),
        scenarios: [],
        startedScenarioIds: [context.selectedScenarios[0]!.id],
        watchUrl: lab.baseUrl,
      };
    });
    const result = await runIsolated(
      { lab, onEvidence: (summary) => snapshots.push(summary) },
      runChild,
    );
    expect(result.scenarios[0]?.status).toBe("fail");
    const final = snapshots.at(-1)!;
    const childId = final.entries[0]!.binding.occurrenceId;
    for (const occurrence of final.occurrences) {
      expect(occurrence.assertions).toEqual(
        failure === "missing child result" && occurrence.id === childId ? childAssertions : null,
      );
    }
    if (failure === "rejected progress") {
      expect(result.scenarios).toMatchObject([
        { status: "fail", details: publicationError.message },
      ]);
      expect(runChild).toHaveBeenCalledOnce();
      expect(disposeHarnesses).toHaveBeenCalledOnce();
    } else {
      expect(entryStatuses(final)).toEqual(["pass", "fail"]);
      expect(final.entries[1]?.coverage).toEqual([]);
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
    }
  },
);

it.each(["caught write failure", "queue rejection"] as const)(
  "drains siblings and queued artifacts after publication failure (%s)",
  async (partialOutcome) => {
    context.channelDriver = undefined;
    context.progressEnabled = true;
    const publicationError = new Error("evidence publication failed");
    const writeError = new Error("partial artifact write failed");
    const queueError = new Error("partial progress publication failed");
    const partialStarted = createDeferred<void>();
    const partialWrite = createDeferred<void>();
    const failureSeen = createDeferred<void>();
    const siblingRecorded = createDeferred<void>();
    const order: string[] = [];
    const workers = controlledWorkers(["completed", "failing", "inflight"], (id) => {
      if (id === "inflight") {
        order.push("sibling settled");
      }
    });
    workers.finish(0);
    let latest: Evidence | undefined;
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
    writeArtifacts.mockImplementationOnce(async () => {
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
    disposeHarnesses.mockImplementationOnce(async () => {
      order.push("harness cleanup");
    });
    vi.mocked(lab.stop).mockImplementation(async () => {
      order.push("lab cleanup");
    });
    const settled = vi.fn((error: unknown) => error);
    const run = runIsolated(
      {
        workerStartStaggerMs: 0,
        onEvidence: (summary) => {
          latest = structuredClone(summary);
          if (!publicationFailed && summary.entries.some((entry) => entry.test.id === "failing")) {
            publicationFailed = true;
            failureSeen.resolve();
            throw publicationError;
          }
          if (summary.entries.some((entry) => entry.test.id === "inflight")) {
            siblingRecorded.resolve();
          }
        },
      },
      workers.runChild,
    ).catch(settled);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await workers.started;
      await partialStarted.promise;
      const firstReceipt = latest!.occurrences.flatMap((entry) => entry.receipts)[0]!;
      const artifactPath = path.join(context.outputDir, firstReceipt.artifact.path);
      const originalBytes = await fs.readFile(artifactPath);
      workers.finish(1);
      await failureSeen.promise;
      await expectDraining(settled);
      if (partialOutcome === "queue rejection") {
        // Reject while the sibling still runs, before finally can await the queue.
        partialWrite.resolve();
        await expectDraining(settled);
        expect(order).toEqual(["partial write settled"]);
        expect(unhandled).not.toHaveBeenCalled();
      }
      workers.finish(2);
      await siblingRecorded.promise;
      if (partialOutcome !== "queue rejection") {
        await expectDraining(settled);
        partialWrite.resolve();
      }
      const error = await run;
      if (partialOutcome === "queue rejection") {
        assert.ok(error instanceof AggregateError);
        expect(error).toMatchObject({
          errors: [publicationError, queueError],
          message: expect.stringContaining("partial artifacts"),
        });
        expect(error.cause).toBe(publicationError);
      } else {
        expect(error).toBe(publicationError);
      }
      expect(logText(stderrWrite)).toContain(writeError.message);
      expect(order).toEqual([
        ...(partialOutcome === "queue rejection"
          ? ["partial write settled", "sibling settled"]
          : ["sibling settled", "partial write settled"]),
        "transport cleanup",
        "harness cleanup",
        "lab cleanup",
      ]);
      expect(writeArtifacts).toHaveBeenCalledTimes(partialOutcome === "queue rejection" ? 1 : 2);
      expect(entryStatuses(latest!)).toEqual(["pass", "pass", "pass"]);
      expect(new Set(latest!.entries.map((entry) => entry.binding.occurrenceId)).size).toBe(3);
      expect(outcomeStatuses(latest!)).toEqual(["pass", "pass", "pass"]);
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
  const workers = controlledWorkers(["first", "second"]);
  context.selectedScenarios.forEach((scenario) => {
    scenario.title = `Catalog ${scenario.id}`;
  });
  const snapshots: Parameters<Lab["setScenarioRun"]>[0][] = [];
  const completed = [createDeferred<void>(), createDeferred<void>()];
  vi.mocked(lab.setScenarioRun).mockImplementation((next) => {
    snapshots.push(structuredClone(next));
    next?.scenarios.forEach((scenario, index) => {
      if (scenario.status === "pass") {
        completed[index]!.resolve();
      }
    });
  });
  const partialWrite = createDeferred<void>();
  writeArtifacts.mockImplementationOnce(async (params) => {
    await partialWrite.promise;
    return { ...artifacts, evidence: params.recordedEvidence };
  });
  disposeHarnesses.mockImplementationOnce(async () => {
    expect(writeArtifacts).toHaveBeenCalledTimes(2);
    expect(snapshots.at(-1)?.status).toBe("running");
    vi.setSystemTime(at(10));
  });
  const results: ScenarioResult[] = [
    makeResult("result first"),
    makeResult("result second", {
      details: "",
      steps: [{ name: "check", status: "pass" }],
    }),
  ];
  const run = runIsolated({ lab, workerStartStaggerMs: 0 }, workers.runChild);
  await workers.started;
  for (const index of [1, 0]) {
    vi.setSystemTime(at(2 - index));
    workers.finish(index, results[index]!);
    await completed[index]!.promise;
  }
  expect(writeArtifacts).toHaveBeenCalledOnce();
  expect(disposeHarnesses).not.toHaveBeenCalled();
  partialWrite.resolve();
  const result = await run;

  const recordedResults = results.map(withObservation);
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
  expect(writeArtifacts.mock.calls.map(([params]) => [params.status, params.scenarios])).toEqual([
    ["running", [recordedResults[1]]],
    ["running", recordedResults],
    [undefined, recordedResults],
  ]);
  expect(disposeHarnesses.mock.invocationCallOrder[0]).toBeLessThan(
    writeArtifacts.mock.invocationCallOrder[2]!,
  );
  expect(vi.mocked(lab.setLatestReport).mock.invocationCallOrder.at(-1)!).toBeLessThan(
    vi.mocked(lab.setScenarioRun).mock.invocationCallOrder.at(-1)!,
  );
});

it("records a rejected dispatched worker and leaves the fail-fast tail unstarted", async () => {
  context.progressEnabled = true;
  context.selectedScenarios.push(makeScenario("never-started"));
  const stderrWrite = silenceStderr();
  const runChild = vi
    .fn<SuiteRunner>()
    .mockRejectedValueOnce(new Error("isolated worker gateway failed"));

  const result = await runIsolated({ failFast: true, lab }, runChild);
  expect(logText(stderrWrite)).toContain(
    "scenario fail (1/2): leased-channel-scenario — isolated scenario worker: isolated worker gateway failed",
  );

  expect(runChild).toHaveBeenCalledOnce();
  expect(result.startedScenarioIds).toEqual([leasedId]);
  expect(result.scenarios).toMatchObject([
    {
      name: leasedId,
      status: "fail",
      details: "isolated worker gateway failed",
    },
  ]);
  expect(latestProgress()).toMatchObject({
    status: "completed",
    scenarios: [
      { id: leasedId, status: "fail" },
      { id: "never-started", status: "pending" },
    ],
  });
  expect(writeArtifacts).toHaveBeenLastCalledWith(
    expect.objectContaining({ scenarios: result.scenarios }),
  );
});

it("leaves only running progress when parent cleanup fails after worker completion", async () => {
  const release = vi.fn(async () => {});
  const factory: QaTransportAdapterFactory = {
    id: "leased",
    matches: ({ channelId, driver }) => channelId === "leased" && driver === "live",
    create: async () => ({
      ...createQaChannelTransport(lab.state),
      id: "leased",
      cleanup: release,
    }),
  };
  const cleanupError = new Error("agent harness disposal failed");
  disposeHarnesses.mockRejectedValueOnce(cleanupError);
  const stderrWrite = silenceStderr();
  context.progressEnabled = true;

  const thrown = await runIsolated(
    {
      adapterFactories: [factory],
      channelDriver: "live",
      channelId: "leased",
    },
    async (params) => childResult(params),
  ).catch((error: unknown) => error);

  expect(release).toHaveBeenCalledOnce();
  expect(disposeHarnesses).toHaveBeenCalledOnce();
  expect(lab.stop).toHaveBeenCalledOnce();
  expect(lab.setLatestReport).toHaveBeenCalledWith(
    expect.objectContaining({ outputPath: "/qa-output/qa-suite-report.md" }),
  );
  expect(writeArtifacts).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ status: "running", writeEvidenceFile: false }),
  );
  expect(lab.setScenarioRun).not.toHaveBeenCalledWith(
    expect.objectContaining({ status: "completed" }),
  );
  assert.ok(thrown instanceof Error);
  expect(thrown.message.split("\n")[0]).toBe("QA scenarios passed, but cleanup failed");
  expect(thrown.message).toContain(
    "failed cleanup phases: agent harnesses: agent harness disposal failed",
  );
  expect(thrown.cause).toBe(cleanupError);
  expect(logText(stderrWrite)).not.toContain("run complete");
});

it("preserves nested publication ownership through concurrent worker runtime preparation", async () => {
  vi.stubEnv("OPENCLAW_QA_SUITE_PROGRESS", "1");
  const stderrWrite = silenceStderr();
  let activeWorkers = 0;
  let maxActiveWorkers = 0;
  const bothWorkersStarted = createDeferred<void>();
  const firstScenarioStarted = createDeferred<void>();
  const bothScenarioExecutionsStarted = createDeferred<void>();
  context.channelDriver = "crabline";
  context.concurrency = 2;
  context.progressEnabled = true;
  context.selectedScenarios = nestedIds.map((id) => makeScenario(id));
  const runScenario = vi.fn<ScenarioRunner>(async (_env, scenario) => {
    if (scenario.id === nestedIds[0]) {
      firstScenarioStarted.resolve();
      await bothScenarioExecutionsStarted.promise;
    } else {
      bothScenarioExecutionsStarted.resolve();
    }
    return { name: scenario.title, status: "pass", steps: [] };
  });
  vi.spyOn(scenarioCatalog, "readQaBootstrapScenarioCatalog").mockReturnValue({
    agentIdentityMarkdown: "test",
    kickoffTask: "test",
    scenarios: context.selectedScenarios,
  });
  vi.spyOn(suite, "runQaSuiteScenarioDefinitionForRuntime").mockImplementation(runScenario);
  const runChild = vi.fn<SuiteRunner>(async (params) => {
    assert.ok(params, "expected nested standard run params");
    activeWorkers += 1;
    maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
    if (activeWorkers === 2) {
      bothWorkersStarted.resolve();
    }
    await bothWorkersStarted.promise;
    if (params.scenarioIds?.[0] === nestedIds[1]) {
      await firstScenarioStarted.promise;
    }
    try {
      return await runQaFlowSuiteFromRuntime(params);
    } finally {
      activeWorkers -= 1;
    }
  });

  const result = await runIsolated(
    {
      channelDriver: "crabline",
      channelId: "telegram",
      lab,
      startLab: async () => createCleanupTestLab(),
    },
    runChild,
  );

  expect(maxActiveWorkers).toBe(2);
  expect(result.scenarios).toMatchObject(nestedIds.map((name) => ({ name, status: "pass" })));
  expect(runScenario).toHaveBeenCalledTimes(2);
  expect(logLines(stderrWrite, "[qa-suite] run complete")).toEqual(["[qa-suite] run complete"]);
  expect(captureArtifacts).toHaveBeenCalledOnce();
  expect(writeArtifacts.mock.calls.at(-1)?.[0]).toMatchObject({
    channel: "telegram",
    channelDriver: "crabline",
    transportArtifacts: await captureArtifacts.mock.results[0]!.value,
  });
  for (const [nonFinalArtifacts] of writeArtifacts.mock.calls.slice(0, -1)) {
    expect(nonFinalArtifacts.transportArtifacts).toBeUndefined();
  }
});
it("retains a failed parent history when the continued isolated child is skipped", async () => {
  context.channelDriver = undefined;
  const scenario = context.selectedScenarios[0]!;
  assert.ok(scenario.execution.kind === "flow");
  scenario.execution.retryCount = 0;
  scenario.assertions = [
    {
      id: "child-result",
      meaning: "the child owns this scenario assertion",
      coverage: [{ id: "qa.coverage", role: "primary" }],
    },
  ];
  let nextStatus: "pass" | "fail" | "skip" = "fail";
  const runScenario = vi.fn<ScenarioRunner>(async () =>
    makeResult(scenario.title, {
      status: nextStatus,
      details: nextStatus === "fail" ? "original child failure" : "later child result",
    }),
  );
  const runChild = standardChild(runScenario);
  const params = { evidenceMode: "slim" as const, startLab: async () => createCleanupTestLab() };
  const first = await runIsolated(params, runChild);
  assert.equal(first.evidence.schemaVersion, 3);
  const original = structuredClone(first.evidence);
  const observations = original.occurrences.filter((item) => item.scenario?.kind === "observation");
  expect(observations.map((item) => item.terminalStatus)).toEqual(["fail", "fail"]);
  for (const observation of observations) {
    const isChild = first.evidence.entries.some(
      (entry) => entry.binding.occurrenceId === observation.id,
    );
    expect(observation.assertions).toEqual(isChild ? scenario.assertions : null);
  }
  const retainedArtifacts = await Promise.all(
    observations.flatMap((item) =>
      item.receipts.map(async ({ artifact }) => ({
        artifact,
        bytes: await fs.readFile(path.resolve(context.outputDir, artifact.path)),
      })),
    ),
  );
  nextStatus = "skip";
  const continued = await runIsolated(
    {
      ...params,
      evidenceAnchors: original.occurrences.filter((item) => item.scenario?.kind === "instance"),
      evidenceContinuation: original,
    },
    runChild,
  );
  assert.equal(continued.evidence.schemaVersion, 3);
  expect(runScenario).toHaveBeenCalledTimes(2);
  expect(continued.scenarios[0]?.status).toBe("fail");
  expect(projectQaEvidenceScenarioOutcomes(continued.evidence)[0]?.status).toBe("fail");
  expect(continued.scenarios[0]).toEqual(first.scenarios[0]);
  expect(continued.evidence.occurrences).toEqual(expect.arrayContaining(observations));
  for (const { artifact, bytes } of retainedArtifacts) {
    expect(await fs.readFile(path.resolve(context.outputDir, artifact.path))).toEqual(bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
  }
  expect(first.evidence).toEqual(original);
});

it("preserves repeated isolated starts and independent progress slots", async () => {
  context.concurrency = 1;
  context.selectedScenarios = [makeScenario("same"), makeScenario("same")];
  let calls = 0;
  const runChild = vi.fn<SuiteRunner>(async (params) => {
    calls += 1;
    return childResult(params, makeScenario("same"), { status: calls === 1 ? "fail" : "pass" });
  });
  const result = await runIsolated({ lab, startLab: async () => createCleanupTestLab() }, runChild);
  expect(new Set(runChild.mock.calls.map(([params]) => params?.outputDir)).size).toBe(2);
  expect(result.startedScenarioIds).toEqual(["same", "same"]);
  expect(result.scenarios.map((item) => item.status)).toEqual(["fail", "pass"]);
  expect(latestProgress()?.scenarios.map((item) => item.status)).toEqual(["fail", "pass"]);
});

it("prints bounded and redacted nested failure progress before artifacts", async () => {
  const labs = [lab, createCleanupTestLab()];
  let nextLab = 0;
  const startLab = vi.fn(async () => labs[nextLab++]!);
  context.channelDriver = undefined;
  context.progressEnabled = true;
  const scenario = context.selectedScenarios[0]!;
  if (scenario.execution.kind === "flow") {
    scenario.execution.retryCount = 0;
  }
  const secret = "synthetic-secret-".repeat(60);
  const details = `verification refused\napiKey="${secret}"\r::error::fixture\n${"🦞".repeat(400)}`;
  const scenarioResult = makeResult(leasedId, {
    status: "fail",
    details: "unrelated scenario metadata",
    steps: [{ name: "Verify\nrequest", status: "fail", details }],
  });
  const runScenario = vi.fn<ScenarioRunner>().mockResolvedValue(scenarioResult);
  const runChild = standardChild(runScenario, new Date("2026-08-04T00:00:01.000Z"));
  const stderrWrite = silenceStderr();
  const assertScenarioProgress = (expectedCount: number) => {
    const lines = logLines(stderrWrite, "[qa-suite] scenario fail (");
    expect(lines).toHaveLength(expectedCount);
    for (const line of lines) {
      const prefix = `[qa-suite] scenario fail (1/1): ${leasedId}`;
      expect(line).toContain("Verify request: verification refused");
      expect(line).toContain("apiKey=<redacted>");
      expect(line).toContain(": :error::fixture");
      expect(line).not.toMatch(/synthetic-secret|unrelated scenario metadata|[\r\n]/u);
      expect(line.slice(prefix.length)).toMatch(/^ — /u);
      expect(line.slice(prefix.length + " — ".length).length).toBeLessThanOrEqual(512);
      expect(line.endsWith("…")).toBe(true);
      expect(Buffer.from(line).toString("utf8")).toBe(line);
    }
  };
  writeArtifacts.mockImplementationOnce(async (params) => {
    assertScenarioProgress(1);
    return { ...artifacts, evidence: params.recordedEvidence };
  });

  const result = await runIsolated({ startLab }, runChild);
  assertScenarioProgress(2);
  expect(result.scenarios).toEqual([withObservation(scenarioResult)]);

  expect(logLines(stderrWrite, "[qa-suite] run complete")).toEqual(["[qa-suite] run complete"]);
  expect(runScenario).toHaveBeenCalledOnce();
  for (const nestedLab of labs) {
    expect(nestedLab.stop).toHaveBeenCalledOnce();
  }
});
