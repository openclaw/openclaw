import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { resolveQaArtifactPath } from "./cli-paths.js";
import { QaSuiteInfraError } from "./errors.js";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import {
  getEffectiveQaEvidenceEntries,
  projectQaEvidenceScenarioOutcomes,
  validateQaEvidenceSummaryJson,
  type QaEvidenceSummaryV3Json as Evidence,
} from "./evidence-summary.js";
import type { QaLabServerHandle as Lab } from "./lab-server.types.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import * as scenarioCatalog from "./scenario-catalog.js";
import { writeQaSuiteArtifacts } from "./suite-artifacts.js";
import { createQaSuiteEvidenceInvocation } from "./suite-evidence.js";
import type { QaSuiteSummaryJson } from "./suite-summary.js";
import {
  makeQaSuiteTestScenario as makeScenario,
  recordQaSuiteTestResults,
} from "./suite-test-helpers.js";
import type { QaSuiteRunParams, QaSuiteScenarioResult } from "./suite.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";
import {
  isQaTestFileScenario,
  type QaScenarioCommandExecution,
} from "./test-file-scenario-runner.js";
import {
  makeTestFileScenario,
  resolveScriptAttemptOutputDir,
  writeDockerCandidateManifest,
  writeNativeVitestReport,
} from "./test-file-scenario-runner.test-support.js";

const {
  prepareDockerE2eEnvironment,
  replaceFileAtomicMock,
  runPluginCommandWithTimeout,
  runQaFlowSuite,
  runQaTestFileScenarios,
} = vi.hoisted(() => ({
  prepareDockerE2eEnvironment: vi.fn(),
  replaceFileAtomicMock:
    vi.fn<typeof import("openclaw/plugin-sdk/security-runtime").replaceFileAtomic>(),
  runPluginCommandWithTimeout: vi.fn(),
  runQaFlowSuite: vi.fn<typeof import("./suite.js").runQaFlowSuite>(),
  runQaTestFileScenarios:
    vi.fn<typeof import("./test-file-scenario-runner.js").runQaTestFileScenarios>(),
}));

vi.mock("./suite.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./suite.js")>()),
  runQaFlowSuite,
}));

vi.mock("./test-file-scenario-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./test-file-scenario-runner.js")>()),
  runQaTestFileScenarios,
}));

vi.mock("./test-file-scenario-docker-batch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./test-file-scenario-docker-batch.js")>()),
  prepareDockerE2eEnvironment,
}));

vi.mock("openclaw/plugin-sdk/run-command", () => ({ runPluginCommandWithTimeout }));

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>();
  replaceFileAtomicMock.mockImplementation(actual.replaceFileAtomic);
  return { ...actual, replaceFileAtomic: replaceFileAtomicMock };
});

import { runQaSuite } from "./suite-launch.runtime.js";

const ids = {
  baseline: "channel-chat-baseline",
  dm: "dm-chat-baseline",
  ui: "control-ui-chat-flow-playwright",
  docker: "docker-npm-onboard-channel-agent",
  group: "group-visible-reply-tool",
  telegram: "telegram-help-command",
  matrixRestart: "matrix-restart-resume",
  thread: "thread-isolation",
  whatsappStatus: "whatsapp-status-command",
  whatsappOpen: "whatsapp-access-control-dm-open",
  slackRuntime: "slack-codex-approval-exec-native",
};
const mutableFlows = [
  "runtime-tool-image-generate",
  "runtime-inventory-drift-check",
  "session-memory-ranking",
];
const tempDirs = createTempDirHarness();
const makeTempRepo = tempDirs.makeTempDir;
let repoRoot: string;
let suiteOutputDir: string;

function runDefinitions(
  scenarioDefinitions: ReturnType<typeof makeScenario>[],
  scenarioIds = scenarioDefinitions.map(({ id }) => id),
) {
  return runSuite({ scenarioDefinitions, scenarioIds });
}

function runSuite(params: QaSuiteRunParams) {
  return runQaSuite({ repoRoot, outputDir: suiteOutputDir, ...params });
}
type NativeParams = Parameters<typeof runQaTestFileScenarios>[0];
type NativeResults = Awaited<ReturnType<typeof runQaTestFileScenarios>>["results"];
const artifactFileNames = ["qa-suite-report.md", "qa-evidence.json", "qa-suite-summary.json"];
const preparedEnv = Object.freeze({ OPENCLAW_CURRENT_PACKAGE_TGZ: "/tmp/candidate.tgz" });
const nativeScenario = (id = "native") => ({
  ...makeTestFileScenario("vitest", `test/${id}.test.ts`),
  ...(id === "native" ? {} : { id }),
});
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const passEntry = (kind: string, id: string, title: string) => ({
  test: { kind, id, title },
  coverage: [],
  result: { status: "pass" as const },
});

function trackActivity<P, R>(run: (params: P) => Promise<R>) {
  const activity = { active: 0, maxActive: 0 };
  return {
    activity,
    run: async (params: P) => {
      activity.active += 1;
      activity.maxActive = Math.max(activity.maxActive, activity.active);
      try {
        return await run(params);
      } finally {
        activity.active -= 1;
      }
    },
  };
}

async function expectReceiptHashes(evidence: Evidence, resolve: (file: string) => string) {
  for (const { artifact } of evidence.occurrences.flatMap(({ receipts }) => receipts)) {
    expect(hash(await fs.readFile(resolve(artifact.path)))).toBe(artifact.sha256);
  }
}

function captureProgress() {
  const runs: Array<Parameters<Lab["setScenarioRun"]>[0]> = [];
  const lab = {
    baseUrl: "http://127.0.0.1:43124",
    listenUrl: "http://127.0.0.1:43124",
    runSelfCheck: vi.fn(),
    setControlUi: vi.fn(),
    setLatestReport: vi.fn(),
    setScenarioRun: vi.fn<Lab["setScenarioRun"]>((run) => runs.push(run)),
    state: {} as Lab["state"],
    stop: vi.fn(),
  } satisfies Lab;
  return { runs, lab };
}

async function passNativeCommand(command: QaScenarioCommandExecution) {
  await writeNativeVitestReport(command, { passed: 1 });
  return { exitCode: 0, stdout: "passed", stderr: "" };
}

async function runNative(params: NativeParams, runCommand = passNativeCommand) {
  const native = await vi.importActual<typeof import("./test-file-scenario-runner.js")>(
    "./test-file-scenario-runner.js",
  );
  return native.runQaTestFileScenarios({ ...params, runCommand });
}

function expectFlowCall(params: Partial<QaSuiteRunParams>, index?: number) {
  const expected = expect.objectContaining(params);
  if (index === undefined) {
    expect(runQaFlowSuite).toHaveBeenCalledWith(expected);
  } else {
    expect(runQaFlowSuite).toHaveBeenNthCalledWith(index, expected);
  }
}

