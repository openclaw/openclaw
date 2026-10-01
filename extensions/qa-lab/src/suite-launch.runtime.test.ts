import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveQaArtifactPath } from "./cli-paths.js";
import { QaSuiteInfraError } from "./errors.js";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import {
  getEffectiveQaEvidenceEntries,
  projectQaEvidenceScenarioOutcomes,
  validateQaEvidenceSummaryJson,
  type QaEvidenceSummaryV3Json,
} from "./evidence-summary.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import * as scenarioCatalog from "./scenario-catalog.js";
import type { QaTestFileScenario } from "./scenario-catalog.js";
import { writeQaSuiteArtifacts } from "./suite-artifacts.js";
import { createQaSuiteEvidenceInvocation } from "./suite-evidence.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteRunParams, QaSuiteScenarioResult } from "./suite.js";
import {
  makeTestFileScenario,
  resolveScriptAttemptOutputDir,
  writeDockerCandidateManifest,
  writeNativeVitestReport,
} from "./test-file-scenario-runner.test-support.js";

const {
  crablineRuntimeLoads,
  prepareDockerE2eEnvironment,
  replaceFileAtomicMock,
  runPluginCommandWithTimeout,
  runQaFlowSuite,
  runQaTestFileScenarios,
} = vi.hoisted(() => ({
  crablineRuntimeLoads: vi.fn(),
  prepareDockerE2eEnvironment: vi.fn(),
  replaceFileAtomicMock: vi.fn(),
  runPluginCommandWithTimeout: vi.fn(),
  runQaFlowSuite: vi.fn(),
  runQaTestFileScenarios: vi.fn(),
}));

vi.mock("@openclaw/crabline", async (importOriginal) => {
  crablineRuntimeLoads();
  return await importOriginal<typeof import("@openclaw/crabline")>();
});

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

const tempRoots: string[] = [];

async function readEvidence(filePath: string) {
  const evidence = validateQaEvidenceSummaryJson(JSON.parse(await fs.readFile(filePath, "utf8")));
  if (evidence.schemaVersion !== 3) {
    throw new Error("expected aggregate v3 evidence");
  }
  return evidence;
}

function createLab(setScenarioRun: QaLabServerHandle["setScenarioRun"]) {
  return {
    baseUrl: "http://127.0.0.1:43124",
    listenUrl: "http://127.0.0.1:43124",
    runSelfCheck: vi.fn(),
    setControlUi: vi.fn(),
    setLatestReport: vi.fn(),
    setScenarioRun: vi.fn(setScenarioRun),
    state: {} as QaLabServerHandle["state"],
    stop: vi.fn(),
  } satisfies QaLabServerHandle;
}

async function makeTempRepo(prefix: string) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(repoRoot);
  return repoRoot;
}