function stubCatalogAssertions(owner: "child" | "scenario") {
  const catalog = structuredClone(scenarioCatalog.readQaBootstrapScenarioCatalog());
  for (const scenario of catalog.scenarios) {
    scenario.assertions = [
      { id: `${owner}-result`, meaning: `the ${owner} owns its result`, coverage: [] },
    ];
  }
  vi.spyOn(scenarioCatalog, "readQaBootstrapScenarioCatalog").mockReturnValue(catalog);
  return catalog;
}

function recordChild(params: QaSuiteRunParams, scenario: ReturnType<typeof makeScenario>) {
  return createQaSuiteEvidenceInvocation(params, {
    repoRoot: params.repoRoot!,
    outputDir: params.outputDir!,
    selectedScenarios: [scenario],
    providerMode: "mock-openai",
    primaryModel: "mock-openai/test-model",
    transportId: "qa-channel",
  });
}

const uniqueCount = (items: readonly unknown[]) => new Set(items).size;
const entryStatuses = (evidence: Evidence) => evidence.entries.map(({ result }) => result.status);
const outcomeStatuses = (evidence: Evidence) =>
  projectQaEvidenceScenarioOutcomes(evidence).map(({ status }) => status);

async function readEvidence(filePath: string) {
  const evidence = validateQaEvidenceSummaryJson(JSON.parse(await fs.readFile(filePath, "utf8")));
  assert.ok(evidence.schemaVersion === 3, "expected aggregate v3 evidence");
  return evidence;
}

async function readSummary(filePath: string): Promise<QaSuiteSummaryJson> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeEvidence(pathLocal: string, evidence: Evidence, writeFile = true) {
  if (writeFile) {
    await fs.mkdir(path.dirname(pathLocal), { recursive: true });
    await fs.writeFile(pathLocal, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
}

function recordFlowResults(params: QaSuiteRunParams | undefined, results: QaSuiteScenarioResult[]) {
  const catalog =
    params?.scenarioDefinitions ?? scenarioCatalog.readQaBootstrapScenarioCatalog().scenarios;
  const definitions = (params?.scenarioIds ?? [ids.baseline]).map((id) =>
    catalog.find((scenario) => scenario.id === id)!,
  );
  return recordQaSuiteTestResults(params, definitions, results);
}

function recordNativeResults(params: NativeParams, results: NativeResults) {
  const recorded = recordQaSuiteTestResults(
    params,
    params.scenarios,
    results.map((result) => ({
      name: result.scenario.title,
      status: result.status === "pass" ? "pass" : result.status === "skipped" ? "skip" : "fail",
      details: result.failureMessage,
      steps: [],
    })),
  );
  return {
    evidence: recorded.evidence,
    results: results.map((result, index) => ({
      ...result,
      evidenceOccurrenceId: recorded.scenarios[index]!.evidenceOccurrenceId,
    })),
  };
}

async function passFlow(
  params: QaSuiteRunParams | undefined,
  overrides: Partial<QaSuiteScenarioResult> = {},
) {
  const outputDir = params?.outputDir ?? "/tmp/qa-flow";
  const evidencePath = path.join(outputDir, "qa-evidence.json");
  const scenarioIds = params?.scenarioIds ?? [ids.baseline];
  const recorded = recordFlowResults(
    params,
    scenarioIds.map((name) =>
      Object.assign({ name, status: "pass" as const, steps: [] }, overrides),
    ),
  );
  await writeEvidence(evidencePath, recorded.evidence, params?.writeEvidenceFile);
  return {
    ...recorded,
    outputDir,
    evidencePath,
    reportPath: path.join(outputDir, "qa-suite-report.md"),
    summaryPath: path.join(outputDir, "qa-suite-summary.json"),
    report: "# QA Suite Report\n",
    startedScenarioIds: scenarioIds,
    watchUrl: "http://127.0.0.1:43124",
  };
}

async function passNative(
  params: NativeParams,
  status: NativeResults[number]["status"] = "pass",
  failureMessage?: string,
) {
  const scenarios = params.scenarios.filter(isQaTestFileScenario);
  const [scenario] = scenarios;
  assert.ok(scenario, "expected scenario");
  const evidencePath = path.join(params.outputDir, "qa-evidence.json");
  const results = scenarios.map((scenarioItem) => ({
    durationMs: 1,
    logPath: path.join(params.outputDir, `${scenarioItem.id}.log`),
    scenario: scenarioItem,
    status,
    failureMessage,
  }));
  const recorded = recordNativeResults(params, results);
  await writeEvidence(evidencePath, recorded.evidence, params.writeEvidenceFile);
  return {
    ...recorded,
    outputDir: params.outputDir,
    executionKind: scenario.execution.kind,
    evidencePath,
  };
}

function blockNext<P, R>(
  mock: { mockImplementationOnce(implementation: (params: P) => Promise<R>): unknown },
  run: (params: P) => Promise<R>,
) {
  const started = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  mock.mockImplementationOnce(async (params) => {
    started.resolve();
    await blocked.promise;
    return run(params);
  });
  return { started: started.promise, release: blocked.resolve };
}

function trackMaxActiveFlowRuns() {
  const tracked = trackActivity(async (params: QaSuiteRunParams | undefined) => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
    return await passFlow(params);
  });
  runQaFlowSuite.mockImplementation(tracked.run);
  return () => tracked.activity.maxActive;
}

async function expectAtomicFailure(outputDir: string, publish: () => Promise<unknown>) {
  const failedFileName = "qa-suite-summary.json";
  const sentinel = `prior ${failedFileName}\n`;
  const selectedPath = path.join(outputDir, failedFileName);
  await fs.mkdir(outputDir, { recursive: true, mode: 0o750 });
  await fs.chmod(outputDir, 0o750);
  await fs.writeFile(selectedPath, sentinel, { encoding: "utf8", mode: 0o640 });
  await fs.chmod(selectedPath, 0o640);
  const actualSecurityRuntime = await vi.importActual<
    typeof import("openclaw/plugin-sdk/security-runtime")
  >("openclaw/plugin-sdk/security-runtime");
  const publicationOrder: string[] = [];
  const failSelectedArtifact = async (options: Parameters<typeof replaceFileAtomicMock>[0]) => {
    publicationOrder.push(path.basename(options.filePath));
    return await actualSecurityRuntime.replaceFileAtomic({
      ...options,
      beforeRename:
        path.basename(options.filePath) === failedFileName
          ? async ({ tempPath }) => {
              await fs.writeFile(tempPath, "partial replacement\n", "utf8");
              throw Object.assign(new Error("publication failed"), { code: "EIO" });
            }
          : options.beforeRename,
    });
  };

  await replaceFileAtomicMock.withImplementation(failSelectedArtifact, async () => {
    await expect(publish()).rejects.toMatchObject({ code: "EIO" });
  });

  await expect(fs.readFile(selectedPath, "utf8")).resolves.toBe(sentinel);
  if (process.platform !== "win32") {
    expect((await fs.stat(selectedPath)).mode & 0o777).toBe(0o640);
    expect((await fs.stat(outputDir)).mode & 0o7777).toBe(0o750);
  }
  expect(publicationOrder).toEqual(artifactFileNames);
  expect(
    (await fs.readdir(outputDir)).filter((entry) =>
      entry.startsWith(`${failedFileName}.qa-artifact.`),
    ),
  ).toEqual([]);
}

beforeEach(async () => {
  repoRoot = await makeTempRepo("qa-suite-runtime-");
  suiteOutputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "suite");
  replaceFileAtomicMock.mockClear();
  runQaFlowSuite.mockReset().mockImplementation(passFlow);
  runQaTestFileScenarios.mockReset().mockImplementation(passNative);
  prepareDockerE2eEnvironment.mockReset().mockResolvedValue(undefined);
  runPluginCommandWithTimeout.mockReset().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await tempDirs.cleanup();
});

it("preserves interleaved repeated requests through the real native invocation boundary", async () => {
  const first = nativeScenario("first");
  const second = nativeScenario("second");
  let calls = 0;
  runQaTestFileScenarios.mockImplementation(
    async (params) =>
      await runNative(params, async (command) => {
        calls += 1;
        await writeNativeVitestReport(command, { passed: 1 });
        return { exitCode: calls === 2 ? 7 : 0, stdout: `native ${calls}\n`, stderr: "" };
      }),
  );
  const result = await runDefinitions([first, second], ["first", "second", "first"]);
  const evidence = await readEvidence(result.result.evidencePath);
  const outcomes = projectQaEvidenceScenarioOutcomes(evidence);
  expect(calls).toBe(3);
  expect(outcomes.map((outcome) => outcome.scenarioId)).toEqual(["first", "second", "first"]);
  expect(outcomes.map((outcome) => outcome.status)).toEqual(["pass", "fail", "pass"]);
  expect(uniqueCount(outcomes.map((outcome) => outcome.scenarioInstanceId))).toBe(3);
  expect(uniqueCount(outcomes.map((outcome) => outcome.occurrenceId))).toBe(3);
  expect(result.result.scenarios.map((scenario) => scenario.evidenceOccurrenceId)).toEqual(
    outcomes.map((outcome) => outcome.occurrenceId),
  );
  const logs = evidence.occurrences.flatMap((occurrence) =>
    occurrence.receipts.map((receipt) => receipt.artifact),
  );
  expect(uniqueCount(logs.map((artifact) => artifact.path))).toBe(3);
  for (const [index, artifact] of logs.entries()) {
    const bytes = await fs.readFile(resolveQaArtifactPath(repoRoot, repoRoot, artifact.path));
    expect(bytes.toString()).toContain(`native ${index + 1}`);
    expect(hash(bytes)).toBe(artifact.sha256);
  }
});

it("retains open comparison completion before a later child observation in the aggregate", async () => {
  const flow = makeScenario("flow");
  const native = nativeScenario();

  runQaTestFileScenarios.mockImplementation(runNative);
  let expected: Evidence | undefined;
  runQaFlowSuite.mockImplementation(async (params) => {
    assert.ok(params, "expected suite invocation params");
    const base = await passFlow(params);
    const child = createQaEvidenceInvocation({
      scenarios: [flow],
      channel: params.evidenceAnchors![0]!.parentCell!.channel,
      launch: params.evidenceAnchors![0]!.launch,
      anchors: params.evidenceAnchors,
      continuation: params.evidenceContinuation,
    });
    const snapshot = () => child.snapshot({ generatedAt: "2026-09-13T00:00:00.000Z" });
    const rows = [passEntry("qa-scenario", flow.id, flow.title)];
    const comparison = child.begin(0, null);
    params.onEvidence!(snapshot());
    const first = child.begin(0, null);
    child.complete(first, { status: "pass", entries: rows });
    child.select(0, first);
    params.onEvidence!(snapshot());
    child.complete(comparison, { status: "pass", entries: rows });
    child.select(0, comparison);
    params.onEvidence!(snapshot());
    const last = child.begin(0, null);
    child.complete(last, { status: "pass", entries: rows });
    child.select(0, last);
    expected = snapshot();
    params.onEvidence!(expected);
    return {
      ...base,
      evidence: expected,
      scenarios: [{ name: flow.title, status: "pass", steps: [], evidenceOccurrenceId: last }],
    };
  });
  const result = await runDefinitions([flow, native]);
  const evidence = await readEvidence(result.result.evidencePath);
  assert.ok(expected, "expected child and aggregate v3 evidence");
  expect(evidence.occurrences).toEqual(expect.arrayContaining(expected.occurrences));
  expect(outcomeStatuses(evidence)).toEqual(["pass", "pass"]);
});

it("keeps retained multi-instance script bundles inside repeated outer aggregate instances", async () => {
  const script = makeTestFileScenario("script", "scripts/producer.mjs");
  const native = nativeScenario();

  const capturedChildren: Evidence[] = [];
  runQaTestFileScenarios.mockImplementation(async (params) =>
    runNative(params, async (command) => {
      if (command.args.includes("--artifact-base")) {
        const anchor = params.evidenceAnchors?.[0];
        assert.ok(anchor, "expected supplied native evidence anchor");
        const child = createQaEvidenceInvocation({
          scenarios: [script, script],
          channel: null,
          launch: anchor.launch,
        });
        const id = child.begin(0);
        child.complete(id, {
          status: "pass",
          entries: [passEntry("script", "child", "Child")],
        });
        child.select(0, id);
        const snapshot = child.snapshot({ generatedAt: "2026-09-13T00:00:00Z" });
        capturedChildren.push(snapshot);
        await fs.writeFile(
          path.join(resolveScriptAttemptOutputDir(command), script.id, "qa-evidence.json"),
          JSON.stringify(snapshot),
          { flag: "wx" },
        );
      } else {
        await writeNativeVitestReport(command, { passed: 1 });
      }
      return { exitCode: 0, stdout: "completed", stderr: "" };
    }),
  );
  const result = await runDefinitions([script, native], [script.id, native.id, script.id]);
  const evidence = await readEvidence(result.result.evidencePath);
  expect(capturedChildren).toHaveLength(2);
  const outcomes = projectQaEvidenceScenarioOutcomes(evidence);
  expect(outcomes.map((item) => item.scenarioId)).toEqual([script.id, native.id, script.id]);
  expect(outcomes.map((item) => item.status)).toEqual(["blocked", "pass", "blocked"]);
  expect(result.result.scenarios.map((item) => item.evidenceOccurrenceId)).toEqual(
    outcomes.filter((item) => item.occurrenceId !== null).map((item) => item.occurrenceId),
  );
  for (const child of capturedChildren) {
    expect(outcomeStatuses(child)).toEqual(["pass", null]);
    expect(evidence.occurrences).toEqual(expect.arrayContaining(child.occurrences));
  }
});