async function writeEvidence(pathLocal: string, writeFile = true) {
  const evidence = {
    kind: "openclaw.qa.evidence-summary",
    schemaVersion: 2,
    generatedAt: "2026-06-14T00:00:00.000Z",
    evidenceMode: "full",
    entries: [],
  };
  if (writeFile) {
    await fs.mkdir(path.dirname(pathLocal), { recursive: true });
    await fs.writeFile(pathLocal, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
  return evidence;
}

function requireDefaultQaFlowSuiteImplementation() {
  const implementation = runQaFlowSuite.getMockImplementation();
  if (!implementation) {
    throw new Error("expected default QA flow suite mock implementation");
  }
  return implementation;
}

function requireDefaultQaTestFileImplementation() {
  const implementation = runQaTestFileScenarios.getMockImplementation();
  if (!implementation) {
    throw new Error("expected default QA test-file mock implementation");
  }
  return implementation;
}

function blockNextQaFlowSuite() {
  const implementation = requireDefaultQaFlowSuiteImplementation();
  const started = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  runQaFlowSuite.mockImplementationOnce(async (params) => {
    started.resolve();
    await blocked.promise;
    return await implementation(params);
  });
  return { started: started.promise, release: blocked.resolve };
}

function blockNextQaTestFileRun() {
  const implementation = requireDefaultQaTestFileImplementation();
  const started = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  runQaTestFileScenarios.mockImplementationOnce(async (params) => {
    started.resolve();
    await blocked.promise;
    return await implementation(params);
  });
  return { started: started.promise, release: blocked.resolve };
}

async function runFailFastQaSuite(label: string, overrides: QaSuiteRunParams = {}) {
  return await runQaSuite({
    repoRoot: await makeTempRepo(`qa-suite-${label}-`),
    outputDir: `.artifacts/qa-e2e/${label}`,
    concurrency: 8,
    failFast: true,
    scenarioIds: [
      "dm-chat-baseline",
      "group-visible-reply-tool",
      "control-ui-chat-flow-playwright",
      "docker-npm-onboard-channel-agent",
    ],
    ...overrides,
  });
}

function trackMaxActiveFlowRuns() {
  const run = requireDefaultQaFlowSuiteImplementation();
  let active = 0;
  let maxActive = 0;
  runQaFlowSuite.mockImplementation(async (params) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
    try {
      return await run(params);
    } finally {
      active -= 1;
    }
  });
  return () => maxActive;
}

function mockFlowPartitionFailures(failuresByScenarioId: ReadonlyMap<string, readonly Error[]>) {
  const run = requireDefaultQaFlowSuiteImplementation();
  const attempts = new Map<string, number>();
  runQaFlowSuite.mockImplementation(async (params) => {
    const scenarioId = params?.scenarioIds?.[0];
    if (!scenarioId) {
      throw new Error("expected one scenario per flow partition");
    }
    const attempt = (attempts.get(scenarioId) ?? 0) + 1;
    attempts.set(scenarioId, attempt);
    const failure = failuresByScenarioId.get(scenarioId)?.[attempt - 1];
    if (failure) {
      throw failure;
    }
    return await run(params);
  });
  return attempts;
}

async function expectArtifactPublicationFailurePreservesPrior(params: {
  canonicalFileNames: readonly string[];
  failedFileName: string;
  outputDir: string;
  publish: () => Promise<unknown>;
}) {
  const sentinels = new Map(
    params.canonicalFileNames.map((fileName) => [fileName, `prior ${fileName}\n`]),
  );
  await fs.mkdir(params.outputDir, { recursive: true, mode: 0o750 });
  await fs.chmod(params.outputDir, 0o750);
  for (const [fileName, sentinel] of sentinels) {
    const finalPath = path.join(params.outputDir, fileName);
    await fs.writeFile(finalPath, sentinel, { encoding: "utf8", mode: 0o640 });
    await fs.chmod(finalPath, 0o640);
  }
  const actualSecurityRuntime = await vi.importActual<
    typeof import("openclaw/plugin-sdk/security-runtime")
  >("openclaw/plugin-sdk/security-runtime");
  const publicationOrder: string[] = [];
  const failSelectedArtifact = async (options: Parameters<typeof replaceFileAtomicMock>[0]) => {
    publicationOrder.push(path.basename(options.filePath));
    return await actualSecurityRuntime.replaceFileAtomic({
      ...options,
      ...(path.basename(options.filePath) === params.failedFileName
        ? {
            beforeRename: async ({ tempPath }: { tempPath: string }) => {
              await fs.writeFile(tempPath, "partial replacement\n", "utf8");
              throw Object.assign(new Error("injected QA artifact publication failure"), {
                code: "EIO",
              });
            },
          }
        : {}),
    });
  };

  await replaceFileAtomicMock.withImplementation(failSelectedArtifact, async () => {
    await expect(params.publish()).rejects.toMatchObject({ code: "EIO" });
  });

  const selectedPath = path.join(params.outputDir, params.failedFileName);
  await expect(fs.readFile(selectedPath, "utf8")).resolves.toBe(
    sentinels.get(params.failedFileName),
  );
  if (process.platform !== "win32") {
    expect((await fs.stat(selectedPath)).mode & 0o777).toBe(0o640);
    expect((await fs.stat(params.outputDir)).mode & 0o7777).toBe(0o750);
  }
  const selectedIndex = params.canonicalFileNames.indexOf(params.failedFileName);
  expect(publicationOrder).toEqual(params.canonicalFileNames.slice(0, selectedIndex + 1));
  expect(
    (await fs.readdir(params.outputDir)).filter((entry) =>
      entry.startsWith(`${params.failedFileName}.qa-artifact.`),
    ),
  ).toEqual([]);
}

describe("qa suite runtime launcher", () => {
  beforeEach(() => {
    replaceFileAtomicMock.mockClear();
    runQaFlowSuite.mockReset();
    runQaTestFileScenarios.mockReset();
    prepareDockerE2eEnvironment.mockReset();
    prepareDockerE2eEnvironment.mockResolvedValue(undefined);
    runPluginCommandWithTimeout.mockReset();
    runPluginCommandWithTimeout.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    runQaFlowSuite.mockImplementation(
      async (
        params:
          | { outputDir?: string; scenarioIds?: string[]; writeEvidenceFile?: boolean }
          | undefined,
      ) => {
        const outputDir = params?.outputDir ?? "/tmp/qa-flow";
        const evidencePath = path.join(outputDir, "qa-evidence.json");
        const evidence = await writeEvidence(evidencePath, params?.writeEvidenceFile);
        const scenarioIds = params?.scenarioIds ?? ["channel-chat-baseline"];
        return {
          evidence,
          outputDir,
          evidencePath,
          reportPath: path.join(outputDir, "qa-suite-report.md"),
          summaryPath: path.join(outputDir, "qa-suite-summary.json"),
          report: "# QA Suite Report\n",
          scenarios: scenarioIds.map((scenarioId) => ({
            name: scenarioId,
            status: "pass",
            steps: [],
          })),
          startedScenarioIds: scenarioIds,
          watchUrl: "http://127.0.0.1:43124",
        };
      },
    );
    runQaTestFileScenarios.mockImplementation(
      async (params: {
        outputDir: string;
        scenarios: Array<{ id: string; execution: { kind: "script" | "vitest" | "playwright" } }>;
        writeEvidenceFile?: boolean;
      }) => {
        const [scenario] = params.scenarios;
        if (!scenario) {
          throw new Error("expected scenario");
        }
        const evidencePath = path.join(params.outputDir, "qa-evidence.json");
        const evidence = await writeEvidence(evidencePath, params.writeEvidenceFile);
        return {
          evidence,
          outputDir: params.outputDir,
          executionKind: scenario.execution.kind,
          evidencePath,
          results: params.scenarios.map((scenarioItem) => ({
            durationMs: 1,
            logPath: path.join(params.outputDir, `${scenarioItem.id}.log`),
            scenario: scenarioItem,
            status: "pass",
          })),
        };
      },
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(
      tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("preserves interleaved repeated requests through the real native invocation boundary", async () => {
    const repoRoot = await makeTempRepo("qa-aggregate-interleaved-");
    const first = {
      ...makeTestFileScenario("vitest", "test/first.test.ts"),
      id: "first",
    };
    const second = {
      ...makeTestFileScenario("vitest", "test/second.test.ts"),
      id: "second",
    };

    const native = await vi.importActual<typeof import("./test-file-scenario-runner.js")>(
      "./test-file-scenario-runner.js",
    );
    let calls = 0;
    runQaTestFileScenarios.mockImplementation(
      async (params) =>
        await native.runQaTestFileScenarios({
          ...params,
          runCommand: async (command) => {
            calls += 1;
            await writeNativeVitestReport(command, { passed: 1 });
            return { exitCode: calls === 2 ? 7 : 0, stdout: `native ${calls}\n`, stderr: "" };
          },
        }),
    );
    const result = await runQaSuite({
      scenarioDefinitions: [first, second],
      repoRoot,
      outputDir: "out",
      scenarioIds: ["first", "second", "first"],
    });
    const evidence = await readEvidence(result.result.evidencePath);
    const outcomes = projectQaEvidenceScenarioOutcomes(evidence);
    expect(calls).toBe(3);
    expect(outcomes.map((outcome) => outcome.scenarioId)).toEqual(["first", "second", "first"]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["pass", "fail", "pass"]);
    expect(new Set(outcomes.map((outcome) => outcome.scenarioInstanceId)).size).toBe(3);
    expect(new Set(outcomes.map((outcome) => outcome.occurrenceId)).size).toBe(3);
    expect(result.result.scenarios.map((scenario) => scenario.evidenceOccurrenceId)).toEqual(
      outcomes.map((outcome) => outcome.occurrenceId),
    );
    const logs = evidence.occurrences.flatMap((occurrence) =>
      occurrence.receipts.map((receipt) => receipt.artifact),
    );
    expect(new Set(logs.map((artifact) => artifact.path)).size).toBe(3);
    for (const [index, artifact] of logs.entries()) {
      const bytes = await fs.readFile(resolveQaArtifactPath(repoRoot, repoRoot, artifact.path));
      expect(bytes.toString()).toContain(`native ${index + 1}`);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
    }
  });

  it("retains open comparison completion before a later child observation in the aggregate", async () => {
    const repoRoot = await makeTempRepo("qa-aggregate-open-comparison-");
    const flow = makeQaSuiteTestScenario("flow");
    const native = makeTestFileScenario("vitest", "test/native.test.ts");

    const nativeRunner = await vi.importActual<typeof import("./test-file-scenario-runner.js")>(
      "./test-file-scenario-runner.js",
    );
    runQaTestFileScenarios.mockImplementation(async (params) =>
      nativeRunner.runQaTestFileScenarios({
        ...params,
        runCommand: async (command) => {
          await writeNativeVitestReport(command, { passed: 1 });
          return { exitCode: 0, stdout: "native passed", stderr: "" };
        },
      }),
    );
    const defaultFlow = requireDefaultQaFlowSuiteImplementation();
    let expected: QaEvidenceSummaryV3Json | undefined;
    runQaFlowSuite.mockImplementation(async (params: QaSuiteRunParams) => {
      const base = await defaultFlow(params);
      const child = createQaEvidenceInvocation({
        scenarios: [flow],
        channel: params.evidenceAnchors![0]!.parentCell!.channel,
        launch: params.evidenceAnchors![0]!.launch,
        anchors: params.evidenceAnchors,
        continuation: params.evidenceContinuation,
      });
      const snapshot = () => child.snapshot({ generatedAt: "2026-09-13T00:00:00.000Z" });
      const rows = [
        {
          test: { kind: "qa-scenario", id: flow.id, title: flow.title },
          coverage: [],
          result: { status: "pass" as const },
        },
      ];
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
    const result = await runQaSuite({
      scenarioDefinitions: [flow, native],
      repoRoot,
      outputDir: "out",
      scenarioIds: [flow.id, native.id],
    });
    const evidence = await readEvidence(result.result.evidencePath);
    if (!expected) {
      throw new Error("expected child and aggregate v3 evidence");
    }
    for (const occurrence of expected.occurrences) {
      expect(evidence.occurrences.find((item) => item.id === occurrence.id)).toEqual(occurrence);
    }
    expect(projectQaEvidenceScenarioOutcomes(evidence).map((item) => item.status)).toEqual([
      "pass",
      "pass",
    ]);
  });

  it("keeps retained multi-instance script bundles inside repeated outer aggregate instances", async () => {
    const repoRoot = await makeTempRepo("qa-aggregate-child-bundles-");
    const script = makeTestFileScenario("script", "scripts/producer.mjs");
    const nativeScenario = makeTestFileScenario("vitest", "test/native.test.ts");

    const native = await vi.importActual<typeof import("./test-file-scenario-runner.js")>(
      "./test-file-scenario-runner.js",
    );
    const capturedChildren: QaEvidenceSummaryV3Json[] = [];
    runQaTestFileScenarios.mockImplementation(async (params) =>
      native.runQaTestFileScenarios({
        ...params,
        runCommand: async (command) => {
          if (command.args.includes("--artifact-base")) {
            const child = createQaEvidenceInvocation({
              scenarios: [script, script],
              channel: null,
              launch: params.evidenceAnchors[0].launch,
            });
            const id = child.begin(0);
            child.complete(id, {
              status: "pass",
              entries: [
                {
                  test: { kind: "script", id: "child", title: "Child" },
                  coverage: [],
                  result: { status: "pass" },
                },
              ],
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
        },
      }),
    );
    const result = await runQaSuite({
      scenarioDefinitions: [script, nativeScenario],
      repoRoot,
      outputDir: "out",
      scenarioIds: [script.id, nativeScenario.id, script.id],
    });
    const evidence = await readEvidence(result.result.evidencePath);
    expect(capturedChildren).toHaveLength(2);
    const outcomes = projectQaEvidenceScenarioOutcomes(evidence);
    expect(outcomes.map((item) => item.scenarioId)).toEqual([
      script.id,
      nativeScenario.id,
      script.id,
    ]);
    expect(outcomes.map((item) => item.status)).toEqual(["blocked", "pass", "blocked"]);
    expect(result.result.scenarios.map((item) => item.evidenceOccurrenceId)).toEqual(
      outcomes.filter((item) => item.occurrenceId !== null).map((item) => item.occurrenceId),
    );
    for (const child of capturedChildren) {
      expect(projectQaEvidenceScenarioOutcomes(child).map((item) => item.status)).toEqual([
        "pass",
        null,
      ]);
      for (const occurrence of child.occurrences) {
        expect(evidence.occurrences.find((item) => item.id === occurrence.id)).toEqual(occurrence);
      }
    }
  });

  it("projects only started root flow instances before collapsing repeated execution cells", async () => {
    const repoRoot = await makeTempRepo("qa-flow-root-cells-");
    const first = makeQaSuiteTestScenario("first-flow");
    const second = makeQaSuiteTestScenario("second-flow");

    const defaultFlow = requireDefaultQaFlowSuiteImplementation();
    runQaFlowSuite.mockImplementation(async (params: QaSuiteRunParams) => {
      const base = await defaultFlow(params);
      expect(params.scenarioIds).toEqual([first.id, second.id, first.id]);
      const recorded = await createQaSuiteEvidenceInvocation(params, {
        repoRoot,
        outputDir: base.outputDir,
        selectedScenarios: [first, second, first],
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        transportId: "qa-channel",
      });
      const id = recorded.invocation.begin(0);
      const result = await recorded.record(0, id, {
        name: first.title,
        status: "fail",
        steps: [],
        details: "first failed",
      });
      return {
        ...base,
        evidence: recorded.snapshot(),
        scenarios: [result],
        startedScenarioIds: [first.id],
      };
    });
    const result = await runQaSuite({
      scenarioDefinitions: [first, second],
      repoRoot,
      outputDir: "out",
      scenarioIds: [first.id, second.id, first.id],
      failFast: true,
    });
    expect(result.expectedCells).toHaveLength(3);
    expect(result.observedCells).toEqual([
      {
        scenarioId: first.id,
        executionKind: "flow",
        channel: "qa-channel",
      },
    ]);
    if (result.executionKind !== "flow" || !result.result.evidence) {
      throw new Error("expected recorded flow evidence");
    }
    expect(
      projectQaEvidenceScenarioOutcomes(result.result.evidence).map((item) => item.status),
    ).toEqual(["fail", null, null]);
    expect(result.result.scenarios).toHaveLength(1);
  });

  it("retains child evidence but rejects a returned result from a foreign observation", async () => {
    const repoRoot = await makeTempRepo("qa-aggregate-foreign-result-");
    const scenario = makeTestFileScenario("vitest", "test/native.test.ts");

    const native = await vi.importActual<typeof import("./test-file-scenario-runner.js")>(
      "./test-file-scenario-runner.js",
    );
    runQaTestFileScenarios.mockImplementation(async (params) => {
      const result = await native.runQaTestFileScenarios({
        ...params,
        runCommand: async (command) => {
          await writeNativeVitestReport(command, { passed: 1 });
          return { exitCode: 0, stdout: "passed", stderr: "" };
        },
      });
      result.results[0]!.evidenceOccurrenceId = "foreign-observation";
      return result;
    });
    const result = await runQaSuite({
      scenarioDefinitions: [scenario],
      repoRoot,
      outputDir: "out",
      scenarioIds: [scenario.id],
    });
    expect(result.result.scenarios).toMatchObject([
      {
        status: "fail",
        details: expect.stringContaining("selected observation"),
      },
    ]);
    const evidence = await readEvidence(result.result.evidencePath);
    expect(evidence.entries.map((row) => row.result.status)).toEqual(["pass", "fail"]);
    expect(projectQaEvidenceScenarioOutcomes(evidence)[0]?.status).toBe("fail");
  });

  it("retains all legacy rows once without guessing ambiguous instance owners", async () => {
    const repoRoot = await makeTempRepo("qa-aggregate-legacy-owners-");
    const first = { ...makeTestFileScenario("vitest", "test/first.test.ts"), id: "first" };
    const second = { ...makeTestFileScenario("vitest", "test/second.test.ts"), id: "second" };

    const rows = ["first", "diagnostic", "second", "first"].map((id, index) => ({
      test: { id, kind: "fixture", title: `raw ${index}` },
      coverage: [],
      result: { status: index < 2 ? ("fail" as const) : ("pass" as const) },
    }));
    const legacy = {
      kind: "openclaw.qa.evidence-summary",
      schemaVersion: 2,
      generatedAt: "2026-06-14T00:00:00.000Z",
      evidenceMode: "full",
      entries: rows,
    };
    const before = JSON.stringify(legacy);
    const original = requireDefaultQaTestFileImplementation();
    runQaTestFileScenarios.mockImplementation(async (params) => ({
      ...(await original(params)),
      evidence: legacy,
    }));
    const result = await runQaSuite({
      scenarioDefinitions: [first, second],
      repoRoot,
      outputDir: "out",
      scenarioIds: ["first", "second", "first"],
    });
    const evidence = await readEvidence(result.result.evidencePath);
    expect(JSON.stringify(legacy)).toBe(before);
    expect(
      evidence.entries.map(({ binding: _binding, effective: _effective, ...row }) => row),
    ).toEqual(rows);
    const outcomes = projectQaEvidenceScenarioOutcomes(evidence);
    expect(outcomes.map((outcome) => outcome.scenarioId)).toEqual(["first", "second", "first"]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([null, "pass", null]);
    const unknown = evidence.occurrences.find((occurrence) => occurrence.scenario === null)!;
    expect(unknown).toMatchObject({ parentCell: null, terminalStatus: null, receipts: [] });
    expect(evidence.entries.map((entry) => entry.binding.occurrenceId)).toEqual([
      unknown.id,
      unknown.id,
      outcomes[1]!.occurrenceId,
      unknown.id,
    ]);
    expect(getEffectiveQaEvidenceEntries(evidence)).toHaveLength(4);
  });

  it("keeps Crabline out of unrelated live transport startup", async () => {
    expect(crablineRuntimeLoads).not.toHaveBeenCalled();

    await runQaSuite({
      repoRoot: process.cwd(),
      providerMode: "mock-openai",
      channelDriver: "live",
      channelId: "telegram",
      scenarioIds: ["channel-chat-baseline"],
    });

    expect(crablineRuntimeLoads).not.toHaveBeenCalled();
  });

  it("continues actual passing flow observations after infrastructure failure", async () => {
    const repoRoot = await makeTempRepo("qa-flow-continuation-");
    const outputDir = path.join(repoRoot, "output");
    const scenario = makeQaSuiteTestScenario("channel-chat-baseline");
    const snapshots: QaEvidenceSummaryV3Json[] = [];
    const original = requireDefaultQaFlowSuiteImplementation();
    const retained = new Map<string, Buffer>();
    let attempts = 0;
    runQaFlowSuite.mockImplementation(async (params: QaSuiteRunParams) => {
      const result = await original(params);
      const recording = await createQaSuiteEvidenceInvocation(params, {
        repoRoot,
        outputDir,
        selectedScenarios: [scenario],
        providerMode: "mock-openai",
        primaryModel: "mock-openai/test-model",
        transportId: "qa-channel",
      });
      const selected = await recording.record(0, recording.invocation.begin(0), {
        name: scenario.title,
        status: "pass",
        details: `attempt ${++attempts}`,
        steps: [],
      });
      if (attempts === 1) {
        for (const occurrence of recording.snapshot().occurrences) {
          for (const receipt of occurrence.receipts) {
            const artifactPath = path.resolve(outputDir, receipt.artifact.path);
            retained.set(artifactPath, await fs.readFile(artifactPath));
          }
        }
        throw new QaSuiteInfraError("agent_wait_failed", "infrastructure after result");
      }
      return { ...result, scenarios: [selected], evidence: recording.snapshot() };
    });
    const result = await runQaSuite({
      repoRoot,
      outputDir,
      providerMode: "mock-openai",
      scenarioIds: [scenario.id],
      onEvidence: (summary) => snapshots.push(structuredClone(summary)),
    });
    expect(result.executionKind).toBe("flow");
    if (result.executionKind !== "flow") {
      throw new Error("expected flow result");
    }
    const evidence = result.result.evidence as QaEvidenceSummaryV3Json;
    expect(attempts).toBe(2);
    expect(snapshots).toHaveLength(4);
    expect(new Set(snapshots.map((snapshot) => snapshot.occurrences[0]!.id)).size).toBe(1);
    expect(evidence.entries.map((entry) => entry.result.status)).toEqual(["pass", "pass"]);
    expect(evidence.entries.map((entry) => entry.effective)).toEqual([true, true]);
    expect(
      evidence.occurrences.filter((occurrence) => occurrence.terminalStatus === "fail"),
    ).toHaveLength(0);
    expect(projectQaEvidenceScenarioOutcomes(evidence)).toEqual([
      expect.objectContaining({
        scenarioId: scenario.id,
        occurrenceId: result.result.scenarios[0]!.evidenceOccurrenceId,
        status: "pass",
      }),
    ]);
    for (const [artifactPath, bytes] of retained) {
      expect(await fs.readFile(artifactPath)).toEqual(bytes);
    }
  });

  it("retains one default output root when a failed flow attempt retries as skipped", async () => {
    const repoRoot = await makeTempRepo("qa-flow-default-retry-");
    const scenario = makeQaSuiteTestScenario("channel-chat-baseline");
    const original = requireDefaultQaFlowSuiteImplementation();
    const roots: string[] = [];
    let firstResult: QaSuiteScenarioResult | undefined;
    let firstBytes: Buffer | undefined;
    let firstPath: string | undefined;
    runQaFlowSuite.mockImplementation(async (params: QaSuiteRunParams) => {
      const result = await original(params);
      const outputDir = params.outputDir!;
      roots.push(outputDir);
      const recording = await createQaSuiteEvidenceInvocation(params, {
        repoRoot,
        outputDir,
        selectedScenarios: [scenario],
        providerMode: "mock-openai",
        primaryModel: "mock-openai/test-model",
        transportId: "qa-channel",
      });
      const selected = await recording.record(0, recording.invocation.begin(0), {
        name: scenario.title,
        status: roots.length === 1 ? "fail" : "skip",
        details: roots.length === 1 ? "original failure" : "retry result",
        steps: [],
      });
      if (roots.length === 1) {
        firstResult = selected;
        const receipt = recording.snapshot().occurrences.flatMap((item) => item.receipts)[0]!;
        firstPath = path.resolve(outputDir, receipt.artifact.path);
        firstBytes = await fs.readFile(firstPath);
        throw new QaSuiteInfraError("agent_wait_failed", "infrastructure after failure");
      }
      return { ...result, scenarios: [selected], evidence: recording.snapshot() };
    });
    const result = await runQaSuite({
      repoRoot,
      providerMode: "mock-openai",
      scenarioIds: [scenario.id],
    });
    if (result.executionKind !== "flow") {
      throw new Error("expected flow result");
    }
    expect(roots).toHaveLength(2);
    expect(roots[0]).toBe(roots[1]);
    expect(result.result.outputDir).toBe(roots[0]);
    expect(await fs.readdir(path.join(repoRoot, ".artifacts", "qa-e2e"))).toHaveLength(1);
    const evidence = result.result.evidence as QaEvidenceSummaryV3Json;
    const outcomes = projectQaEvidenceScenarioOutcomes(evidence);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe("fail");
    expect(evidence.entries.map((entry) => entry.effective)).toEqual([true, false]);
    expect(result.result.scenarios[0]).toEqual(firstResult);
    expect(await fs.readFile(firstPath!)).toEqual(firstBytes);
    for (const occurrence of evidence.occurrences) {
      for (const receipt of occurrence.receipts) {
        const bytes = await fs.readFile(
          path.resolve(result.result.outputDir, receipt.artifact.path),
        );
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(receipt.artifact.sha256);
      }
    }
  });

  it("runs runtime-specific channel scenarios in dedicated workers", async () => {
    const repoRoot = await makeTempRepo("qa-suite-live-runtime-");
    await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/live-runtime",
      channelDriver: "live",
      channelId: "slack",
      concurrency: 4,
      scenarioIds: ["slack-canary", "slack-codex-approval-exec-native"],
    });

    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "live-runtime", "flow");
    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
    expect(runQaFlowSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDir: path.join(outputDir, "isolated"),
        forcedRuntime: undefined,
        scenarioIds: ["slack-canary"],
      }),
    );
    expect(runQaFlowSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDir: path.join(outputDir, "runtime-codex-1"),
        forcedRuntime: "codex",
        scenarioIds: ["slack-codex-approval-exec-native"],
      }),
    );
  });

  it("expands profile scenarios across every eligible pluggable channel", async () => {
    const repoRoot = await makeTempRepo("qa-suite-pluggable-channels-");
    const defaultFlowImplementation = requireDefaultQaFlowSuiteImplementation();
    runQaFlowSuite.mockImplementation(async (params) => {
      const result = await defaultFlowImplementation(params);
      if (params?.channelId === "matrix" && params.scenarioIds?.includes("thread-isolation")) {
        result.scenarios[0] = {
          ...result.scenarios[0],
          status: "fail",
        };
      }
      return result;
    });
    const adapterFactories = [
      {
        id: "portable-driver",
        matches: vi.fn(({ channelId }) => ["matrix", "slack", "telegram"].includes(channelId)),
        create: vi.fn(),
      },
    ];

    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/pluggable-channels",
      providerMode: "mock-openai",
      channelDriver: "live",
      adapterFactories,
      expandScenarioChannels: true,
      scenarioIds: [
        "channel-chat-baseline",
        "telegram-help-command",
        "matrix-restart-resume",
        "thread-isolation",
      ],
    });

    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "pluggable-channels");
    expect(runQaFlowSuite).toHaveBeenCalledTimes(5);
    for (const [channelId, partition, scenarioId] of [
      [undefined, "", "channel-chat-baseline"],
      ["telegram", "telegram", "telegram-help-command"],
      ["matrix", "matrix-isolated-1", "matrix-restart-resume"],
      ["slack", null, "thread-isolation"],
      ["matrix", "matrix-isolated-2", "thread-isolation"],
    ] as const) {
      expect(runQaFlowSuite).toHaveBeenCalledWith(
        expect.objectContaining({
          adapterFactories,
          channelId,
          ...(partition === null ? {} : { outputDir: path.join(outputDir, "flow", partition) }),
          scenarioIds: [scenarioId],
        }),
      );
    }
    expect(result.executionKind).toBe("suite");
    expect(result.result.scenarios.map((scenario) => scenario.name)).toContain(
      "thread-isolation [slack]",
    );
    expect(result.result.scenarios.map((scenario) => scenario.name)).toContain(
      "thread-isolation [matrix]",
    );
    expect(
      result.result.scenarios.find((scenario) => scenario.name === "thread-isolation [slack]"),
    ).toMatchObject({ status: "pass" });
    expect(
      result.result.scenarios.find((scenario) => scenario.name === "thread-isolation [matrix]"),
    ).toMatchObject({ status: "fail" });
    expect(result.observedCells).toEqual(
      expect.arrayContaining([
        { scenarioId: "channel-chat-baseline", executionKind: "flow", channel: null },
        { scenarioId: "telegram-help-command", executionKind: "flow", channel: "telegram" },
        { scenarioId: "matrix-restart-resume", executionKind: "flow", channel: "matrix" },
        { scenarioId: "thread-isolation", executionKind: "flow", channel: "slack" },
        { scenarioId: "thread-isolation", executionKind: "flow", channel: "matrix" },
      ]),
    );
  });

  it("retains captured child observations through an aggregate retry", async () => {
    const repoRoot = await makeTempRepo("qa-suite-recorded-partition-");
    const catalog = structuredClone(scenarioCatalog.readQaBootstrapScenarioCatalog());
    for (const scenario of catalog.scenarios) {
      scenario.assertions = [
        { id: "child-result", meaning: "the child owns its result", coverage: [] },
      ];
    }
    vi.spyOn(scenarioCatalog, "readQaBootstrapScenarioCatalog").mockReturnValue(catalog);
    const childIds = new Set<string>();
    const defaultFlow = requireDefaultQaFlowSuiteImplementation();
    const anchors: string[] = [];
    let attempts = 0;
    runQaFlowSuite.mockImplementation(async (params: QaSuiteRunParams) => {
      const base = await defaultFlow(params);
      const id = params.scenarioIds![0]!;
      const target = id === "telegram-help-command";
      if (target) {
        attempts += 1;
        anchors.push(params.evidenceAnchors![0]!.id);
      }
      const recording = await createQaSuiteEvidenceInvocation(params, {
        repoRoot,
        outputDir: params.outputDir!,
        selectedScenarios: [catalog.scenarios.find((scenario) => scenario.id === id)!],
        providerMode: "mock-openai",
        primaryModel: "mock-openai/test",
        transportId: "qa-channel",
      });
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
    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/recorded-partitions",
      providerMode: "mock-openai",
      channelDriver: "crabline",
      scenarioIds: ["telegram-help-command", "matrix-restart-resume"],
    });
    const evidence = await readEvidence(result.result.evidencePath);
    expect(evidence.schemaVersion).toBe(3);
    for (const occurrence of evidence.occurrences) {
      expect(occurrence.assertions).toEqual(
        childIds.has(occurrence.id)
          ? [{ id: "child-result", meaning: "the child owns its result", coverage: [] }]
          : null,
      );
    }
    expect(new Set(anchors).size).toBe(1);
    expect(anchors).toHaveLength(2);
    const outcomes = projectQaEvidenceScenarioOutcomes(evidence);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["pass", "pass"]);
    expect(result.result.scenarios.map((scenario) => scenario.status)).toEqual(
      outcomes.map((outcome) => outcome.status),
    );
    const observed = evidence.entries.filter((entry) => entry.test.id === "telegram-help-command");

    expect(observed.map((entry) => entry.result.status)).toEqual(["fail", "fail", "pass"]);
    expect(getEffectiveQaEvidenceEntries(evidence).map((entry) => entry.result.status)).toEqual([
      "pass",
      "pass",
    ]);
    const retries = evidence.occurrences.filter((occurrence) => occurrence.retryOf !== null);
    expect(retries).toHaveLength(2);
  });

  it("attributes an exhausted fail-fast retry to the later scenario that actually started", async () => {
    const repoRoot = await makeTempRepo("qa-suite-fail-fast-later-partition-failure-");
    const attempts = mockFlowPartitionFailures(
      new Map([
        [
          "thread-follow-up",
          [
            new QaSuiteInfraError("transport_ready_timeout", "second scenario readiness timed out"),
            new QaSuiteInfraError(
              "transport_ready_timeout",
              "second scenario readiness timed out again",
            ),
          ],
        ],
      ]),
    );

    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/fail-fast-later-partition-failure",
      providerMode: "mock-openai",
      concurrency: 2,
      failFast: true,
      scenarioIds: ["dm-chat-baseline", "thread-follow-up", "control-ui-chat-flow-playwright"],
    });

    expect(Object.fromEntries(attempts)).toEqual({
      "dm-chat-baseline": 1,
      "thread-follow-up": 2,
    });
    expect(runQaFlowSuite.mock.calls.map(([params]) => params?.scenarioIds)).toEqual([
      ["dm-chat-baseline"],
      ["thread-follow-up"],
      ["thread-follow-up"],
    ]);
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
    expect(result.executionKind).toBe("suite");
    expect(result.result.scenarios).toMatchObject([
      { name: "dm-chat-baseline", status: "pass" },
      {
        status: "fail",
        details: "suite partition failed: second scenario readiness timed out",
      },
    ]);
    const summary = JSON.parse(await fs.readFile(result.result.summaryPath, "utf8")) as {
      counts: { failed: number; passed: number; total: number };
    };
    expect(summary.counts).toMatchObject({ total: 2, passed: 1, failed: 1 });
    const evidence = await readEvidence(result.result.evidencePath);
    expect(evidence.entries).toMatchObject([
      {
        test: { id: "thread-follow-up" },
        result: {
          status: "fail",
          failure: { reason: "suite partition failed: second scenario readiness timed out" },
        },
        effective: true,
      },
      {
        test: { id: "thread-follow-up" },
        result: {
          status: "fail",
          failure: { reason: "suite partition failed: second scenario readiness timed out again" },
        },
        effective: false,
      },
    ]);
    await fs.access(result.result.reportPath);
  });

  it("runs distinct pluggable-driver channels within the global concurrency budget", async () => {
    const repoRoot = await makeTempRepo("qa-suite-pluggable-channel-concurrency-");
    const maxActive = trackMaxActiveFlowRuns();

    await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/pluggable-channel-concurrency",
      providerMode: "mock-openai",
      channelDriver: "live",
      adapterFactories: [{ id: "portable-driver", matches: vi.fn(), create: vi.fn() }],
      concurrency: 2,
      scenarioIds: ["telegram-help-command", "matrix-restart-resume"],
    });

    expect(maxActive()).toBe(2);
  });

  it("runs isolated same-channel adapter instances within the suite budget", async () => {
    const repoRoot = await makeTempRepo("qa-suite-pluggable-same-channel-concurrency-");
    const maxActive = trackMaxActiveFlowRuns();

    const isolatedScenarioId = "matrix-approval-channel-target-both";
    const sharedScenarioIds = [
      "matrix-approval-deny-reaction",
      "matrix-approval-exec-metadata-chunked",
      "matrix-approval-exec-metadata-single-event",
      "matrix-approval-plugin-metadata-single-event",
      "matrix-approval-thread-target",
    ];
    const scenarioIds = [isolatedScenarioId, ...sharedScenarioIds];
    await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/pluggable-same-channel-concurrency",
      providerMode: "mock-openai",
      channelDriver: "live",
      adapterFactories: [
        {
          id: "matrix",
          isolatesInstances: true,
          matches: ({ channelId, driver }) => driver === "live" && channelId === "matrix",
          create: vi.fn(),
        },
      ],
      concurrency: 6,
      scenarioIds,
    });

    expect(runQaFlowSuite).toHaveBeenCalledTimes(6);
    expect(runQaFlowSuite.mock.calls.map(([params]) => params?.scenarioIds)).toEqual([
      ...sharedScenarioIds.map((scenarioId) => [scenarioId]),
      [isolatedScenarioId],
    ]);
    expect(maxActive()).toBe(6);
  });

  it("partitions mixed Crabline legacy child evidence into one aggregate suite", async () => {
    const repoRoot = await makeTempRepo("qa-suite-crabline-channels-");
    const defaultFlowImplementation = requireDefaultQaFlowSuiteImplementation();
    runQaFlowSuite.mockImplementation(async (params) => {
      const result = await defaultFlowImplementation(params);
      const scenarioIds: readonly string[] = params?.scenarioIds ?? [];
      result.evidence = {
        kind: "openclaw.qa.evidence-summary",
        schemaVersion: 2,
        generatedAt: "2026-06-14T00:00:00.000Z",
        evidenceMode: "full",
        entries: scenarioIds.map((scenarioId) => ({
          test: {
            kind: "qa-scenario",
            id: scenarioId,
            title: scenarioId,
          },
          coverage: [],
          execution: {
            runner: "host",
            environment: {
              ref: null,
              os: "linux",
              nodeVersion: "v24.0.0",
            },
            provider: {
              id: "mock-openai",
              live: false,
              model: {
                name: "gpt-5.6-luna",
                ref: "mock-openai/gpt-5.6-luna",
              },
              fixture: "mock-openai",
            },
            channel: {
              id: params?.channelId ?? "qa-channel",
              live: false,
              driver: "crabline",
            },
            packageSource: {
              kind: "source-checkout",
            },
            artifacts: [
              {
                kind: "report",
                path: "qa-suite-report.md",
                source: "qa-suite",
              },
            ],
          },
          result: {
            status: "pass",
          },
        })),
      };
      return result;
    });
    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/crabline-channels",
      providerMode: "mock-openai",
      channelDriver: "crabline",
      scenarioIds: ["telegram-help-command", "matrix-restart-resume"],
    });

    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "crabline-channels");
    expect(result).toMatchObject({
      executionKind: "suite",
      result: {
        evidencePath: path.join(outputDir, "qa-evidence.json"),
        summaryPath: path.join(outputDir, "qa-suite-summary.json"),
      },
    });
    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
    for (const [index, [channelId, scenarioId]] of (
      [
        ["telegram", "telegram-help-command"],
        ["matrix", "matrix-restart-resume"],
      ] as const
    ).entries()) {
      expect(runQaFlowSuite).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({
          outputDir: path.join(outputDir, "flow", channelId),
          channelId,
          scenarioIds: [scenarioId],
        }),
      );
    }
    const summary = JSON.parse(
      await fs.readFile(path.join(outputDir, "qa-suite-summary.json"), "utf8"),
    ) as { run?: { channel?: unknown; channelDriver?: unknown; scenarioIds?: unknown } };
    expect(summary.run?.channelDriver).toBe("crabline");
    expect(summary.run?.channel).toBeNull();
    expect(summary.run?.scenarioIds).toEqual(["telegram-help-command", "matrix-restart-resume"]);
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(path.join(outputDir, "qa-evidence.json"), "utf8")),
    );
    expect(evidence.schemaVersion).toBe(3);
    expect(evidence.entries?.map((entry) => entry.execution?.artifacts?.[0]?.path)).toEqual([
      ".artifacts/qa-e2e/crabline-channels/flow/telegram/qa-suite-report.md",
      ".artifacts/qa-e2e/crabline-channels/flow/matrix/qa-suite-report.md",
    ]);
  });

  it("prepares a missing native runtime before marking the child prebuilt", async () => {
    const repoRoot = await makeTempRepo("qa-suite-prepared-vitest-");
    const aiRuntimePath = path.join(repoRoot, "packages/ai/dist/internal/runtime.mjs");
    runPluginCommandWithTimeout.mockImplementation(async ({ argv }) => {
      if (argv.includes("tsdown.ai.config.ts")) {
        await fs.mkdir(path.dirname(aiRuntimePath), { recursive: true });
        await fs.writeFile(aiRuntimePath, "export {};\n", "utf8");
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const defaultTestFileImplementation = requireDefaultQaTestFileImplementation();
    runQaTestFileScenarios.mockImplementationOnce(async (params) => {
      await expect(fs.stat(aiRuntimePath)).resolves.toBeDefined();
      return await defaultTestFileImplementation(params);
    });

    await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/prepared-vitest",
      scenarioIds: ["auth-profile-doctor-migration-safety"],
    });

    expect(runQaTestFileScenarios).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { OPENCLAW_E2E_USE_PREBUILT_DIST: "1" },
        outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "prepared-vitest", "vitest"),
      }),
    );
    expect(runQaTestFileScenarios.mock.calls[0]?.[0]).not.toHaveProperty("envMode");
    expect(runPluginCommandWithTimeout.mock.calls.map(([options]) => options.argv)).toEqual([
      [
        process.execPath,
        "--import",
        "tsx",
        "scripts/tsdown-build.mts",
        "--config",
        "tsdown.ai.config.ts",
      ],
    ]);
  });

  it("projects a skipped native producer as a skipped unified scenario", async () => {
    const repoRoot = await makeTempRepo("qa-suite-native-skip-");
    const defaultImplementation = requireDefaultQaTestFileImplementation();
    runQaTestFileScenarios.mockImplementationOnce(async (params) => {
      const result = await defaultImplementation(params);
      for (const row of result.results) {
        row.status = "skipped";
      }
      return result;
    });

    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/native-skip",
      scenarioIds: ["control-ui-chat-flow-playwright"],
    });
    expect(result.result.scenarios).toMatchObject([
      { name: "Control UI chat flow Playwright coverage", status: "skip" },
    ]);
    const summary = JSON.parse(await fs.readFile(result.result.summaryPath, "utf8")) as {
      counts: { failed: number; skipped: number };
    };
    expect(summary.counts).toMatchObject({ failed: 0, skipped: 1 });
    expect(runPluginCommandWithTimeout).not.toHaveBeenCalled();
  });

  it.each([{ kind: "summary", fileName: "qa-suite-summary.json" }])(
    "preserves the prior standard $kind artifact when atomic publication fails",
    async ({ fileName }) => {
      const outputDir = await makeTempRepo("qa-suite-standard-artifact-atomic-");
      await expectArtifactPublicationFailurePreservesPrior({
        canonicalFileNames: ["qa-suite-report.md", "qa-evidence.json", "qa-suite-summary.json"],
        failedFileName: fileName,
        outputDir,
        publish: async () =>
          await writeQaSuiteArtifacts({
            outputDir,
            startedAt: new Date("2026-08-12T00:00:00.000Z"),
            finishedAt: new Date("2026-08-12T00:01:00.000Z"),
            scenarios: [{ name: "Atomic publication", status: "pass", steps: [] }],
            scenarioDefinitions: [makeQaSuiteTestScenario("channel-chat-baseline")],
            transport: {
              id: "qa-channel",
              createReportNotes: () => [],
            } as unknown as QaTransportAdapter,
            providerMode: "mock-openai",
            primaryModel: "mock-openai/gpt-5.6-luna",
            alternateModel: "mock-openai/gpt-5.6-luna-alt",
            fastMode: true,
            concurrency: 1,
          }),
      });
    },
  );

  it("aggregates mixed-kind progress through the parent lab", async () => {
    const repoRoot = await makeTempRepo("qa-suite-mixed-progress-");
    const scenarioRuns: Array<Parameters<QaLabServerHandle["setScenarioRun"]>[0]> = [];
    const lab = createLab((run) => scenarioRuns.push(run));
    const defaultFlowImplementation = requireDefaultQaFlowSuiteImplementation();
    runQaFlowSuite.mockImplementationOnce(async (params) => {
      params?.lab?.setScenarioRun({
        kind: "suite",
        status: "running",
        startedAt: "2026-07-23T00:00:00.000Z",
        scenarios: [
          { id: "channel-chat-baseline", name: "channel-chat-baseline", status: "running" },
        ],
      });
      params?.lab?.setScenarioRun({
        kind: "suite",
        status: "running",
        startedAt: "2026-07-23T00:00:00.000Z",
        scenarios: [
          { id: "not-a-selected-scenario", name: "channel-chat-baseline", status: "fail" },
        ],
      });
      const result = await defaultFlowImplementation(params);
      params?.lab?.setScenarioRun({
        kind: "suite",
        status: "completed",
        startedAt: "2026-07-23T00:00:00.000Z",
        finishedAt: "2026-07-23T00:00:01.000Z",
        scenarios: [{ id: "channel-chat-baseline", name: "channel-chat-baseline", status: "pass" }],
      });
      return result;
    });

    await runQaSuite({
      lab,
      repoRoot,
      outputDir: ".artifacts/qa-e2e/mixed-progress",
      scenarioIds: ["channel-chat-baseline", "control-ui-chat-flow-playwright"],
    });

    expect(
      scenarioRuns.some(
        (run) =>
          run?.status === "running" &&
          run.scenarios.some(
            (scenario) => scenario.id === "channel-chat-baseline" && scenario.status === "running",
          ),
      ),
    ).toBe(true);
    expect(
      scenarioRuns.some((run) =>
        run?.scenarios.some(
          (scenario) => scenario.id === "channel-chat-baseline" && scenario.status === "fail",
        ),
      ),
    ).toBe(false);
    expect(
      scenarioRuns.some(
        (run) =>
          run?.status === "running" &&
          run.scenarios.some(
            (scenario) =>
              scenario.id === "control-ui-chat-flow-playwright" && scenario.status === "running",
          ),
      ),
    ).toBe(true);
    expect(scenarioRuns.at(-1)).toMatchObject({
      status: "completed",
      scenarios: [
        { id: "channel-chat-baseline", status: "pass" },
        { id: "control-ui-chat-flow-playwright", status: "pass" },
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
    const repoRoot = await makeTempRepo("qa-suite-exclusive-");
    const sharedIds = ["shared-a", "shared-b", "shared-c"];
    const isolatedIds = ["isolated-a", "isolated-b"];
    const native = makeTestFileScenario("vitest", "test/native.test.ts");
    const scenarioDefinitions = [
      ...sharedIds.map((id) => makeQaSuiteTestScenario(id, { channel: "telegram" })),
      ...isolatedIds.map((id) =>
        makeQaSuiteTestScenario(id, { channel: "telegram", suiteIsolation: "isolated" }),
      ),
      native,
    ];
    const mixed = mode === "retry";
    const scenarioIds = mixed
      ? ["shared-a", "isolated-a", "shared-b", native.id, "shared-c", "isolated-b"]
      : sharedIds;
    const runFlow = requireDefaultQaFlowSuiteImplementation();
    let active = 0;
    let maxActive = 0;
    let attempts = 0;
    runQaFlowSuite.mockImplementation(async (params: QaSuiteRunParams) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      attempts += 1;
      try {
        if (attempts === 1 && mode === "retry") {
          throw new QaSuiteInfraError("transport_ready_timeout", "first partition failed");
        }
        if (mode === "fail-fast") {
          throw new Error("first scenario failed");
        }
        return await runFlow(params);
      } finally {
        active -= 1;
      }
    });

    const result = await runQaSuite({
      repoRoot,
      outputDir: "out",
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
        : [
            ...(mode === "retry" ? [sharedIds] : []),
            sharedIds,
            ...(mixed ? isolatedIds.map((id) => [id]) : []),
          ];
    expect(
      runQaFlowSuite.mock.calls.map(([params]) => ({
        scenarios: params.scenarioIds,
        concurrency: params.concurrency,
      })),
    ).toEqual(expectedPartitions.map((scenarios) => ({ scenarios, concurrency: 1 })));
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(mixed ? 1 : 0);
    expect(maxActive).toBe(1);
    expect(active).toBe(0);
    expect(result.result.scenarios.map(({ name, status }) => ({ name, status }))).toEqual(
      mode === "fail-fast"
        ? [{ name: "shared-a", status: "fail" }]
        : scenarioIds.map((id) => ({
            name: id === native.id ? native.title : id,
            status: "pass",
          })),
    );
    const evidence = await readEvidence(result.result.evidencePath);
    const outcomes = projectQaEvidenceScenarioOutcomes(evidence);
    expect(outcomes.map((outcome) => outcome.scenarioId)).toEqual(scenarioIds);
    expect(new Set(outcomes.map((outcome) => outcome.scenarioInstanceId)).size).toBe(
      scenarioIds.length,
    );
    // Empty legacy evidence cannot establish terminal outcomes from passing results alone.
    expect(outcomes.map((outcome) => outcome.status)).toEqual(
      mode === "fail-fast" ? ["fail", null, null] : scenarioIds.map(() => null),
    );
  });

  it("stops unified suite partitions after the first failed flow scenario", async () => {
    const scenarioRuns: Array<Parameters<QaLabServerHandle["setScenarioRun"]>[0]> = [];
    const lab = createLab((run) => scenarioRuns.push(run));
    const defaultFlowImplementation = requireDefaultQaFlowSuiteImplementation();
    runQaFlowSuite.mockImplementationOnce(async (params) => {
      const result = await defaultFlowImplementation(params);
      for (const scenario of result.scenarios) {
        scenario.status = "fail";
        scenario.details = "first scenario failed";
      }
      return result;
    });

    const result = await runFailFastQaSuite("fail-fast-flow", { lab });

    expect(result.executionKind).toBe("suite");
    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(runQaFlowSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        concurrency: 1,
        failFast: true,
        scenarioIds: ["dm-chat-baseline"],
      }),
    );
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
    expect(prepareDockerE2eEnvironment).not.toHaveBeenCalled();
    expect(result.result.scenarios).toMatchObject([
      { name: "dm-chat-baseline", status: "fail", details: "first scenario failed" },
    ]);
    const summary = JSON.parse(await fs.readFile(result.result.summaryPath, "utf8")) as {
      run?: { concurrency?: number; scenarioIds?: string[] };
      scenarios?: Array<{ name?: string; status?: string }>;
    };
    expect(summary.run?.concurrency).toBe(1);
    expect(summary.run?.scenarioIds).toEqual([
      "dm-chat-baseline",
      "group-visible-reply-tool",
      "control-ui-chat-flow-playwright",
      "docker-npm-onboard-channel-agent",
    ]);
    expect(summary.scenarios).toMatchObject([{ name: "dm-chat-baseline", status: "fail" }]);
    expect(scenarioRuns.at(-1)).toMatchObject({
      status: "completed",
      scenarios: [
        { id: "dm-chat-baseline", status: "fail" },
        { id: "group-visible-reply-tool", status: "pending" },
        { id: "control-ui-chat-flow-playwright", status: "pending" },
        { id: "docker-npm-onboard-channel-agent", status: "pending" },
      ],
    });
  });

  it("fails and stops when a started flow partition omits its scenario result", async () => {
    const catalog = structuredClone(scenarioCatalog.readQaBootstrapScenarioCatalog());
    for (const scenario of catalog.scenarios) {
      scenario.assertions = [
        { id: "scenario-result", meaning: "the scenario owns its result", coverage: [] },
      ];
    }
    vi.spyOn(scenarioCatalog, "readQaBootstrapScenarioCatalog").mockReturnValue(catalog);
    const defaultFlowImplementation = requireDefaultQaFlowSuiteImplementation();
    runQaFlowSuite.mockImplementationOnce(async (params) => ({
      ...(await defaultFlowImplementation(params)),
      scenarios: [],
    }));

    const result = await runFailFastQaSuite("fail-fast-missing-flow");

    expect(result.executionKind).toBe("suite");
    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
    expect(result.result.scenarios).toMatchObject([
      {
        name: "DM baseline conversation",
        status: "fail",
        details: "suite partition returned no scenario result",
      },
    ]);
    const summary = JSON.parse(await fs.readFile(result.result.summaryPath, "utf8")) as {
      scenarios?: Array<{ details?: string; name?: string; status?: string }>;
    };
    expect(summary.scenarios).toMatchObject([
      {
        name: "DM baseline conversation",
        status: "fail",
        details: "suite partition returned no scenario result",
      },
    ]);
    const evidence = await readEvidence(result.result.evidencePath);
    expect(evidence.entries).toMatchObject([
      {
        test: { id: "dm-chat-baseline" },
        result: {
          status: "fail",
          failure: { reason: "suite partition returned no scenario result" },
        },
      },
    ]);
    expect(evidence.occurrences.every((item) => item.assertions === null)).toBe(true);
  });

  it("omits a native fail-fast tail after the first missing scenario result", async () => {
    const repoRoot = await makeTempRepo("qa-suite-fail-fast-missing-native-tail-");
    const defaultTestFileImplementation = runQaTestFileScenarios.getMockImplementation();
    if (!defaultTestFileImplementation) {
      throw new Error("expected default QA test-file scenario mock implementation");
    }
    runQaTestFileScenarios.mockImplementation(async (params) => {
      const result = await defaultTestFileImplementation(params);
      return {
        ...result,
        evidence: {
          ...result.evidence,
          entries: params.scenarios.map((scenario: QaTestFileScenario) => ({
            test: {
              kind: "qa-scenario",
              id: scenario.id,
              title: scenario.title,
            },
            coverage: [],
            result: { status: "pass" as const },
          })),
        },
        results:
          params.scenarios[0]?.id === "auth-profile-doctor-migration-safety" ? [] : result.results,
      };
    });

    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/fail-fast-missing-native-tail",
      concurrency: 8,
      failFast: true,
      scenarioIds: [
        "dm-chat-baseline",
        "control-ui-assistant-media-tickets",
        "auth-profile-doctor-migration-safety",
        "auth-profile-codex-mixed-profiles",
        "control-ui-chat-flow-playwright",
      ],
    });

    expect(result.executionKind).toBe("suite");
    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(2);
    expect(result.result.scenarios).toMatchObject([
      { name: "dm-chat-baseline", status: "pass" },
      { name: "Control UI assistant media ticket evidence", status: "pass" },
      {
        name: "Codex doctor migration safety matrix",
        status: "fail",
        details: "suite partition returned no scenario result",
      },
    ]);
    expect(result.result.scenarios).toHaveLength(3);
    const evidence = await readEvidence(result.result.evidencePath);
    expect(evidence.entries).toMatchObject([
      { test: { id: "control-ui-assistant-media-tickets" }, result: { status: "pass" } },
      // The producer's pass remains raw evidence; it cannot replace the missing returned result.
      { test: { id: "auth-profile-doctor-migration-safety" }, result: { status: "pass" } },
      {
        test: { id: "auth-profile-doctor-migration-safety" },
        result: {
          status: "fail",
          failure: { reason: "suite partition returned no scenario result" },
        },
      },
    ]);
    expect(
      projectQaEvidenceScenarioOutcomes(evidence).find(
        (item) => item.scenarioId === "auth-profile-doctor-migration-safety",
      )?.status,
    ).toBe("fail");
    const retained = evidence.entries[1]!;
    expect(
      evidence.occurrences.find((item) => item.id === retained.binding.occurrenceId)?.scenario,
    ).toBeNull();
  });

  it("leaves nested E2E script runtime preparation to the script owner", async () => {
    const repoRoot = await makeTempRepo("qa-suite-script-runtime-owner-");

    await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/script-runtime-owner",
      scenarioIds: ["managed-gateway-service-lifecycle"],
    });

    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
    const [call] = runQaTestFileScenarios.mock.calls[0] ?? [];
    expect(call.scenarios).toEqual([
      expect.objectContaining({
        id: "managed-gateway-service-lifecycle",
        execution: expect.objectContaining({ kind: "script" }),
      }),
    ]);
    expect(call).not.toHaveProperty("env");
    expect(call).not.toHaveProperty("envMode");
    expect(prepareDockerE2eEnvironment).not.toHaveBeenCalled();
  });

  it("streams native owner progress without exposing child output to CI", async () => {
    const repoRoot = await makeTempRepo("qa-suite-safe-native-progress-");
    vi.stubEnv("OPENCLAW_QA_SUITE_PROGRESS", "1");
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const defaultTestFileImplementation = requireDefaultQaTestFileImplementation();
    runQaTestFileScenarios.mockImplementationOnce(async (params) => {
      params.progress?.("native docker-batch start scenarios=1 timeoutMs=60000");
      expect(stderrWrite).toHaveBeenCalledWith(
        expect.stringContaining("[qa-suite] native docker-batch start"),
      );
      const childOutput = Buffer.from(
        [
          "OPENAI_API_KEY=synthetic-provider-secret",
          'warning: invalid value " channels.buzz.authTag:',
          "[",
          '  "synthetic-auth-secret"',
          "]",
          "::stop-commands::synthetic-runner-attack",
          "##[error]synthetic-runner-attack",
        ].join("\n"),
      );
      params.onCommandOutput?.("stdout", childOutput);
      params.onCommandOutput?.("stderr", childOutput);
      return await defaultTestFileImplementation(params);
    });

    try {
      await runQaSuite({
        repoRoot,
        outputDir: ".artifacts/qa-e2e/safe-native-progress",
        scenarioIds: ["docker-npm-onboard-channel-agent"],
      });

      const runnerParams = runQaTestFileScenarios.mock.calls[0]?.[0];
      expect(runnerParams?.progress).toEqual(expect.any(Function));
      expect(runnerParams).not.toHaveProperty("onCommandOutput");
      const output = [...stdoutWrite.mock.calls, ...stderrWrite.mock.calls]
        .map(([chunk]) => String(chunk))
        .join("");
      expect(output).toContain("[qa-suite] native docker-batch start");
      expect(output).not.toContain("synthetic-provider-secret");
      expect(output).not.toContain("synthetic-auth-secret");
      expect(output).not.toContain("::stop-commands::");
      expect(output).not.toContain("##[error]");
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }
  });

  it("settles flow and native work, then runs serial scripts before a bounded parallel tail", async () => {
    const repoRoot = await makeTempRepo("qa-suite-parallel-scripts-");
    const defaultFlowImplementation = requireDefaultQaFlowSuiteImplementation();
    const defaultTestFileImplementation = requireDefaultQaTestFileImplementation();
    const flow = Promise.withResolvers<void>();
    const native = Promise.withResolvers<void>();
    const serial = Promise.withResolvers<void>();
    const parallel = Promise.withResolvers<void>();
    const started: string[] = [];
    const preparedEnv = Object.freeze({ OPENCLAW_CURRENT_PACKAGE_TGZ: "/tmp/candidate.tgz" });
    const scriptEnvs: unknown[] = [];
    const parallelScriptIds: string[] = [];
    let activeParallelScripts = 0;
    let maxActiveParallelScripts = 0;
    runQaFlowSuite.mockImplementationOnce(async (params) => {
      started.push("flow");
      await flow.promise;
      return await defaultFlowImplementation(params);
    });
    prepareDockerE2eEnvironment.mockImplementationOnce(async () => {
      started.push("prep");
      return preparedEnv;
    });
    runQaTestFileScenarios.mockImplementation(async (params) => {
      const scenarioIds = params.scenarios.map((scenario: QaTestFileScenario) => scenario.id);
      const kind = params.scenarios[0]?.execution.kind;
      if (kind === "playwright") {
        started.push("native");
        await native.promise;
      } else if (scenarioIds.includes("docker-npm-onboard-channel-agent")) {
        scriptEnvs.push(params.env);
        started.push(...scenarioIds);
        await serial.promise;
      } else {
        scriptEnvs.push(params.env);
        parallelScriptIds.push(...scenarioIds);
        activeParallelScripts += 1;
        maxActiveParallelScripts = Math.max(maxActiveParallelScripts, activeParallelScripts);
        try {
          await parallel.promise;
        } finally {
          activeParallelScripts -= 1;
        }
      }
      return await defaultTestFileImplementation(params);
    });

    const runPromise = runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/parallel-scripts",
      concurrency: 8,
      scenarioIds: [
        "dm-chat-baseline",
        "control-ui-chat-flow-playwright",
        "docker-npm-onboard-channel-agent",
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
    expect(maxActiveParallelScripts).toBe(3);
  });

  it("carries the actual prepared Docker receipt through aggregate native delegation", async () => {
    const repoRoot = await makeTempRepo("qa-suite-docker-receipt-");
    const docker = await vi.importActual<typeof import("./test-file-scenario-docker-batch.js")>(
      "./test-file-scenario-docker-batch.js",
    );
    const native = await vi.importActual<typeof import("./test-file-scenario-runner.js")>(
      "./test-file-scenario-runner.js",
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
    const command = vi.fn(
      async (params: import("./test-file-scenario-runner.js").QaScenarioCommandExecution) => {
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
      },
    );
    runQaTestFileScenarios.mockImplementationOnce((params) =>
      native.runQaTestFileScenarios({ ...params, runCommand: command }),
    );
    const result = await runQaSuite({
      repoRoot,
      outputDir: "out",
      scenarioIds: ["docker-npm-onboard-channel-agent"],
    });
    expect(prepareDockerE2eEnvironment).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledTimes(1);
    const evidence = await readEvidence(result.result.evidencePath);
    const passed = runQaTestFileScenarios.mock.calls[0]![0].preparedDockerEvidence;
    expect(passed).toBeDefined();
    const receipts = evidence.occurrences.flatMap((occurrence) => occurrence.receipts);
    const receipt = receipts.find((candidate) => candidate.id === passed.receipt.id)!;
    expect(receipt).toEqual(passed.receipt);
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
    const bytes = await fs.readFile(
      resolveQaArtifactPath(repoRoot, repoRoot, receipt.artifact.path),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(receipt.artifact.sha256);
    expect(projectQaEvidenceScenarioOutcomes(evidence).map((outcome) => outcome.status)).toEqual([
      "pass",
    ]);
  });

  it("records Docker preparation failure without starting a script partition", async () => {
    const repoRoot = await makeTempRepo("qa-suite-docker-prep-failure-");
    prepareDockerE2eEnvironment.mockRejectedValueOnce(new Error("candidate pack failed"));
    const result = await runQaSuite({
      repoRoot,
      scenarioIds: ["docker-npm-onboard-channel-agent", "gateway-smoke"],
    });

    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
    expect(result.result.scenarios).toHaveLength(2);
    expect(result.result.scenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "fail",
          details: expect.stringContaining("candidate pack failed"),
        }),
      ]),
    );
  });

  it("reuses the prepared Docker env object when a script partition retries", async () => {
    const repoRoot = await makeTempRepo("qa-suite-docker-prep-retry-");
    const preparedEnv = Object.freeze({ OPENCLAW_CURRENT_PACKAGE_TGZ: "/tmp/candidate.tgz" });
    const defaultImplementation = requireDefaultQaTestFileImplementation();
    prepareDockerE2eEnvironment.mockResolvedValueOnce(preparedEnv);
    runQaTestFileScenarios
      .mockRejectedValueOnce(new QaSuiteInfraError("transport_ready_timeout", "retry"))
      .mockImplementationOnce(defaultImplementation);

    await runQaSuite({ repoRoot, scenarioIds: ["docker-npm-onboard-channel-agent"] });

    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(2);
    expect(runQaTestFileScenarios.mock.calls.map(([params]) => params.env)).toEqual([
      preparedEnv,
      preparedEnv,
    ]);
  });

  it("prepares the Docker candidate before a script-owned Docker lane", async () => {
    const repoRoot = await makeTempRepo("qa-suite-script-docker-prep-");
    const preparedEnv = Object.freeze({ OPENCLAW_CURRENT_PACKAGE_TGZ: "/tmp/candidate.tgz" });
    prepareDockerE2eEnvironment.mockResolvedValueOnce(preparedEnv);

    await runQaSuite({ repoRoot, scenarioIds: ["cli-onboarding"] });

    expect(prepareDockerE2eEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarios: [expect.objectContaining({ id: "cli-onboarding" })],
      }),
    );
    expect(runQaTestFileScenarios).toHaveBeenCalledWith(
      expect.objectContaining({ env: preparedEnv, envMode: "replace" }),
    );
  });

  it("keeps selected evidence order and successful siblings when a parallel script rejects", async () => {
    const repoRoot = await makeTempRepo("qa-suite-parallel-script-rejection-");
    const defaultTestFileImplementation = requireDefaultQaTestFileImplementation();
    const first = Promise.withResolvers<void>();
    runQaTestFileScenarios.mockImplementation(async (params) => {
      const scenario = params.scenarios[0] as QaTestFileScenario | undefined;
      if (!scenario) {
        throw new Error("expected one script scenario");
      }
      if (scenario.id === "gateway-smoke") {
        throw new Error("audited producer rejected");
      }
      if (scenario.id === "remote-log-tailing") {
        await first.promise;
      }
      const result = await defaultTestFileImplementation(params);
      return {
        ...result,
        evidence: {
          ...result.evidence,
          entries: [
            {
              test: { kind: "qa-scenario", id: scenario.id, title: scenario.title },
              coverage: [],
              result: { status: "pass" as const },
            },
          ],
        },
      };
    });

    const runPromise = runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/parallel-script-rejection",
      concurrency: 3,
      scenarioIds: ["remote-log-tailing", "gateway-smoke", "logging-file-boundary"],
    });
    await vi.waitFor(() => expect(runQaTestFileScenarios).toHaveBeenCalledTimes(3));
    first.resolve();
    const result = await runPromise;

    expect(result.executionKind).toBe("suite");
    const evidence = await readEvidence(result.result.evidencePath);
    expect(evidence.entries.map((entry) => entry.test.id)).toEqual([
      "remote-log-tailing",
      "gateway-smoke",
      "logging-file-boundary",
    ]);
    expect(evidence.entries[1]).toMatchObject({
      result: {
        failure: { reason: "suite partition failed: audited producer rejected" },
        status: "fail",
      },
    });
  });

  it("serializes every fail-fast script and stops before post-failure work", async () => {
    const repoRoot = await makeTempRepo("qa-suite-fail-fast-scripts-");
    const defaultTestFileImplementation = requireDefaultQaTestFileImplementation();
    const first = Promise.withResolvers<void>();
    const preparedEnv = Object.freeze({ OPENCLAW_CURRENT_PACKAGE_TGZ: "/tmp/candidate.tgz" });
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    prepareDockerE2eEnvironment.mockResolvedValueOnce(preparedEnv);
    runQaTestFileScenarios.mockImplementation(async (params) => {
      const scenario = params.scenarios[0] as QaTestFileScenario | undefined;
      if (!scenario) {
        throw new Error("expected one script scenario");
      }
      started.push(scenario.id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (scenario.id === "remote-log-tailing") {
          await first.promise;
        }
        const result = await defaultTestFileImplementation(params);
        if (scenario.id !== "docker-npm-onboard-channel-agent") {
          return result;
        }
        for (const row of result.results) {
          row.status = "fail";
          row.failureMessage = "serial owner failed";
        }
        return result;
      } finally {
        active -= 1;
      }
    });

    const runPromise = runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/fail-fast-scripts",
      concurrency: 8,
      failFast: true,
      scenarioIds: ["remote-log-tailing", "docker-npm-onboard-channel-agent", "gateway-smoke"],
    });
    await vi.waitFor(() => expect(started).toEqual(["remote-log-tailing"]));
    expect(maxActive).toBe(1);

    first.resolve();
    await runPromise;
    expect(started).toEqual(["remote-log-tailing", "docker-npm-onboard-channel-agent"]);
    expect(maxActive).toBe(1);
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(2);
    expect(runQaTestFileScenarios.mock.calls.every(([params]) => params.env === preparedEnv)).toBe(
      true,
    );
    expect(runQaTestFileScenarios).toHaveBeenLastCalledWith(
      expect.objectContaining({ failFast: true }),
    );
  });

  it("starts native suite proof before isolated flow work fills the weighted queue", async () => {
    const repoRoot = await makeTempRepo("qa-suite-native-before-isolated-");
    const shared = blockNextQaFlowSuite();
    const testFile = blockNextQaTestFileRun();

    const runPromise = runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/native-before-isolated",
      concurrency: 2,
      scenarioIds: [
        "dm-chat-baseline",
        "group-visible-reply-tool",
        "control-ui-chat-flow-playwright",
      ],
    });
    await shared.started;
    await testFile.started;
    await Promise.resolve();

    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);

    testFile.release();
    shared.release();
    await runPromise;

    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
  });

  it("waits for already-started partitions before recording a unified failure", async () => {
    const repoRoot = await makeTempRepo("qa-suite-reject-settle-");
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "reject-settle");
    const priorArtifactPaths = [
      path.join(outputDir, "qa-suite-summary.json"),
      path.join(outputDir, "qa-evidence.json"),
      path.join(outputDir, "qa-suite-report.md"),
    ];
    await fs.mkdir(outputDir, { recursive: true });
    await Promise.all(
      priorArtifactPaths.map((artifactPath) => fs.writeFile(artifactPath, "stale")),
    );
    const testFile = blockNextQaTestFileRun();
    runQaFlowSuite.mockRejectedValueOnce(
      new Error("flow partition failed", {
        cause: Object.assign(new Error("unrelated capacity failure"), {
          code: "POOL_EXHAUSTED",
        }),
      }),
    );
    const runPromise = runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/reject-settle",
      concurrency: 2,
      scenarioIds: ["channel-chat-baseline", "control-ui-chat-flow-playwright"],
    });
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
    expect(result.executionKind).toBe("suite");
    expect(result.result.scenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "fail",
          details: expect.stringContaining("suite partition failed: flow partition failed"),
        }),
        expect.objectContaining({ status: "pass" }),
      ]),
    );
    const summary = JSON.parse(await fs.readFile(result.result.summaryPath, "utf8")) as {
      counts: { failed: number; passed: number; total: number };
    };
    expect(summary.counts).toMatchObject({ total: 2, passed: 1, failed: 1 });
    await fs.access(result.result.evidencePath);
    await fs.access(result.result.reportPath);
  });

  it("reuses unavailable channel credential evidence across serial partitions", async () => {
    const repoRoot = await makeTempRepo("qa-suite-credential-unavailable-");
    const poolError = Object.assign(new Error("no WhatsApp credential is available"), {
      code: "POOL_EXHAUSTED",
    });
    runQaFlowSuite.mockRejectedValueOnce(
      new Error("failed to create QA transport live:whatsapp: credential acquire failed", {
        cause: new Error("credential acquire timed out", { cause: poolError }),
      }),
    );

    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/credential-unavailable",
      providerMode: "mock-openai",
      channelDriver: "live",
      adapterFactories: [{ id: "whatsapp", matches: () => true, create: vi.fn() }],
      scenarioIds: [
        "whatsapp-status-command",
        "whatsapp-access-control-dm-open",
        "control-ui-chat-flow-playwright",
      ],
    });

    expect(result.executionKind).toBe("suite");
    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(result.result.scenarios.slice(0, 2)).toMatchObject([
      { status: "fail", details: expect.stringContaining("channel credential unavailable") },
      { status: "fail", details: expect.stringContaining("channel credential unavailable") },
    ]);
    const evidence = await readEvidence(result.result.evidencePath);
    for (const scenarioId of ["whatsapp-status-command", "whatsapp-access-control-dm-open"]) {
      const blocked = evidence.entries?.find((entry) => entry.test?.id === scenarioId);
      expect(blocked).toMatchObject({
        execution: { channel: { id: "whatsapp", live: false } },
        result: { status: "blocked" },
      });
      expect(blocked?.execution?.channel?.driver).toBeUndefined();
    }
    expect(result.observedCells).not.toEqual(
      expect.arrayContaining([
        { scenarioId: "whatsapp-status-command", executionKind: "flow", channel: "whatsapp" },
        {
          scenarioId: "whatsapp-access-control-dm-open",
          executionKind: "flow",
          channel: "whatsapp",
        },
      ]),
    );
  });

  it("isolates flow scenarios that mutate shared runtime state", async () => {
    const repoRoot = await makeTempRepo("qa-suite-shared-state-");
    await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/smoke",
      concurrency: 8,
      scenarioIds: [
        "dm-chat-baseline",
        "runtime-tool-image-generate",
        "runtime-inventory-drift-check",
        "session-memory-ranking",
        "control-ui-chat-flow-playwright",
      ],
    });

    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "smoke");
    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
    expect(runQaFlowSuite).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow", "shared"),
        concurrency: 1,
        scenarioIds: ["dm-chat-baseline"],
      }),
    );
    expect(runQaFlowSuite).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow", "isolated"),
        concurrency: 3,
        workerStartStaggerMs: 1_500,
        scenarioIds: [
          "runtime-tool-image-generate",
          "runtime-inventory-drift-check",
          "session-memory-ranking",
        ],
      }),
    );
  });

  it("rejects runtime-pair requests for Vitest/Playwright scenarios", async () => {
    await expect(
      runQaSuite({
        repoRoot: process.cwd(),
        runtimePair: ["openclaw", "codex"],
        scenarioIds: ["control-ui-chat-flow-playwright"],
      }),
    ).rejects.toThrow("--runtime-pair requires execution.kind: flow scenarios");

    expect(runQaFlowSuite).not.toHaveBeenCalled();
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
  });

  it("rejects repo-local symlink output directories before running Vitest/Playwright scenarios", async () => {
    const repoRoot = await makeTempRepo("qa-suite-symlink-root-");
    const outsideRoot = await makeTempRepo("qa-suite-symlink-outside-");
    await fs.symlink(outsideRoot, path.join(repoRoot, "artifacts-link"));

    await expect(
      runQaSuite({
        repoRoot,
        outputDir: "artifacts-link/qa-out",
        scenarioIds: ["control-ui-chat-flow-playwright"],
      }),
    ).rejects.toThrow("QA suite outputDir must not traverse symlinks");

    expect(runQaFlowSuite).not.toHaveBeenCalled();
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