it("retains child evidence but rejects a returned result from a foreign observation", async () => {
  const scenario = nativeScenario();

  runQaTestFileScenarios.mockImplementation(async (params) => {
    const result = await runNative(params);
    result.results[0]!.evidenceOccurrenceId = "foreign-observation";
    return result;
  });
  const result = await runDefinitions([scenario]);
  expect(result.result.scenarios).toMatchObject([
    { status: "fail", details: expect.stringContaining("selected observation") },
  ]);
  const evidence = await readEvidence(result.result.evidencePath);
  expect(entryStatuses(evidence)).toEqual(["pass", "fail"]);
  expect(projectQaEvidenceScenarioOutcomes(evidence)[0]?.status).toBe("fail");
});

it.each([
  { initial: "pass", retry: "pass", explicitOutput: true, effective: [true, true] },
  { initial: "fail", retry: "skip", explicitOutput: false, effective: [true, false] },
] as const)(
  "retains $initial observations when infrastructure retries as $retry",
  async ({ initial, retry, explicitOutput, effective }) => {
    const scenario = makeScenario(ids.baseline);
    const roots: string[] = [];
    const snapshots: Evidence[] = [];
    const retained = new Map<string, Buffer>();
    let firstResult: QaSuiteScenarioResult | undefined;
    runQaFlowSuite.mockImplementation(async (params) => {
      assert.ok(params, "expected suite invocation params");
      const result = await passFlow(params);
      roots.push(params.outputDir!);
      const recording = await recordChild(params, scenario);
      const selected = await recording.record(0, recording.invocation.begin(0), {
        name: scenario.title,
        status: roots.length === 1 ? initial : retry,
        details: `attempt ${roots.length}`,
        steps: [],
      });
      if (roots.length === 1) {
        firstResult = selected;
        for (const receipt of recording.snapshot().occurrences.flatMap((item) => item.receipts)) {
          const artifactPath = path.resolve(params.outputDir!, receipt.artifact.path);
          retained.set(artifactPath, await fs.readFile(artifactPath));
        }
        throw new QaSuiteInfraError("agent_wait_failed", "infrastructure after result");
      }
      return { ...result, scenarios: [selected], evidence: recording.snapshot() };
    });
    const result = await runQaSuite({
      repoRoot,
      outputDir: explicitOutput ? path.join(repoRoot, "output") : undefined,
      providerMode: "mock-openai",
      scenarioIds: [scenario.id],
      onEvidence: (summary) => snapshots.push(structuredClone(summary)),
    });
    assert.ok(result.executionKind === "flow");
    const evidence = result.result.evidence;
    expect(roots).toHaveLength(2);
    expect(roots[0]).toBe(roots[1]);
    expect(result.result.outputDir).toBe(roots[0]);
    expect(evidence.entries.map((entry) => entry.effective)).toEqual(effective);
    expect(projectQaEvidenceScenarioOutcomes(evidence)).toMatchObject([
      {
        scenarioId: scenario.id,
        occurrenceId: result.result.scenarios[0]!.evidenceOccurrenceId,
        status: initial,
      },
    ]);
    if (initial === "fail") {
      expect(result.result.scenarios[0]).toEqual(firstResult);
      expect(await fs.readdir(path.join(repoRoot, ".artifacts", "qa-e2e"))).toHaveLength(1);
    } else {
      expect(snapshots).toHaveLength(4);
      expect(uniqueCount(snapshots.map((snapshot) => snapshot.occurrences[0]!.id))).toBe(1);
      expect(entryStatuses(evidence)).toEqual(["pass", "pass"]);
      expect(evidence.occurrences.filter((item) => item.terminalStatus === "fail")).toHaveLength(0);
    }
    for (const [artifactPath, bytes] of retained) {
      expect(await fs.readFile(artifactPath)).toEqual(bytes);
    }
    await expectReceiptHashes(evidence, (file) => path.resolve(result.result.outputDir, file));
  },
);

it.each([
  {
    name: "runtime-specific channel scenarios",
    ordered: false,
    params: { channelDriver: "live", channelId: "slack", concurrency: 4 },
    scenarioIds: ["slack-canary", ids.slackRuntime],
    workers: [
      ["isolated", ["slack-canary"], { forcedRuntime: undefined }],
      ["runtime-codex-1", [ids.slackRuntime], { forcedRuntime: "codex" }],
    ],
  },
  {
    name: "flows that mutate shared state",
    ordered: true,
    params: { concurrency: 8 },
    scenarioIds: [ids.dm, ...mutableFlows, ids.ui],
    workers: [
      ["shared", [ids.dm], { concurrency: 1 }],
      ["isolated", mutableFlows, { concurrency: 3, workerStartStaggerMs: 1_500 }],
    ],
  },
] as const)("dedicates workers to $name", async ({ params, scenarioIds, workers, ordered }) => {
  await runSuite({ ...params, scenarioIds: [...scenarioIds] });
  expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
  workers.forEach(([partition, workerIds, worker], index) => {
    expectFlowCall(
      {
        ...worker,
        scenarioIds: [...workerIds],
        outputDir: path.join(suiteOutputDir, "flow", partition),
      },
      ordered ? index + 1 : undefined,
    );
  });
});

it("expands profile scenarios across every eligible pluggable channel", async () => {
  runQaFlowSuite.mockImplementation((params) =>
    passFlow(params, {
      status:
        params?.channelId === "matrix" && params.scenarioIds?.includes(ids.thread)
          ? "fail"
          : "pass",
    }),
  );
  const adapterFactories = [
    {
      id: "portable-driver",
      matches: vi.fn(({ channelId }) => ["matrix", "slack", "telegram"].includes(channelId)),
      create: vi.fn(),
    },
  ];

  const result = await runSuite({
    providerMode: "mock-openai",
    channelDriver: "live",
    adapterFactories,
    expandScenarioChannels: true,
    scenarioIds: [ids.baseline, ids.telegram, ids.matrixRestart, ids.thread],
  });

  expect(runQaFlowSuite).toHaveBeenCalledTimes(5);
  for (const [channelId, partition, scenarioId] of [
    [undefined, "", ids.baseline],
    ["telegram", "telegram", ids.telegram],
    ["matrix", "matrix-isolated-1", ids.matrixRestart],
    ["slack", null, ids.thread],
    ["matrix", "matrix-isolated-2", ids.thread],
  ] as const) {
    expectFlowCall({
      adapterFactories,
      channelId,
      ...(partition === null ? {} : { outputDir: path.join(suiteOutputDir, "flow", partition) }),
      scenarioIds: [scenarioId],
    });
    expect(result.observedCells).toContainEqual({
      scenarioId,
      executionKind: "flow",
      channel: channelId ?? null,
    });
  }
  expect(result.executionKind).toBe("suite");
  for (const [channel, status] of [
    ["slack", "pass"],
    ["matrix", "fail"],
  ]) {
    expect(result.result.scenarios).toContainEqual(
      expect.objectContaining({ name: `thread-isolation [${channel}]`, status }),
    );
  }
});

it("retains captured child observations through an aggregate retry", async () => {
  const catalog = stubCatalogAssertions("child");
  const childIds = new Set<string>();
  const anchors: string[] = [];
  let attempts = 0;
  runQaFlowSuite.mockImplementation(async (params) => {
    assert.ok(params, "expected suite invocation params");
    const base = await passFlow(params);
    const id = params.scenarioIds![0]!;
    const target = id === ids.telegram;
    if (target) {
      attempts += 1;
      anchors.push(params.evidenceAnchors![0]!.id);
    }
    const recording = await recordChild(
      params,
      catalog.scenarios.find((row) => row.id === id)!,
    );
    const observation = recording.invocation.begin(0);
    childIds.add(observation);
    const result = await recording.record(0, observation, {
      name: id,
      status: target && attempts === 1 ? "fail" : "pass",
      steps: [],
      details: `actual child attempt ${attempts}`,
    });
    if (target && attempts === 1) {
      throw new QaSuiteInfraError("transport_ready_timeout", "retry this captured failure");
    }
    return { ...base, evidence: recording.snapshot(), scenarios: [result] };
  });
  const result = await runSuite({
    providerMode: "mock-openai",
    channelDriver: "crabline",
    scenarioIds: [ids.telegram, ids.matrixRestart],
  });
  const evidence = await readEvidence(result.result.evidencePath);
  for (const occurrence of evidence.occurrences) {
    expect(occurrence.assertions).toEqual(
      childIds.has(occurrence.id)
        ? [{ id: "child-result", meaning: "the child owns its result", coverage: [] }]
        : null,
    );
  }
  expect(uniqueCount(anchors)).toBe(1);
  expect(anchors).toHaveLength(2);
  expect(outcomeStatuses(evidence)).toEqual(["pass", "pass"]);
  expect(result.result.scenarios.map((scenario) => scenario.status)).toEqual(
    outcomeStatuses(evidence),
  );
  const observed = evidence.entries.filter((entry) => entry.test.id === ids.telegram);

  expect(observed.map((entry) => entry.result.status)).toEqual(["fail", "fail", "pass"]);
  expect(getEffectiveQaEvidenceEntries(evidence).map((entry) => entry.result.status)).toEqual([
    "pass",
    "pass",
  ]);
  expect(evidence.occurrences.filter(({ retryOf }) => retryOf !== null)).toHaveLength(2);
});

it.each([false, true])(
  "bounds pluggable-driver concurrency (isolated instances: %s)",
  async (isolatesInstances) => {
    const maxActive = trackMaxActiveFlowRuns();
    const isolatedScenarioId = "matrix-approval-channel-target-both";
    const sharedScenarioIds = [
      "matrix-approval-deny-reaction",
      "matrix-approval-exec-metadata-chunked",
      "matrix-approval-exec-metadata-single-event",
      "matrix-approval-plugin-metadata-single-event",
      "matrix-approval-thread-target",
    ];
    const scenarioIds = isolatesInstances
      ? [isolatedScenarioId, ...sharedScenarioIds]
      : [ids.telegram, ids.matrixRestart];
    const concurrency = isolatesInstances ? 6 : 2;
    await runSuite({
      providerMode: "mock-openai",
      channelDriver: "live",
      adapterFactories: [
        isolatesInstances
          ? {
              id: "matrix",
              isolatesInstances: true,
              matches: ({ channelId, driver }) => driver === "live" && channelId === "matrix",
              create: vi.fn(),
            }
          : { id: "portable-driver", matches: vi.fn(), create: vi.fn() },
      ],
      concurrency,
      scenarioIds,
    });

    if (isolatesInstances) {
      expect(runQaFlowSuite).toHaveBeenCalledTimes(6);
      expect(runQaFlowSuite.mock.calls.map(([params]) => params?.scenarioIds)).toEqual([
        ...sharedScenarioIds.map((scenarioId) => [scenarioId]),
        [isolatedScenarioId],
      ]);
    }
    expect(maxActive()).toBe(concurrency);
  },
);

it("partitions mixed Crabline child evidence into one aggregate suite", async () => {
  runQaFlowSuite.mockImplementation(async (params) => {
    const result = await passFlow(params);
    result.evidence.entries = result.evidence.entries.map((entry) => ({
      ...entry,
      execution: {
        runner: "host",
        environment: { ref: null, os: "linux", nodeVersion: "v24.0.0" },
        provider: { id: "mock-openai", live: false, model: { name: null, ref: null } },
        channel: { id: params?.channelId ?? "qa-channel", live: false, driver: "crabline" },
        packageSource: { kind: "source-checkout" },
        artifacts: [{ kind: "report", path: "qa-suite-report.md", source: "qa-suite" }],
      },
    }));
    return result;
  });
  const result = await runSuite({
    providerMode: "mock-openai",
    channelDriver: "crabline",
    scenarioIds: [ids.telegram, ids.matrixRestart],
  });

  expect(result).toMatchObject({
    executionKind: "suite",
    result: {
      evidencePath: path.join(suiteOutputDir, "qa-evidence.json"),
      summaryPath: path.join(suiteOutputDir, "qa-suite-summary.json"),
    },
  });
  const summary = await readSummary(path.join(suiteOutputDir, "qa-suite-summary.json"));
  expect(summary.run).toMatchObject({
    channelDriver: "crabline",
    channel: null,
    scenarioIds: [ids.telegram, ids.matrixRestart],
  });
  const evidence = await readEvidence(path.join(suiteOutputDir, "qa-evidence.json"));
  expect(evidence.entries?.map((entry) => entry.execution?.artifacts?.[0]?.path)).toEqual([
    ".artifacts/qa-e2e/suite/flow/telegram/qa-suite-report.md",
    ".artifacts/qa-e2e/suite/flow/matrix/qa-suite-report.md",
  ]);
});

it("projects a skipped native producer as a skipped unified scenario", async () => {
  runQaTestFileScenarios.mockImplementationOnce((params) => passNative(params, "skipped"));

  const result = await runSuite({ scenarioIds: [ids.ui] });
  expect(result.result.scenarios).toMatchObject([
    { name: "Control UI chat flow Playwright coverage", status: "skip" },
  ]);
  const summary = await readSummary(result.result.summaryPath);
  expect(summary.counts).toMatchObject({ failed: 0, skipped: 1 });
  expect(runPluginCommandWithTimeout).not.toHaveBeenCalled();
});

it("preserves the prior standard summary artifact when atomic publication fails", async () => {
  const outputDir = await makeTempRepo("qa-suite-standard-artifact-atomic-");
  const scenarios: QaSuiteScenarioResult[] = [
    { name: "Atomic publication", status: "pass", steps: [] },
  ];
  await expectAtomicFailure(outputDir, () =>
    writeQaSuiteArtifacts({
      outputDir,
      startedAt: new Date("2026-08-12T00:00:00.000Z"),
      finishedAt: new Date("2026-08-12T00:01:00.000Z"),
      scenarios,
      recordedEvidence: recordQaSuiteTestResults(undefined, [makeScenario(ids.baseline)], scenarios)
        .evidence,
      transport: createQaChannelTransport(createQaBusState()),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      fastMode: true,
      concurrency: 1,
    }),
  );
});

it("aggregates mixed-kind progress through the parent lab", async () => {
  const { runs: scenarioRuns, lab } = captureProgress();
  runQaFlowSuite.mockImplementationOnce(async (params) => {
    const publish = (id: string, status: "running" | "fail" | "pass") =>
      params?.lab?.setScenarioRun({
        kind: "suite",
        status: status === "pass" ? "completed" : "running",
        startedAt: "2026-07-23T00:00:00.000Z",
        ...(status === "pass" ? { finishedAt: "2026-07-23T00:00:01.000Z" } : {}),
        scenarios: [{ id, name: ids.baseline, status }],
      });
    publish(ids.baseline, "running");
    publish("not-a-selected-scenario", "fail");
    const result = await passFlow(params);
    publish(ids.baseline, "pass");
    return result;
  });

  await runQaSuite({
    lab,
    repoRoot,
    outputDir: ".artifacts/qa-e2e/mixed-progress",
    scenarioIds: [ids.baseline, ids.ui],
  });

  const running = scenarioRuns
    .filter((run) => run?.status === "running")
    .flatMap((run) => run?.scenarios ?? []);
  expect(running).toEqual(
    expect.arrayContaining(
      [ids.baseline, ids.ui].map((id) => expect.objectContaining({ id, status: "running" })),
    ),
  );
  expect(scenarioRuns.flatMap((run) => run?.scenarios ?? [])).not.toContainEqual(
    expect.objectContaining({ id: ids.baseline, status: "fail" }),
  );
  expect(scenarioRuns.at(-1)).toMatchObject({
    status: "completed",
    scenarios: [
      { id: ids.baseline, status: "pass" },
      { id: ids.ui, status: "pass" },
    ],
  });
  expect(lab.setLatestReport).toHaveBeenCalledWith(
    expect.objectContaining({ outputPath: expect.stringMatching(/qa-suite-report\.md$/u) }),
  );
});

it.each([
  ["live", "fail-fast"],
  ["crabline", "retry"],
] as const)("shares exclusive channel workers (%s, %s)", async (channelDriver, mode) => {
  const sharedIds = ["shared-a", "shared-b", "shared-c"];
  const isolatedIds = ["isolated-a", "isolated-b"];
  const native = nativeScenario();
  const scenarioDefinitions = [
    ...sharedIds.map((id) => makeScenario(id, { channel: "telegram" })),
    ...isolatedIds.map((id) =>
      makeScenario(id, { channel: "telegram", suiteIsolation: "isolated" }),
    ),
    native,
  ];
  const mixed = mode === "retry";
  const scenarioIds = mixed
    ? ["shared-a", "isolated-a", "shared-b", native.id, "shared-c", "isolated-b"]
    : sharedIds;
  let attempts = 0;
  const tracked = trackActivity(async (params: QaSuiteRunParams | undefined) => {
    assert.ok(params, "expected suite invocation params");
    attempts += 1;
    if (attempts === 1 && mode === "retry") {
      throw new QaSuiteInfraError("transport_ready_timeout", "first partition failed");
    }
    if (mode === "fail-fast") {
      throw new Error("first scenario failed");
    }
    return await passFlow(params);
  });
  runQaFlowSuite.mockImplementation(tracked.run);

  const result = await runSuite({
    scenarioDefinitions,
    scenarioIds,
    channelDriver,
    channelId: "telegram",
    adapterFactories:
      channelDriver === "live"
        ? [
            {
              id: "shared-channel",
              matches: ({ channelId, driver }) => driver === "live" && channelId === "telegram",
              create: vi.fn(),
            },
          ]
        : undefined,
    concurrency: 8,
    failFast: mode === "fail-fast",
  });

  const expectedPartitions =
    mode === "fail-fast"
      ? [["shared-a"]]
      : [sharedIds, sharedIds, ...isolatedIds.map((id) => [id])];
  expect(
    runQaFlowSuite.mock.calls.map(([params]) => ({
      scenarios: params?.scenarioIds,
      concurrency: params?.concurrency,
    })),
  ).toEqual(expectedPartitions.map((scenarios) => ({ scenarios, concurrency: 1 })));
  expect(runQaTestFileScenarios).toHaveBeenCalledTimes(mixed ? 1 : 0);
  expect(tracked.activity).toEqual({ maxActive: 1, active: 0 });
  expect(result.result.scenarios.map(({ name, status }) => ({ name, status }))).toEqual(
    mode === "fail-fast"
      ? [{ name: "shared-a", status: "fail" }]
      : scenarioIds.map((id) => ({ name: id === native.id ? native.title : id, status: "pass" })),
  );
  const evidence = await readEvidence(result.result.evidencePath);
  const outcomes = projectQaEvidenceScenarioOutcomes(evidence);
  expect(outcomes.map((outcome) => outcome.scenarioId)).toEqual(scenarioIds);
  expect(uniqueCount(outcomes.map((outcome) => outcome.scenarioInstanceId))).toBe(
    scenarioIds.length,
  );
  expect(outcomes.map((outcome) => outcome.status)).toEqual(
    mode === "fail-fast" ? ["fail", null, null] : scenarioIds.map(() => "pass"),
  );
});

it.each(["failed", "missing"] as const)(
  "stops unified partitions after a %s flow result",
  async (mode) => {
    const { runs: scenarioRuns, lab } = captureProgress();
    if (mode === "missing") {
      stubCatalogAssertions("scenario");
    }
    runQaFlowSuite.mockImplementationOnce(async (params) => {
      const result = await passFlow(
        params,
        mode === "failed" ? { status: "fail", details: "first scenario failed" } : {},
      );
      return mode === "missing" ? { ...result, scenarios: [] } : result;
    });
    const result = await runSuite({
      lab,
      concurrency: 8,
      failFast: true,
      scenarioIds: [ids.dm, ids.group, ids.ui, ids.docker],
    });
    const details =
      mode === "missing" ? "suite partition returned no scenario result" : "first scenario failed";
    const failed = {
      name: mode === "missing" ? "DM baseline conversation" : ids.dm,
      status: "fail",
      details,
    };
    expect(result.executionKind).toBe("suite");
    expect(runQaFlowSuite).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ concurrency: 1, failFast: true, scenarioIds: [ids.dm] }),
    );
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
    expect(prepareDockerE2eEnvironment).not.toHaveBeenCalled();
    expect(result.result.scenarios).toMatchObject([failed]);
    const summary = await readSummary(result.result.summaryPath);
    const scenarioIds = [ids.dm, ids.group, ids.ui, ids.docker];
    expect(summary).toMatchObject({ run: { concurrency: 1, scenarioIds }, scenarios: [failed] });
    expect(scenarioRuns.at(-1)).toMatchObject({
      status: "completed",
      scenarios: scenarioIds.map((id, index) => ({
        id,
        status: index === 0 ? "fail" : "pending",
      })),
    });
    if (mode === "missing") {
      const evidence = await readEvidence(result.result.evidencePath);
      expect(evidence.entries).toMatchObject([
        { test: { id: ids.dm }, result: { status: "pass" } },
        { test: { id: ids.dm }, result: { status: "fail", failure: { reason: details } } },
      ]);
      const childId = evidence.entries[0]!.binding.occurrenceId;
      for (const occurrence of evidence.occurrences) {
        expect(occurrence.assertions).toEqual(
          occurrence.id === childId
            ? [{ id: "scenario-result", meaning: "the scenario owns its result", coverage: [] }]
            : null,
        );
      }
    }
  },
);

it("leaves nested E2E script runtime preparation to the script owner", async () => {
  await runSuite({ scenarioIds: ["managed-gateway-service-lifecycle"] });

  expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
  const [call] = runQaTestFileScenarios.mock.calls[0]!;
  expect(call.scenarios).toMatchObject([
    { id: "managed-gateway-service-lifecycle", execution: { kind: "script" } },
  ]);
  expect(call).not.toHaveProperty("env");
  expect(call).not.toHaveProperty("envMode");
  expect(prepareDockerE2eEnvironment).not.toHaveBeenCalled();
});

it("settles flow and native work, then runs serial scripts before a bounded parallel tail", async () => {
  const flow = Promise.withResolvers<void>();
  const native = Promise.withResolvers<void>();
  const serial = Promise.withResolvers<void>();
  const parallel = Promise.withResolvers<void>();
  const started: string[] = [];
  const scriptEnvs: unknown[] = [];
  const parallelScriptIds: string[] = [];
  const parallelWork = trackActivity(async (params: NativeParams) => {
    parallelScriptIds.push(...params.scenarios.map(({ id }) => id));
    await parallel.promise;
  });
  runQaFlowSuite.mockImplementationOnce(async (params) => {
    started.push("flow");
    await flow.promise;
    return await passFlow(params);
  });
  prepareDockerE2eEnvironment.mockImplementationOnce(async () => {
    started.push("prep");
    return preparedEnv;
  });
  runQaTestFileScenarios.mockImplementation(async (params) => {
    const scenarioIds = params.scenarios.map((scenario) => scenario.id);
    const kind = params.scenarios[0]?.execution.kind;
    if (kind === "playwright") {
      started.push("native");
      await native.promise;
    } else if (scenarioIds.includes(ids.docker)) {
      scriptEnvs.push(params.env);
      started.push(...scenarioIds);
      await serial.promise;
    } else {
      scriptEnvs.push(params.env);
      await parallelWork.run(params);
    }
    return await passNative(params);
  });

  const runPromise = runSuite({
    concurrency: 8,
    scenarioIds: [
      ids.dm,
      ids.ui,
      ids.docker,
      "mcp-gateway-connect-startup-retry",
      "voice-call-cli-rpc-agent-tool",
      "remote-log-tailing",
      "gateway-smoke",
      "logging-file-boundary",
      "diagnostic-events-boundary",
    ],
  });
  await vi.waitFor(() => expect(started).toEqual(["flow", "native"]));

  flow.resolve();
  await Promise.resolve();
  expect(started).toEqual(["flow", "native"]);

  native.resolve();
  await vi.waitFor(() => expect(started).toContain("mcp-gateway-connect-startup-retry"));
  expect(started).toContain("voice-call-cli-rpc-agent-tool");
  expect(parallelScriptIds).toEqual([]);

  serial.resolve();
  await vi.waitFor(() => expect(parallelScriptIds).toHaveLength(3));

  parallel.resolve();
  await runPromise;
  expect(prepareDockerE2eEnvironment).toHaveBeenCalledTimes(1);
  expect(scriptEnvs.every((env) => env === preparedEnv)).toBe(true);
  expect(parallelScriptIds.slice(0, 3)).toEqual(
    expect.arrayContaining(["remote-log-tailing", "gateway-smoke", "logging-file-boundary"]),
  );
  expect(parallelScriptIds[3]).toBe("diagnostic-events-boundary");
  expect(parallelWork.activity.maxActive).toBe(3);
});

it("carries the actual prepared Docker receipt through aggregate native delegation", async () => {
  const docker = await vi.importActual<typeof import("./test-file-scenario-docker-batch.js")>(
    "./test-file-scenario-docker-batch.js",
  );
  prepareDockerE2eEnvironment.mockImplementationOnce((params) =>
    docker.prepareDockerE2eEnvironment({
      ...params,
      runCommand: (command) =>
        writeDockerCandidateManifest(command, {
          schema: "openclaw.qa-docker-candidate/v1",
          schemaVersion: 1,
          sourceSha: "a".repeat(40),
          candidate: {
            package: {
              path: path.join(repoRoot, "candidate.tgz"),
              name: "openclaw",
              version: "2026.8.1",
              sha256: "b".repeat(64),
            },
            registry: null,
          },
        }),
    }),
  );
  const command = vi.fn(async (params: QaScenarioCommandExecution) => {
    const lane = "npm-onboard-channel-agent";
    expect(params.env.OPENCLAW_DOCKER_ALL_LANES).toBe(lane);
    await fs.writeFile(
      path.join(params.env.OPENCLAW_DOCKER_ALL_LOG_DIR!, "summary.json"),
      JSON.stringify({
        failures: [],
        selectedLanes: [lane],
        lanes: [{ name: lane, status: 0, elapsedSeconds: 1 }],
      }),
    );
    return { exitCode: 0, stdout: "completed", stderr: "" };
  });
  runQaTestFileScenarios.mockImplementationOnce((params) => runNative(params, command));
  const result = await runSuite({ scenarioIds: [ids.docker] });
  expect(prepareDockerE2eEnvironment).toHaveBeenCalledTimes(1);
  expect(command).toHaveBeenCalledTimes(1);
  const evidence = await readEvidence(result.result.evidencePath);
  const passed = runQaTestFileScenarios.mock.calls[0]![0].preparedDockerEvidence;
  expect(passed).toBeDefined();
  const receipts = evidence.occurrences.flatMap((occurrence) => occurrence.receipts);
  const receipt = receipts.find((candidate) => candidate.id === passed!.receipt.id)!;
  expect(receipt).toEqual(passed!.receipt);
  expect(receipt).toMatchObject({
    phase: "prepared",
    identity: {
      source: { ref: "a".repeat(40), integrity: null },
      runtime: { id: null, version: null },
      package: { kind: "npm-tarball", integrity: `sha256:${"b".repeat(64)}` },
      protocol: null,
      accountRef: null,
      proofClass: null,
    },
  });
  await expectReceiptHashes(evidence, (file) => resolveQaArtifactPath(repoRoot, repoRoot, file));
  expect(outcomeStatuses(evidence)).toEqual(["pass"]);
});

it("records Docker preparation failure without starting a script partition", async () => {
  prepareDockerE2eEnvironment.mockRejectedValueOnce(new Error("candidate pack failed"));
  const result = await runQaSuite({ repoRoot, scenarioIds: [ids.docker, "gateway-smoke"] });

  expect(runQaTestFileScenarios).not.toHaveBeenCalled();
  expect(result.result.scenarios).toHaveLength(2);
  expect(result.result.scenarios).toContainEqual(
    expect.objectContaining({
      status: "fail",
      details: expect.stringContaining("candidate pack failed"),
    }),
  );
});

it("reuses the prepared Docker env object when a script partition retries", async () => {
  prepareDockerE2eEnvironment.mockResolvedValueOnce(preparedEnv);
  runQaTestFileScenarios
    .mockRejectedValueOnce(new QaSuiteInfraError("transport_ready_timeout", "retry"))
    .mockImplementationOnce(passNative);

  await runQaSuite({ repoRoot, scenarioIds: [ids.docker] });

  expect(runQaTestFileScenarios).toHaveBeenCalledTimes(2);
  expect(runQaTestFileScenarios.mock.calls.map(([params]) => params.env)).toEqual([
    preparedEnv,
    preparedEnv,
  ]);
});

it("serializes every fail-fast script and stops before post-failure work", async () => {
  const first = Promise.withResolvers<void>();
  const started: string[] = [];
  prepareDockerE2eEnvironment.mockResolvedValueOnce(preparedEnv);
  const tracked = trackActivity(async (params: NativeParams) => {
    const scenario = params.scenarios[0];
    assert.ok(scenario, "expected one script scenario");
    started.push(scenario.id);
    if (scenario.id === "remote-log-tailing") {
      await first.promise;
    }
    return await passNative(
      params,
      scenario.id === ids.docker ? "fail" : "pass",
      scenario.id === ids.docker ? "serial owner failed" : undefined,
    );
  });
  runQaTestFileScenarios.mockImplementation(tracked.run);

  const runPromise = runSuite({
    concurrency: 8,
    failFast: true,
    scenarioIds: ["remote-log-tailing", ids.docker, "gateway-smoke"],
  });
  await vi.waitFor(() => expect(started).toEqual(["remote-log-tailing"]));
  expect(tracked.activity.maxActive).toBe(1);

  first.resolve();
  await runPromise;
  expect(started).toEqual(["remote-log-tailing", ids.docker]);
  expect(tracked.activity.maxActive).toBe(1);
  expect(runQaTestFileScenarios).toHaveBeenCalledTimes(2);
  expect(runQaTestFileScenarios.mock.calls.every(([params]) => params.env === preparedEnv)).toBe(
    true,
  );
  expect(runQaTestFileScenarios).toHaveBeenLastCalledWith(
    expect.objectContaining({ failFast: true }),
  );
});

it("starts native suite proof before isolated flow work fills the weighted queue", async () => {
  const shared = blockNext(runQaFlowSuite, passFlow);
  const testFile = blockNext(runQaTestFileScenarios, passNative);

  const runPromise = runSuite({ concurrency: 2, scenarioIds: [ids.dm, ids.group, ids.ui] });
  await Promise.all([shared.started, testFile.started]);
  await Promise.resolve();

  expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
  expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);

  testFile.release();
  shared.release();
  await runPromise;

  expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
});

it("waits for already-started partitions before recording a unified failure", async () => {
  const priorArtifactPaths = artifactFileNames.map((name) => path.join(suiteOutputDir, name));
  await fs.mkdir(suiteOutputDir, { recursive: true });
  await Promise.all(priorArtifactPaths.map((artifactPath) => fs.writeFile(artifactPath, "stale")));
  const testFile = blockNext(runQaTestFileScenarios, passNative);
  runQaFlowSuite.mockRejectedValueOnce(
    new Error("flow partition failed", {
      cause: Object.assign(new Error("unrelated capacity failure"), {
        code: "POOL_EXHAUSTED",
      }),
    }),
  );
  const runPromise = runSuite({ concurrency: 2, scenarioIds: [ids.baseline, ids.ui] });
  let completed = false;
  void runPromise.then(() => {
    completed = true;
  });
  await testFile.started;
  await Promise.resolve();

  expect(completed).toBe(false);
  for (const artifactPath of priorArtifactPaths) {
    await expect(fs.access(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
  }

  testFile.release();
  const result = await runPromise;
  expect(completed).toBe(true);
  expect(result.result.scenarios).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        status: "fail",
        details: expect.stringContaining("suite partition failed: flow partition failed"),
      }),
      expect.objectContaining({ status: "pass" }),
    ]),
  );
  const summary = await readSummary(result.result.summaryPath);
  expect(summary.counts).toMatchObject({ total: 2, passed: 1, failed: 1 });
  await fs.access(result.result.evidencePath);
  await fs.access(result.result.reportPath);
});

it("reuses unavailable channel credential evidence across serial partitions", async () => {
  const poolError = Object.assign(new Error("no WhatsApp credential is available"), {
    code: "POOL_EXHAUSTED",
  });
  runQaFlowSuite.mockRejectedValueOnce(
    new Error("failed to create QA transport live:whatsapp: credential acquire failed", {
      cause: new Error("credential acquire timed out", { cause: poolError }),
    }),
  );

  const result = await runSuite({
    providerMode: "mock-openai",
    channelDriver: "live",
    adapterFactories: [{ id: "whatsapp", matches: () => true, create: vi.fn() }],
    scenarioIds: [ids.whatsappStatus, ids.whatsappOpen, ids.ui],
  });

  expect(result.executionKind).toBe("suite");
  expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
  expect(result.result.scenarios.slice(0, 2)).toMatchObject([
    { status: "fail", details: expect.stringContaining("channel credential unavailable") },
    { status: "fail", details: expect.stringContaining("channel credential unavailable") },
  ]);
  const evidence = await readEvidence(result.result.evidencePath);
  for (const scenarioId of [ids.whatsappStatus, ids.whatsappOpen]) {
    const blocked = evidence.entries?.find((entry) => entry.test?.id === scenarioId);
    expect(blocked).toMatchObject({
      execution: { channel: { id: "whatsapp", live: false } },
      result: { status: "blocked" },
    });
    expect(blocked?.execution?.channel?.driver).toBeUndefined();
    expect(result.observedCells).not.toContainEqual({
      scenarioId,
      executionKind: "flow",
      channel: "whatsapp",
    });
  }
});

it("rejects runtime-pair requests for Vitest/Playwright scenarios", async () => {
  await expect(
    runQaSuite({
      repoRoot: process.cwd(),
      runtimePair: ["openclaw", "codex"],
      scenarioIds: [ids.ui],
    }),
  ).rejects.toThrow("--runtime-pair requires execution.kind: flow scenarios");

  expect(runQaFlowSuite).not.toHaveBeenCalled();
  expect(runQaTestFileScenarios).not.toHaveBeenCalled();
});

it("rejects repo-local symlink output directories before running Vitest/Playwright scenarios", async () => {
  const outsideRoot = await makeTempRepo("qa-suite-symlink-outside-");
  await fs.symlink(outsideRoot, path.join(repoRoot, "artifacts-link"));

  await expect(
    runSuite({ outputDir: "artifacts-link/qa-out", scenarioIds: [ids.ui] }),
  ).rejects.toThrow("QA suite outputDir must not traverse symlinks");

  expect(runQaFlowSuite).not.toHaveBeenCalled();
  expect(runQaTestFileScenarios).not.toHaveBeenCalled();
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
