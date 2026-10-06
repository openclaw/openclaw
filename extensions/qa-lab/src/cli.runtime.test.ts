import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isCrablineServerChannel, OPENCLAW_CRABLINE_DEFAULT_CHANNEL } from "@openclaw/crabline";
import { Command } from "commander";
import type { QaRunnerCliContribution } from "openclaw/plugin-sdk/qa-runner-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRuntimeParitySummary } from "./agentic-parity-report-test-helpers.js";
import { readQaScenarioById, type QaScenarioPack } from "./scenario-catalog.js";
import * as taxonomyModule from "./scorecard-taxonomy.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const {
  runQaManualLane,
  runQaFlowSuiteFromRuntime,
  runQaSuite,
  runQaCharacterEval,
  runQaMultipass,
  listLiveTransportQaAdapterFactories,
  startQaLabServer,
  writeQaDockerHarnessFiles,
  buildQaDockerHarnessImage,
  runQaDockerUp,
  defaultQaRuntimeModelForMode,
  resolveQaRuntimeModelPair,
  readQaScenarioPack,
} = vi.hoisted(() => ({
  runQaManualLane: vi.fn(),
  runQaFlowSuiteFromRuntime: vi.fn(),
  runQaSuite: vi.fn(),
  runQaCharacterEval: vi.fn(),
  runQaMultipass: vi.fn(),
  listLiveTransportQaAdapterFactories: vi.fn(),
  startQaLabServer: vi.fn(),
  writeQaDockerHarnessFiles: vi.fn(),
  buildQaDockerHarnessImage: vi.fn(),
  runQaDockerUp: vi.fn(),
  defaultQaRuntimeModelForMode:
    vi.fn<(mode: string, options?: { alternate?: boolean }) => string>(),
  resolveQaRuntimeModelPair: vi.fn(),
  readQaScenarioPack: vi.fn<() => QaScenarioPack>(),
}));

const {
  listQaRunnerCliContributions,
  runMantisBeforeAfterCommand,
  runMantisDesktopBrowserSmokeCommand,
  runMantisSlackDesktopSmokeCommand,
} = vi.hoisted(() => ({
  listQaRunnerCliContributions: vi.fn<() => QaRunnerCliContribution[]>(),
  runMantisBeforeAfterCommand: vi.fn(),
  runMantisDesktopBrowserSmokeCommand: vi.fn(),
  runMantisSlackDesktopSmokeCommand: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/qa-runner-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/qa-runner-runtime")>()),
  listQaRunnerCliContributions,
}));

vi.mock("./mantis/cli.runtime.js", () => ({
  runMantisBeforeAfterCommand,
  runMantisDesktopBrowserSmokeCommand,
  runMantisSlackDesktopSmokeCommand,
}));

vi.mock("./manual-lane.runtime.js", () => ({
  runQaManualLane,
}));

vi.mock("./suite-launch.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./suite-launch.runtime.js")>()),
  runQaFlowSuiteFromRuntime,
  runQaSuite,
}));

vi.mock("./character-eval.js", () => ({
  runQaCharacterEval,
}));

vi.mock("./multipass.runtime.js", () => ({
  runQaMultipass,
}));

vi.mock("./live-transports/cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./live-transports/cli.js")>()),
  listLiveTransportQaAdapterFactories,
}));

vi.mock("./live-transports/telegram/adapter.runtime.js", () => ({
  createTelegramQaTransportAdapter: vi.fn(),
}));

vi.mock("./lab-server.js", () => ({
  startQaLabServer,
}));

vi.mock("./docker-harness.js", () => ({
  writeQaDockerHarnessFiles,
  buildQaDockerHarnessImage,
}));

vi.mock("./docker-up.runtime.js", () => ({
  runQaDockerUp,
}));

vi.mock("./model-selection.runtime.js", () => ({
  defaultQaRuntimeModelForMode,
  resolveQaRuntimeModelPair,
}));

vi.mock("./scenario-catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scenario-catalog.js")>();
  readQaScenarioPack.mockImplementation(actual.readQaScenarioPack);
  return {
    ...actual,
    readQaScenarioPack,
  };
});

import { resolveRepoRelativeOutputDir } from "./cli-paths.js";
import { registerQaLabCli } from "./cli.js";
import {
  runQaDockerScaffoldCommand,
  runQaDockerUpCommand,
  runQaCharacterEvalCommand,
  runQaCoverageReportCommand,
  runQaParityReportCommand,
  runQaProfileCommand,
  runQaManualLaneCommand,
  resolveQaHarnessRepoRoot,
  runQaSuiteCommand,
} from "./cli.runtime.js";
import { QaSuiteInfraError } from "./errors.js";
import type { QaEvidenceSummaryJson } from "./evidence-summary.js";
import { runQaTelegramCommand } from "./live-transports/telegram/cli.runtime.js";
import { defaultQaModelForMode as defaultQaProviderModelForMode } from "./model-selection.js";
import { resolveQaLiveFrontierAlternateModel } from "./providers/live-frontier/model-selection.runtime.js";
import type { QaTransportAdapterFactory } from "./qa-transport-registry.js";
import type { QaProviderModeInput } from "./run-config.js";
import { expandQaScenarioExecutionCells, type QaScenarioExecutionCell } from "./scenario-lane.js";
import type { QaSuiteRunParams } from "./suite.js";

const LEGACY_TEST_REPO_ROOT = path.resolve("/tmp/openclaw-repo");
const nativeRealpath = fs.realpath.bind(fs);
const tempDirs = createTempDirHarness();

function resolveMockQaRuntimeModelPair(params: {
  providerMode: string;
  primaryModel?: string;
  alternateModel?: string;
}) {
  const primaryModel =
    params.primaryModel?.trim() || defaultQaRuntimeModelForMode(params.providerMode);
  const alternateModel =
    params.alternateModel?.trim() ||
    (params.providerMode === "live-frontier"
      ? (resolveQaLiveFrontierAlternateModel(primaryModel) ??
        defaultQaRuntimeModelForMode(params.providerMode, { alternate: true }))
      : defaultQaRuntimeModelForMode(params.providerMode, { alternate: true }));
  return { primaryModel, alternateModel };
}

const QA_PASSING_SUITE_SCENARIO = {
  name: "channel chat baseline",
  status: "pass" as const,
  steps: [],
};

function mockFirstObjectArg(mock: unknown): Record<string, unknown> {
  const calls = (mock as { mock?: { calls?: Array<Array<unknown>> } }).mock?.calls ?? [];
  const [arg] = calls[0] ?? [];
  if (!arg || typeof arg !== "object") {
    throw new Error("expected first mock object argument");
  }
  return arg as Record<string, unknown>;
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

function expectWriteContains(mock: unknown, fragment: string): void {
  const calls = (mock as { mock?: { calls?: Array<Array<unknown>> } }).mock?.calls ?? [];
  expect(
    calls.some(([value]) => String(value).includes(fragment)),
    `write contains ${fragment}`,
  ).toBe(true);
}

async function writeJson(filePath: string, value: unknown) {
  await fs.writeFile(filePath, JSON.stringify(value), "utf8");
}

function runtimeSummary(scenarioId: string) {
  const summary = makeRuntimeParitySummary();
  const scenario = summary.scenarios[0];
  if (!scenario?.runtimeParity) {
    throw new Error("runtime parity fixture missing");
  }
  const entry = {
    ...scenario,
    name: scenarioId,
    runtimeParity: { ...scenario.runtimeParity, scenarioId },
  };
  const scenarios: [typeof entry] = [entry];
  return {
    ...summary,
    scenarios,
    counts: { total: 1, passed: 1, failed: 0 },
    run: { ...summary.run, status: "completed" },
  };
}

function makeQaEvidence(entries: unknown[] = []) {
  return {
    kind: "openclaw.qa.evidence-summary",
    schemaVersion: 2,
    generatedAt: "2026-06-14T00:00:00.000Z",
    evidenceMode: "full",
    entries,
  };
}

function makeEvidenceEntry(id: string, title: string, coverageId?: string) {
  return {
    test: { kind: "qa-scenario", id, title, source: { path: `qa/scenarios/channels/${id}.yaml` } },
    coverage: coverageId ? [{ id: coverageId, role: "primary" }] : [],
    execution: {
      runner: "host",
      environment: { ref: null, os: process.platform, nodeVersion: process.version },
      provider: {
        id: "openai",
        live: false,
        model: { name: "gpt-5.6-luna", ref: "mock-openai/gpt-5.6-luna" },
        fixture: "mock-openai",
      },
      channel: { id: "qa-channel", live: false },
      packageSource: { kind: "source-checkout" },
      artifacts: [],
    },
    result: { status: "pass" },
  };
}

function executionCellsForSuiteParams(params?: QaSuiteRunParams) {
  const scenarioIds = new Set(params?.scenarioIds ?? []);
  const scenarios = readQaScenarioPack().scenarios.filter((scenario) =>
    scenarioIds.has(scenario.id),
  );
  const adapterFactories: readonly QaTransportAdapterFactory[] = params?.adapterFactories ?? [];
  return expandQaScenarioExecutionCells({
    scenarios,
    channelDriver: params?.channelDriver ?? "qa-channel",
    channel: params?.channelId,
    defaultChannel:
      params?.channelDriver === "crabline" ? OPENCLAW_CRABLINE_DEFAULT_CHANNEL : undefined,
    supportsChannel:
      params?.channelDriver === "crabline"
        ? isCrablineServerChannel
        : params?.channelDriver === "live"
          ? (channel) =>
              adapterFactories.some((factory) =>
                factory.matches({ channelId: channel, driver: "live" }),
              )
          : undefined,
    expandChannels: params?.expandScenarioChannels === true,
  });
}

describe("qa cli", () => {
  let program: Command;
  function parseQa(
    args: string[],
    flags: Record<string, string | string[] | boolean | number | undefined> = {},
  ) {
    const options = Object.entries(flags).flatMap(([flag, value]) =>
      value === undefined || value === false
        ? []
        : value === true
          ? [`--${flag}`]
          : (Array.isArray(value) ? value : [value]).flatMap((entry) => [
              `--${flag}`,
              String(entry),
            ]),
    );
    return program.parseAsync(["node", "openclaw", "qa", ...args, ...options]);
  }

  let stdoutWrite: ReturnType<typeof vi.spyOn>;
  let stderrWrite: ReturnType<typeof vi.spyOn>;
  let suiteArtifactsDir: string;
  let suiteEvidencePath: string;
  let suiteReportPath: string;
  let suiteSummaryPath: string;
  let telegramArtifactsDir: string;
  let priorExitCode: typeof process.exitCode;

  async function writeSuiteSummary(summary: unknown, summaryPath = suiteSummaryPath) {
    await writeJson(summaryPath, summary);
  }

  async function writeBuiltCandidate(name = "candidate") {
    const repoRoot = path.join(suiteArtifactsDir, name);
    const entryPath = path.join(repoRoot, "dist", "index.mjs");
    await fs.mkdir(path.dirname(entryPath), { recursive: true });
    await fs.writeFile(entryPath, "", "utf8");
    return { entryPath, repoRoot };
  }

  function mockSuiteRuntimeResult(
    executionKind: "flow" | "suite" = "flow",
    params: {
      evidencePath?: string;
      expectedCells?: QaScenarioExecutionCell[];
      observedCells?: QaScenarioExecutionCell[];
      scenarios?: unknown[];
    } = {},
  ) {
    return {
      executionKind,
      expectedCells: params.expectedCells ?? params.observedCells ?? [],
      observedCells: params.observedCells ?? [],
      result: {
        outputDir: suiteArtifactsDir,
        evidencePath: params.evidencePath ?? suiteEvidencePath,
        reportPath: suiteReportPath,
        summaryPath: suiteSummaryPath,
        report: "# QA Suite Report\n",
        scenarios: params.scenarios ?? [QA_PASSING_SUITE_SCENARIO],
        ...(executionKind === "flow" ? { watchUrl: "http://127.0.0.1:43124" } : {}),
      },
    };
  }

  async function prepareTelegramLauncher() {
    const candidateRoot = path.join(telegramArtifactsDir, "candidate");
    const boundaryDir = path.join(telegramArtifactsDir, "boundary");
    const launcherPath = path.join(telegramArtifactsDir, "openclaw-telegram-sut-launcher");
    const runtimeRoot = path.join(telegramArtifactsDir, "runtime");
    const runtimeTempParent = path.join(runtimeRoot, "tmp");
    const preloadPath = path.join(runtimeRoot, "openclaw-telegram-preentry.mjs");
    const runtimeEntryPath = path.join(candidateRoot, "dist", "index.js");
    await fs.mkdir(path.dirname(runtimeEntryPath), { recursive: true });
    await fs.mkdir(boundaryDir);
    await fs.mkdir(runtimeTempParent, { recursive: true });
    await fs.writeFile(launcherPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await fs.writeFile(preloadPath, "export {};\n", { mode: 0o600 });
    await fs.writeFile(runtimeEntryPath, "export {};\n", { mode: 0o600 });
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_FORWARDED_ENV_KEYS", "HOME,PATH");
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_CLEANUP_TIMEOUT_MS", "60000");
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_GID", "1002");
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_OPENCLAW_COMMAND", launcherPath);
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_PRELOAD_PATH", preloadPath);
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_PROCESS_BOUNDARY_DIR", boundaryDir);
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_RUNTIME_EXECUTABLE", process.execPath);
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_UID", "1001");
    return {
      candidateRoot,
      boundaryDir,
      launcherPath,
      runtimeTempParent,
      preloadPath,
      runtimeEntryPath,
    };
  }

  beforeEach(async () => {
    listQaRunnerCliContributions.mockReturnValue([
      {
        pluginId: "qa-runner-test",
        commandName: "runner-test",
        status: "available",
        registration: {
          commandName: "runner-test",
          register(qa) {
            qa.command("runner-test");
          },
        },
      },
    ]);
    program = new Command().exitOverride().configureOutput({ writeErr() {}, writeOut() {} });
    registerQaLabCli(program);
    priorExitCode = process.exitCode;
    process.exitCode = 0;
    suiteArtifactsDir = await tempDirs.makeTempDir("qa-suite-runtime-");
    suiteEvidencePath = path.join(suiteArtifactsDir, "qa-evidence.json");
    suiteReportPath = path.join(suiteArtifactsDir, "qa-suite-report.md");
    suiteSummaryPath = path.join(suiteArtifactsDir, "qa-suite-summary.json");
    telegramArtifactsDir = await tempDirs.makeTempDir("qa-telegram-runtime-");
    await fs.writeFile(suiteReportPath, "# QA Suite Report\n", "utf8");
    await writeJson(
      suiteEvidencePath,
      makeQaEvidence([makeEvidenceEntry("channel-chat-baseline", "Channel chat baseline")]),
    );
    await writeSuiteSummary({
      run: { status: "completed" },
      counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
      scenarios: [QA_PASSING_SUITE_SCENARIO],
    });
    stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(fs, "realpath").mockImplementation(async (filePath) => {
      if (path.resolve(filePath.toString()) === LEGACY_TEST_REPO_ROOT) {
        return nativeRealpath(process.cwd());
      }
      return nativeRealpath(filePath);
    });
    runQaFlowSuiteFromRuntime.mockReset();
    runQaSuite.mockReset();
    runQaCharacterEval.mockReset();
    runQaManualLane.mockReset();
    runQaMultipass.mockReset();
    listLiveTransportQaAdapterFactories.mockReset();
    startQaLabServer.mockReset();
    writeQaDockerHarnessFiles.mockReset();
    buildQaDockerHarnessImage.mockReset();
    runQaDockerUp.mockReset();
    defaultQaRuntimeModelForMode.mockImplementation(
      (mode: string, options?: { alternate?: boolean }) =>
        defaultQaProviderModelForMode(mode as QaProviderModeInput, options),
    );
    resolveQaRuntimeModelPair.mockImplementation(resolveMockQaRuntimeModelPair);
    readQaScenarioPack.mockClear();
    runQaSuite.mockImplementation(async (params) => {
      const observedCells = executionCellsForSuiteParams(params);
      return mockSuiteRuntimeResult("flow", {
        observedCells,
      });
    });
    runQaFlowSuiteFromRuntime.mockResolvedValue(mockSuiteRuntimeResult().result);
    runQaCharacterEval.mockResolvedValue({
      reportPath: "/tmp/character-report.md",
      summaryPath: "/tmp/character-summary.json",
      runs: [{ model: "qa/candidate", status: "pass" }],
      judgments: [{ model: "qa/judge", rankings: [{ model: "qa/candidate", rank: 1 }] }],
    });
    runQaManualLane.mockResolvedValue({
      model: "openai/gpt-5.6-luna",
      waited: { status: "ok" },
      reply: "done",
      watchUrl: "http://127.0.0.1:43124",
    });
    runQaMultipass.mockResolvedValue({
      outputDir: suiteArtifactsDir,
      reportPath: suiteReportPath,
      summaryPath: suiteSummaryPath,
      hostLogPath: path.join(suiteArtifactsDir, "multipass-host.log"),
      bootstrapLogPath: path.join(suiteArtifactsDir, "multipass-guest-bootstrap.log"),
      guestScriptPath: path.join(suiteArtifactsDir, "multipass-guest-run.sh"),
      vmName: "openclaw-qa-test",
      scenarioIds: ["channel-chat-baseline"],
    });
    listLiveTransportQaAdapterFactories.mockReturnValue([
      {
        id: "telegram",
        matches: vi.fn(),
        create: vi.fn(),
      },
    ]);
    writeQaDockerHarnessFiles.mockResolvedValue({
      outputDir: "/tmp/openclaw-repo/.artifacts/qa-docker",
    });
    runQaDockerUp.mockResolvedValue({
      outputDir: "/tmp/openclaw-repo/.artifacts/qa-docker",
      qaLabUrl: "http://127.0.0.1:43124",
      gatewayUrl: "http://127.0.0.1:18789/",
      stopCommand: "docker compose down",
    });
  });

  afterEach(async () => {
    process.exitCode = priorExitCode ?? 0;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await tempDirs.cleanup();
  });

  it("fails clearly when the QA harness package root cannot be resolved", async () => {
    const modulePath = path.join(suiteArtifactsDir, "unowned", "dist", "qa-runtime-test.js");
    await fs.mkdir(path.dirname(modulePath), { recursive: true });
    await fs.writeFile(modulePath, "", "utf8");

    await expect(resolveQaHarnessRepoRoot(pathToFileURL(modulePath).href)).rejects.toThrow(
      "Unable to resolve QA harness repository root from",
    );
  });

  it.each([false, true])("uses the packaged candidate CLI with preflight=%s", async (preflight) => {
    const candidate = await writeBuiltCandidate();
    await runQaSuiteCommand({
      repoRoot: candidate.repoRoot,
      ...(preflight
        ? { preflight }
        : {
            scenarioIds: ["channel-chat-baseline"],
            runtimePair: " codex , pi ",
          }),
    });
    expect(preflight ? runQaFlowSuiteFromRuntime : runQaSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: candidate.repoRoot,
        ...(!preflight ? { runtimePair: ["codex", "openclaw"] } : {}),
        sutOpenClawCommand: {
          executablePath: process.execPath,
          argsPrefix: [candidate.entryPath],
          cwd: candidate.repoRoot,
          usePackagedPlugins: true,
        },
      }),
    );
  });

  it("keeps source behavior for a symlink alias of the harness repo root", async () => {
    const repoRoot = path.join(suiteArtifactsDir, "harness-alias");
    await fs.symlink(process.cwd(), repoRoot, "dir");

    await runQaSuiteCommand({
      repoRoot,
      scenarioIds: ["channel-chat-baseline"],
    });

    expect(runQaSuite).toHaveBeenCalledWith(
      expect.not.objectContaining({ sutOpenClawCommand: expect.anything() }),
    );
  });

  it("rejects a missing external candidate CLI before suite startup", async () => {
    const repoRoot = path.join(suiteArtifactsDir, "candidate-without-cli");
    await fs.mkdir(repoRoot);

    await expect(
      runQaSuiteCommand({
        repoRoot,
        scenarioIds: ["channel-chat-baseline"],
      }),
    ).rejects.toThrow(
      "OpenClaw CLI entry not found: expected scripts/run-node.mjs or dist/index.(m)js",
    );
    expect(runQaSuite).not.toHaveBeenCalled();
    expect(runQaFlowSuiteFromRuntime).not.toHaveBeenCalled();
  });

  it.each([
    {
      runner: "host",
      summary: "contradictory",
      data: {
        counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
        scenarios: [{ status: "pass" }],
        evidence: { entries: [{ result: { status: "fail" } }] },
      },
      expected: { code: "summary_counts_invalid" },
      allowFailures: false,
    },
    {
      runner: "host",
      summary: "optional-only",
      data: {
        counts: { total: 1, passed: 0, failed: 0, skipped: 1 },
        scenarios: [
          {
            name: "Runtime tool fixture — image_generate",
            status: "skip",
            details: "image_generate mock provider report-only: tool unavailable",
          },
        ],
      },
      expected: "did not include any executed scenarios",
      allowFailures: true,
    },
    {
      runner: "host",
      summary: "missing",
      data: undefined,
      expected: "Could not read QA summary",
      allowFailures: true,
    },
    {
      runner: "host",
      summary: "malformed",
      data: undefined,
      expected: "Could not parse QA summary",
      allowFailures: true,
    },
    {
      runner: "multipass",
      summary: "zero-work",
      data: { counts: { total: 0, passed: 0, failed: 0, skipped: 0 }, scenarios: [] },
      expected: "did not include any executed scenarios",
      allowFailures: true,
    },
    {
      runner: "multipass",
      summary: "blocked",
      data: {
        counts: { total: 1 },
        scenarios: [
          {
            name: "Required channel scenario",
            status: "blocked",
            details: "Required transport unavailable",
          },
        ],
      },
      expected: "did not include any executed scenarios",
      allowFailures: true,
    },
    {
      runner: "multipass",
      summary: "partial",
      data: { counts: { total: 2, passed: 2 } },
      expected:
        "did not include counts.failed, counts.skipped, scenarios[].status, or entries[].result.status",
      allowFailures: false,
    },
  ])(
    "rejects $summary $runner summaries",
    async ({ runner, summary, data, expected, allowFailures }) => {
      if (summary === "missing") {
        await fs.rm(suiteSummaryPath);
      } else if (summary === "malformed") {
        await fs.writeFile(suiteSummaryPath, "{not-json", "utf8");
      } else {
        await writeSuiteSummary({ run: { status: "completed" }, ...data });
      }
      if (runner === "host") {
        runQaSuite.mockResolvedValueOnce(
          mockSuiteRuntimeResult("suite", { scenarios: data?.scenarios }),
        );
      }
      const run = runQaSuiteCommand({ repoRoot: "/tmp/openclaw-repo", runner, allowFailures });
      if (typeof expected === "string") {
        await expect(run).rejects.toThrow(expected);
      } else {
        await expect(run).rejects.toMatchObject(expected);
      }
    },
  );

  it.each(["full", "slim"] as const)(
    "captures taxonomy before the filtered %s profile suite runs",
    async (evidenceMode) => {
      const report = taxonomyModule.readQaScorecardTaxonomyReport(readQaScenarioPack().scenarios);
      const capturedIdentity = { ...report.taxonomy!.identity };
      vi.spyOn(taxonomyModule, "readQaScorecardTaxonomyReport").mockReturnValue(report);
      vi.stubEnv("OPENCLAW_QA_PROFILE", "release");
      runQaSuite.mockImplementationOnce(async (params) => {
        expect(process.env.OPENCLAW_QA_PROFILE).toBe("smoke-ci");
        report.taxonomy!.identity.sha256 = "0".repeat(64);
        report.profiles.find((entry) => entry.id === "smoke-ci")!.evidenceMode =
          evidenceMode === "full" ? "slim" : "full";
        await writeJson(
          suiteEvidencePath,
          makeQaEvidence([
            makeEvidenceEntry(
              "telegram-commands-command",
              "Telegram commands list reply",
              "telegram.built-in-commands",
            ),
          ]),
        );
        return mockSuiteRuntimeResult("flow", {
          observedCells: expandQaScenarioExecutionCells({
            scenarios: [readQaScenarioById("telegram-commands-command")],
            channelDriver: params?.channelDriver ?? "qa-channel",
            channel: params?.channelId,
            defaultChannel: OPENCLAW_CRABLINE_DEFAULT_CHANNEL,
            supportsChannel: isCrablineServerChannel,
            expandChannels: true,
          }),
        });
      });

      await parseQa(["run"], {
        "repo-root": "/tmp/openclaw-repo",
        "output-dir": ".artifacts/qa-e2e/smoke-ci",
        "qa-profile": "smoke-ci",
        "evidence-mode": evidenceMode === "full" ? "full" : "compact",
        "exclude-test-execution-evidence": evidenceMode === "slim",
        "fail-fast": true,
        surface: "telegram",
        category: "telegram.native-controls-and-approvals",
        scenario: ["telegram-commands-command"],
        transport: "qa-channel",
        fast: true,
        concurrency: 2,
        "allow-failures": true,
      });

      const suiteArgs = mockFirstObjectArg(runQaSuite);
      expectFields(suiteArgs, {
        repoRoot: path.resolve("/tmp/openclaw-repo"),
        outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa-e2e/smoke-ci"),
        transportId: "qa-channel",
        channelDriver: "crabline",
        providerMode: "mock-openai",
        fastMode: true,
        concurrency: 2,
      });
      expect(suiteArgs.failFast).toBe(true);
      expect(suiteArgs.channelId).toBe("telegram");
      expect(suiteArgs.scenarioIds).toEqual(["telegram-commands-command"]);
      expect(process.env.OPENCLAW_QA_PROFILE).toBe("release");
      const evidence = JSON.parse(
        await fs.readFile(suiteEvidencePath, "utf8"),
      ) as QaEvidenceSummaryJson;
      expect(evidence.profile).toBe("smoke-ci");
      expect(evidence.profilePlan?.counts).toMatchObject({
        membership: 1,
        selected: 1,
        excluded: 0,
        expectedCells: 1,
        observedCells: 1,
        missingCells: 0,
      });
      expect(evidence.profilePlan?.observedCells).toEqual(evidence.profilePlan?.expectedCells);
      expect(evidence.evidenceMode).toBe(evidenceMode);
      expect(evidence.profilePlan?.taxonomyIdentity).toEqual(capturedIdentity);
      expect(evidence.scorecard).toMatchObject({
        run: {
          evidenceEntryCount: 1,
        },
      });
      expect(evidence.scorecard).not.toHaveProperty("kind");
      expect(evidence.scorecard).not.toHaveProperty("taxonomy");
      expect(evidence.scorecard).not.toHaveProperty("profile");
      expect(evidence.scorecard?.categoryReports?.[0]).toMatchObject({
        id: "telegram.native-controls-and-approvals",
      });
      expect(Object.hasOwn(evidence.entries?.[0] as object, "execution")).toBe(
        evidenceMode === "full",
      );
      expect(JSON.stringify(evidence.scorecard)).not.toContain("telegram-commands-command");
      expectWriteContains(stdoutWrite, "QA run profile: smoke-ci; categories: 1; scenarios:");
      expectWriteContains(stdoutWrite, `QA profile scorecard: ${suiteEvidencePath}`);
    },
  );

  it("keeps portable channel scenarios in driver-selected profile runs", async () => {
    await runQaProfileCommand({
      repoRoot: "/tmp/openclaw-repo",
      profile: "release",
      surface: "channels",
      providerMode: "mock-openai",
      scenarioIds: ["channel-chat-baseline", "thread-follow-up"],
    });

    const suiteArgs = mockFirstObjectArg(runQaSuite);
    expect(suiteArgs.scenarioIds).toContain("channel-chat-baseline");
    expect(suiteArgs.scenarioIds).toContain("thread-follow-up");
    expect(suiteArgs.expandScenarioChannels).toBe(true);
    expect(suiteArgs.adapterFactories).toBe(
      listLiveTransportQaAdapterFactories.mock.results[0]?.value,
    );
  });

  it.each([
    {
      label: "implicit profile membership",
      scenarioIds: undefined,
      expectedExitCode: 0,
      explicitScenarioSelection: false,
    },
    {
      label: "explicit profile selection",
      scenarioIds: ["runtime-tool-image-generate"],
      expectedExitCode: 1,
      explicitScenarioSelection: true,
    },
  ])(
    "keeps optional skips $label blocking semantics",
    async ({ scenarioIds, expectedExitCode, explicitScenarioSelection }) => {
      const optionalScenario = {
        name: "Runtime tool fixture — image_generate",
        status: "skip" as const,
        details: "image_generate mock provider report-only: tool unavailable",
      };
      await writeSuiteSummary({
        run: { status: "completed" },
        counts: { total: 2, passed: 1, failed: 0, skipped: 1 },
        scenarios: [QA_PASSING_SUITE_SCENARIO, optionalScenario],
      });
      runQaSuite.mockImplementationOnce(async (params) => {
        const observedCells = executionCellsForSuiteParams(params);
        return mockSuiteRuntimeResult("flow", {
          observedCells,
          scenarios: [QA_PASSING_SUITE_SCENARIO, optionalScenario],
        });
      });

      await runQaProfileCommand({
        repoRoot: "/tmp/openclaw-repo",
        profile: "all",
        surface: "media",
        category: "media.media-generation",
        providerMode: "mock-openai",
        scenarioIds,
      });
      expect(process.exitCode).toBe(expectedExitCode);
      expect(mockFirstObjectArg(runQaSuite).adapterOptions).toMatchObject({
        explicitScenarioSelection,
      });
    },
  );

  it("filters QA-channel-pinned scenarios from an implicit Crabline driver profile", async () => {
    runQaSuite.mockImplementationOnce(async (params) => {
      await fs.writeFile(suiteEvidencePath, JSON.stringify(makeQaEvidence()), "utf8");
      const observedCells = executionCellsForSuiteParams(params);
      return mockSuiteRuntimeResult("flow", {
        observedCells,
      });
    });

    await runQaProfileCommand({
      repoRoot: "/tmp/openclaw-repo",
      profile: "smoke-ci",
    });

    const suiteArgs = mockFirstObjectArg(runQaSuite);
    expect(suiteArgs.channelDriver).toBe("crabline");
    expect(suiteArgs.scenarioIds).toContain("telegram-commands-command");
    const scenarioById = new Map(
      readQaScenarioPack().scenarios.map((scenario) => [scenario.id, scenario]),
    );
    expect(
      (suiteArgs.scenarioIds as string[]).every((scenarioId) => {
        const scenario = scenarioById.get(scenarioId);
        return (
          scenario?.execution.kind !== "flow" ||
          isCrablineServerChannel(scenario.execution.channel ?? OPENCLAW_CRABLINE_DEFAULT_CHANNEL)
        );
      }),
    ).toBe(true);
    expect(suiteArgs.scenarioIds).not.toContain("control-ui-qa-channel-image-roundtrip");
  });

  it.each([
    {
      options: { profile: "smoke-ci", scenarioIds: ["control-ui-qa-channel-image-roundtrip"] },
      error:
        "qa run --qa-profile smoke-ci cannot run explicitly selected scenario(s): control-ui-qa-channel-image-roundtrip (channelDriver=qa-channel).",
    },
    {
      options: { profile: "smoke-ci", surface: "unknown-surface" },
      error:
        "qa run did not find taxonomy categories for --qa-profile smoke-ci --surface unknown-surface.",
    },
    {
      options: {
        profile: "smoke-ci",
        category: "channels.outbound-delivery-and-reply-pipeline",
        scenarioIds: ["not-a-real-scenario"],
      },
      error:
        "qa run did not find taxonomy scenarios for --qa-profile smoke-ci --category channels.outbound-delivery-and-reply-pipeline --scenario not-a-real-scenario.",
    },
    {
      options: { profile: "nightly" },
      error:
        '--qa-profile must be one of smoke-ci, personal-agent, observability, release, all, got "nightly".',
    },
  ])("rejects invalid profile selection $options", async ({ options, error }) => {
    await expect(runQaProfileCommand(options)).rejects.toThrow(error);
    expect(runQaSuite).not.toHaveBeenCalled();
  });

  it("resolves suite repo-root-relative paths before dispatching", async () => {
    await parseQa(["suite"], {
      "repo-root": "/tmp/openclaw-repo",
      "output-dir": ".artifacts/qa/frontier",
      "provider-mode": "live-frontier",
      model: "openai/gpt-5.6-luna",
      "alt-model": "anthropic/claude-sonnet-4-6",
      fast: true,
      "fail-fast": true,
      thinking: "medium",
      "cli-auth-mode": "subscription",
      concurrency: 3,
      "enable-plugin": ["browser", "memory-core"],
      scenario: ["approval-turn-tool-followthrough"],
    });

    expect(runQaSuite).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa/frontier"),
      transportId: "qa-channel",
      channelDriver: undefined,
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "anthropic/claude-sonnet-4-6",
      fastMode: true,
      failFast: true,
      thinkingDefault: "medium",
      claudeCliAuthMode: "subscription",
      concurrency: 3,
      enabledPluginIds: ["browser", "memory-core"],
      scenarioIds: ["approval-turn-tool-followthrough"],
    });
  });

  it.each([
    { isolatesInstances: undefined, requested: 8, expected: 1 },
    { isolatesInstances: true, requested: undefined, expected: 4 },
    { isolatesInstances: true, requested: 8, expected: 4 },
  ])(
    "runs discovered live adapters with isolation=$isolatesInstances, concurrency=$requested at $expected workers",
    async ({ isolatesInstances, requested, expected }) => {
      vi.stubEnv("OPENCLAW_QA_SUITE_CONCURRENCY", "64");
      listLiveTransportQaAdapterFactories.mockReturnValue([
        {
          id: "telegram",
          isolatesInstances,
          matches: ({ channelId, driver }: { channelId: string; driver: string }) =>
            channelId === "telegram" && driver === "live",
          create: vi.fn(),
        },
      ]);
      await runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
        outputDir: ".artifacts/qa/telegram-live",
        channelDriver: "live",
        channel: "telegram",
        concurrency: requested,
        providerMode: "mock-openai",
        scenarioIds: ["channel-chat-baseline"],
      });

      expect(runQaSuite).toHaveBeenCalledWith(
        expect.objectContaining({
          adapterFactories: listLiveTransportQaAdapterFactories.mock.results[0]?.value,
          channelDriver: "live",
          channelId: "telegram",
          concurrency: expected,
          adapterOptions: expect.objectContaining({
            explicitScenarioSelection: true,
            repoRoot: path.resolve("/tmp/openclaw-repo"),
          }),
          scenarioIds: ["channel-chat-baseline"],
        }),
      );
    },
  );

  it("forwards resolved catalog scenarios for automatic mixed-channel host runs", async () => {
    await runQaSuiteCommand({
      providerMode: "mock-openai",
      channelDriver: "crabline",
    });

    const suiteArgs = mockFirstObjectArg(runQaSuite);
    expect(suiteArgs.channelId).toBeUndefined();
    expect(suiteArgs.scenarioIds).toEqual(
      expect.arrayContaining(["telegram-help-command", "matrix-restart-resume"]),
    );
    const scenarioById = new Map(
      readQaScenarioPack().scenarios.map((scenario) => [scenario.id, scenario]),
    );
    expect(
      (suiteArgs.scenarioIds as string[]).every(
        (scenarioId) => scenarioById.get(scenarioId)?.execution.kind === "flow",
      ),
    ).toBe(true);
  });

  it.each([
    [{ runtimePair: "openclaw,openclaw" }, /different runtimes/i],
    [{ runtimePair: "openclaw,,codex" }, /exactly two runtimes/i],
    [
      { runtimePair: "legacy-runtime,codex" },
      '--runtime-pair only supports "openclaw" and "codex".',
    ],
    [
      { scenarioIds: ["channel-chat-baseline"], concurrency: 1.5 },
      "--concurrency must be a positive integer",
    ],
    [{ runner: "multipass", preflight: true }, "--preflight requires --runner host."],
    [
      { runner: "host", image: "lts" },
      "--image, --cpus, --memory, and --disk require --runner multipass.",
    ],
    [
      {
        channelDriver: "crabline",
        runner: "multipass",
        scenarioIds: ["telegram-help-command", "matrix-restart-resume"],
      },
      "Selected QA scenarios require multiple channels (telegram, matrix)",
    ],
    [
      { runtimePair: "openclaw,codex", scenarioIds: ["hosted-image-generation-providers-live"] },
      "--runtime-pair requires execution.kind: flow scenarios; unsupported scenario(s): hosted-image-generation-providers-live (script)",
    ],
  ] satisfies Array<[Parameters<typeof runQaSuiteCommand>[0], string | RegExp]>)(
    "rejects invalid suite options %j before starting a harness",
    async (options, error) => {
      await expect(
        runQaSuiteCommand({
          providerMode: "mock-openai",
          scenarioIds: ["approval-turn-tool-followthrough"],
          ...options,
        }),
      ).rejects.toThrow(error);
      expect(runQaSuite).not.toHaveBeenCalled();
      expect(runQaMultipass).not.toHaveBeenCalled();
    },
  );

  it("resolves telegram qa repo-root-relative paths before dispatching", async () => {
    await runQaTelegramCommand({
      repoRoot: "/tmp/openclaw-repo",
      outputDir: ".artifacts/qa/telegram",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-luna",
      fastMode: true,
      scenarioIds: ["telegram-help-command"],
      sutAccountId: "sut-live",
    });

    expect(runQaFlowSuiteFromRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: path.resolve("/tmp/openclaw-repo"),
        outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa/telegram"),
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-luna",
        fastMode: true,
        channelDriver: "live",
        channelId: "telegram",
        adapterOptions: expect.objectContaining({ sutAccountId: "sut-live" }),
        scenarioIds: ["telegram-help-command"],
      }),
    );
  });

  it("rejects output dirs that escape the repo root", () => {
    expect(() => resolveRepoRelativeOutputDir("/tmp/openclaw-repo", "../outside")).toThrow(
      "--output-dir must stay within the repo root.",
    );
    expect(() => resolveRepoRelativeOutputDir("/tmp/openclaw-repo", "/tmp/outside")).toThrow(
      "--output-dir must be a relative path inside the repo root.",
    );
  });

  it("resolves the Telegram release profile when Commander supplies an empty scenario list", async () => {
    await parseQa(["telegram"], { "repo-root": "/tmp/openclaw-repo" });

    expect(runQaFlowSuiteFromRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioIds: expect.arrayContaining([
          "telegram-commands-command",
          "telegram-help-command",
          "telegram-other-bot-command-gating",
        ]),
      }),
    );
  });

  it("uses the trusted Telegram launcher for the shared suite gateway", async () => {
    const {
      candidateRoot,
      boundaryDir,
      launcherPath,
      runtimeTempParent,
      preloadPath,
      runtimeEntryPath,
    } = await prepareTelegramLauncher();
    await runQaTelegramCommand({
      repoRoot: candidateRoot,
      scenarioIds: ["telegram-help-command", "telegram-commands-command"],
    });

    const sutOpenClawCommand = {
      executablePath: launcherPath,
      tempParentDir: runtimeTempParent,
      usePackagedPlugins: true,
      processBoundary: {
        kind: "linux-proc-v1",
        evidenceDir: boundaryDir,
        expectedUid: 1001,
        expectedGid: 1002,
        forwardedEnvKeys: ["HOME", "PATH"],
        runtimeExecutablePath: process.execPath,
        runtimeArgsPrefix: ["--import", preloadPath, runtimeEntryPath],
        terminationRetryTimeoutMs: 60_000,
      },
    };
    expect(runQaFlowSuiteFromRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ sutOpenClawCommand }),
    );
  });

  it.each(["relative", "non-decimal-uid", "non-executable"] as const)(
    "rejects a %s Telegram launcher before starting a gateway",
    async (kind) => {
      let repoRoot: string | undefined;
      let expected: string;
      if (kind === "non-decimal-uid") {
        ({ candidateRoot: repoRoot } = await prepareTelegramLauncher());
        vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_UID", "0x3e9");
        expected = "OPENCLAW_QA_TELEGRAM_SUT_UID must be a positive integer.";
      } else {
        const launcherPath =
          kind === "relative"
            ? "relative-launcher"
            : path.join(telegramArtifactsDir, "non-executable-launcher");
        if (kind === "non-executable") {
          await fs.writeFile(launcherPath, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
        }
        vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_OPENCLAW_COMMAND", launcherPath);
        expected =
          kind === "relative"
            ? "OPENCLAW_QA_TELEGRAM_SUT_OPENCLAW_COMMAND must be an absolute file path."
            : `OPENCLAW_QA_TELEGRAM_SUT_OPENCLAW_COMMAND must point to an executable regular file: ${launcherPath}`;
      }
      await expect(
        runQaTelegramCommand({ repoRoot, scenarioIds: ["telegram-help-command"] }),
      ).rejects.toThrow(expected);
      expect(runQaFlowSuiteFromRuntime).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown mixed Telegram selections before resolving the SUT launcher", async () => {
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_OPENCLAW_COMMAND", "relative-launcher");
    await expect(
      runQaTelegramCommand({
        scenarioIds: ["telegram-help-command", "missing-telegram-scenario"],
      }),
    ).rejects.toThrow("unknown QA scenario id(s): missing-telegram-scenario");

    expect(runQaFlowSuiteFromRuntime).not.toHaveBeenCalled();
  });

  it("prints telegram scenario catalog without resolving the SUT launcher", async () => {
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_OPENCLAW_COMMAND", "relative-launcher");
    await runQaTelegramCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "mock-openai",
      listScenarios: true,
    });

    expect(runQaFlowSuiteFromRuntime).not.toHaveBeenCalled();
    expectWriteContains(
      stdoutWrite,
      "telegram-status-command\tdefault\tTelegram status command reply\tVerify Telegram status returns model, session, and activation details. refs=openclaw/openclaw#74698",
    );
  });

  it("retries host parity preflight once for qa-channel readiness timeouts", async () => {
    runQaFlowSuiteFromRuntime
      .mockRejectedValueOnce(
        new QaSuiteInfraError(
          "transport_ready_timeout",
          "timed out after 180000ms waiting for qa-channel ready; last status: no qa-channel accounts reported",
        ),
      )
      .mockResolvedValueOnce(mockSuiteRuntimeResult("flow", { scenarios: [] }).result);

    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      preflight: true,
    });

    expect(runQaFlowSuiteFromRuntime).toHaveBeenCalledTimes(2);
    expectWriteContains(
      stderrWrite,
      "[qa-suite] infra retry 1/1: timed out after 180000ms waiting for qa-channel ready",
    );
  });

  it("does not retry host suite runs for semantic failures", async () => {
    await writeSuiteSummary({
      run: { status: "completed" },
      counts: { total: 1, passed: 0, failed: 1 },
      scenarios: [{ name: "channel chat baseline", status: "fail" }],
    });
    runQaSuite.mockResolvedValueOnce(
      mockSuiteRuntimeResult("flow", {
        scenarios: [
          {
            name: "channel chat baseline",
            status: "fail",
            steps: [],
          },
        ],
      }),
    );

    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
    });
    expect(runQaSuite).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it.each([false, true])(
    "gates failing preflight sentinels with allowFailures=%s",
    async (allowFailures) => {
      const scenario = { name: "approval turn tool followthrough", status: "fail", steps: [] };
      await writeSuiteSummary({
        run: { status: "completed" },
        counts: { total: 1, passed: 0, failed: 1 },
        scenarios: [scenario],
      });
      runQaFlowSuiteFromRuntime.mockResolvedValueOnce(
        mockSuiteRuntimeResult("flow", { scenarios: [scenario] }).result,
      );
      const run = runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
        preflight: true,
        allowFailures,
      });
      if (allowFailures) {
        await run;
        expect(process.exitCode).toBe(0);
      } else {
        await expect(run).rejects.toThrow(
          "QA parity preflight failed with 1 failing or skipped scenario.",
        );
      }
    },
  );

  it("accepts comma-separated runtime-pair lane filters", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      runtimePairLane: ["extended,soak"],
    });

    expectFields(mockFirstObjectArg(runQaSuite), {
      scenarioIds: [
        "runtime-long-context-cache-stability",
        "runtime-soak-100-turn",
        "runtime-tool-memory-add",
        "runtime-tool-memory-recall",
        "runtime-tool-message-tool",
        "runtime-tool-skill-invocation",
        "runtime-tool-tavily-extract",
        "runtime-tool-tavily-search",
        "runtime-tool-tts",
        "internal-event-subagent-spawn-live",
      ],
    });
    expectWriteContains(
      stderrWrite,
      "excluded lane-incompatible scenario(s): runtime-tool-image-generate",
    );
  });

  it("keeps runtime-pair lane selection on flow scenarios and reports exclusions", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      runtimePair: "openclaw,codex",
      runtimePairLane: ["core"],
      parityPack: "agentic",
    });

    const scenarioIds = mockFirstObjectArg(runQaSuite).scenarioIds as string[];
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
    expect(scenarioIds).toContain("runtime-first-hour-20-turn");
    expect(scenarioIds).not.toContain("gateway-restart-inflight-run");
    expect(scenarioIds).toContain("streaming-final-integrity");
    expect(scenarioIds).not.toContain("hosted-image-generation-providers-live");
    expect(scenarioIds).not.toContain("hosted-video-generation-providers-live");
    expectFields(mockFirstObjectArg(runQaSuite), {
      runtimePair: ["openclaw", "codex"],
    });
    expectWriteContains(
      stderrWrite,
      "excluded incompatible non-flow scenario(s): codex-plugin-cold-install (script)",
    );
  });

  it("rejects runtime-pair lanes with no compatible flow scenarios", async () => {
    const catalog = readQaScenarioPack();
    const coldInstallScenario = catalog.scenarios.find(
      (scenario) => scenario.id === "codex-plugin-cold-install",
    );
    if (!coldInstallScenario) {
      throw new Error("missing Codex cold-install scenario fixture");
    }
    readQaScenarioPack.mockReturnValueOnce({
      ...catalog,
      scenarios: [coldInstallScenario],
    });

    await expect(
      runQaSuiteCommand({
        runtimePair: "openclaw,codex",
        runtimePairLane: ["core"],
      }),
    ).rejects.toThrow(
      "--runtime-pair-lane matched no execution.kind: flow scenarios for core; incompatible scenario(s): codex-plugin-cold-install (script).",
    );

    expect(runQaSuite).not.toHaveBeenCalled();
  });

  it("sets a failing exit code when the parity gate fails", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-parity-");

    for (const name of ["candidate", "baseline"]) {
      await writeJson(path.join(repoRoot, `${name}.json`), {
        run: { status: "completed" },
        scenarios: [{ name: "Approval turn tool followthrough", status: "pass" }],
      });
    }

    await runQaParityReportCommand({
      repoRoot,
      candidateSummary: "candidate.json",
      baselineSummary: "baseline.json",
    });

    expect(process.exitCode).toBe(1);
  });

  it.each([
    { status: "pass", runtimeErrorClass: "tool-error" },
    { status: "skip", details: "known-harness-gap fixture: unavailable" },
  ])("writes a runtime-axis parity report preserving $status", async (cellOutcome) => {
    const repoRoot = await tempDirs.makeTempDir("qa-runtime-parity-");

    const summary = makeRuntimeParitySummary();
    const scenario = summary.scenarios[1];
    if (!scenario?.runtimeParity) {
      throw new Error("runtime parity fixture missing");
    }
    scenario.status = "fail";
    Object.assign(scenario.runtimeParity.cells.codex, cellOutcome);
    await writeJson(path.join(repoRoot, "runtime-summary.json"), {
      ...summary,
      scenarios: [scenario],
      counts: { total: 1, passed: 1, failed: 0 },
      run: { ...summary.run, status: "completed" },
    });

    await runQaParityReportCommand({
      repoRoot,
      runtimeAxis: true,
      summary: "runtime-summary.json",
      outputDir: "report",
    });

    const reportDir = path.join(repoRoot, "report");
    const report = JSON.parse(
      await fs.readFile(path.join(reportDir, "qa-runtime-parity-summary.json"), "utf8"),
    );
    expect(report.scenarios[0].codexStatus).toBe(cellOutcome.status);
    expect(
      await fs.readFile(path.join(reportDir, "qa-runtime-parity-report.md"), "utf8"),
    ).toContain(`- codex: ${cellOutcome.status} (`);
    expect(process.exitCode).toBe(0);
    expectWriteContains(stdoutWrite, "QA runtime parity report:");
    expectWriteContains(stdoutWrite, "QA runtime parity verdict: pass");
  });

  it("writes a runtime-axis token-efficiency report when requested", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-runtime-token-efficiency-");

    const summary = runtimeSummary("runtime-tool-fs-read");
    summary.run.providerMode = "live-frontier";
    const cells = summary.scenarios[0].runtimeParity.cells;
    Object.assign(cells.openclaw, {
      toolCalls: [{ tool: "fs.read", argsHash: "a", resultHash: "r" }],
      usage: { inputTokens: 72_000, outputTokens: 381, totalTokens: 72_381 },
      wallClockMs: 10,
    });
    Object.assign(cells.codex, {
      toolCalls: Array.from({ length: 40 }, (_, index) => ({
        tool: "fs.read",
        argsHash: `a-${index}`,
        resultHash: `r-${index}`,
      })),
      usage: { inputTokens: 118_000, outputTokens: 1_489, totalTokens: 119_489 },
      wallClockMs: 10,
    });
    await writeJson(path.join(repoRoot, "runtime-summary.json"), summary);

    await runQaParityReportCommand({
      repoRoot,
      runtimeAxis: true,
      summary: "runtime-summary.json",
      tokenEfficiency: true,
    });

    expect(process.exitCode).toBe(1);
    expectWriteContains(stdoutWrite, "QA runtime parity verdict: pass");
    expectWriteContains(stdoutWrite, "QA runtime token efficiency report:");
    expectWriteContains(stdoutWrite, "QA runtime token efficiency verdict: fail");
    const [artifactDir] = await fs.readdir(path.join(repoRoot, ".artifacts", "qa-e2e"));
    const tokenSummary = JSON.parse(
      await fs.readFile(
        path.join(
          repoRoot,
          ".artifacts/qa-e2e",
          artifactDir ?? "",
          "qa-runtime-token-efficiency-summary.json",
        ),
        "utf8",
      ),
    ) as { aggregate?: { flaggedScenarios?: string[] } };
    expect(tokenSummary.aggregate?.flaggedScenarios).toEqual(["runtime-tool-fs-read"]);
  });

  describe("coverage inventory command", () => {
    it("prints a markdown report from scenario metadata", async () => {
      await parseQa(["coverage"]);

      expectWriteContains(stdoutWrite, "# QA Coverage Inventory");
      expectWriteContains(stdoutWrite, "session-memory.embedding-search-recall");
    });
  });

  it("prints a markdown tool coverage inventory without a run summary", async () => {
    await runQaCoverageReportCommand({ tools: true });
    expectWriteContains(stdoutWrite, "# OpenClaw Runtime Tool Coverage");
    expectWriteContains(stdoutWrite, "codex-native-workspace");
  });

  it("uses provider defaults for omitted manual models", async () => {
    await runQaManualLaneCommand({ message: "probe" });
    expect(mockFirstObjectArg(runQaManualLane)).toMatchObject({
      providerMode: "live-frontier",
      primaryModel: defaultQaProviderModelForMode("live-frontier"),
      alternateModel: "openai/gpt-5.6-terra",
    });
  });

  it("prints a focused scenario match report from coverage metadata", async () => {
    await runQaCoverageReportCommand({
      repoRoot: process.cwd(),
      match: ["image roundtrip"],
    });

    expectWriteContains(stdoutWrite, "# QA Scenario Matches");
    expectWriteContains(stdoutWrite, "image-generation-roundtrip");
    expectWriteContains(stdoutWrite, "--scenario image-generation-roundtrip");
    expect(stdoutWrite.mock.calls.flat().join("")).not.toContain("memory-recall");
  });

  it("rejects null tool coverage summary JSON", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-tool-coverage-null-");
    await fs.writeFile(path.join(repoRoot, "runtime-summary.json"), "null\n", "utf8");
    await expect(
      runQaCoverageReportCommand({
        repoRoot,
        tools: true,
        summary: "runtime-summary.json",
        json: true,
      }),
    ).rejects.toMatchObject({ code: "summary_not_completed" });
    expect(process.exitCode).toBe(0);
  });

  it("writes a curated mock JSONL replay report and summary", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-jsonl-replay-cli-");
    await parseQa(["jsonl-replay"], {
      "repo-root": repoRoot,
      transcripts: path.resolve("qa/scenarios/jsonl-replay"),
      "output-dir": "jsonl-output",
      "runtime-pair": "openclaw,codex",
    });

    const report = await fs.readFile(
      path.join(repoRoot, "jsonl-output", "qa-jsonl-replay-report.md"),
      "utf8",
    );
    const summary = JSON.parse(
      await fs.readFile(
        path.join(repoRoot, "jsonl-output", "qa-jsonl-replay-summary.json"),
        "utf8",
      ),
    ) as { transcripts?: Array<{ userTurnCount?: number }> };

    expect(report).toContain("# OpenClaw JSONL Replay Report - openclaw vs codex");
    expect(report).toContain("| plan-mode-boundaries.jsonl | 3 |  | none, none, none |");
    expect(summary.transcripts).toHaveLength(7);
  });

  it("exits nonzero when tool coverage summary is missing a required runtime tool call", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-tool-coverage-");
    const summary = runtimeSummary("runtime-tool-web-search");
    const scenario = summary.scenarios[0];
    scenario.status = "fail";
    summary.counts = { total: 1, passed: 0, failed: 1 };
    scenario.runtimeParity.drift = "tool-call-shape";
    scenario.runtimeParity.driftDetails = "Codex emitted no web_search call";
    Object.assign(scenario.runtimeParity.cells.openclaw, {
      transcriptBytes: "",
      toolCalls: [{ tool: "web_search", argsHash: "a", resultHash: "r" }],
      finalText: "",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      wallClockMs: 1,
    });
    Object.assign(scenario.runtimeParity.cells.codex, {
      transcriptBytes: "",
      toolCalls: [],
      finalText: "",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      wallClockMs: 1,
    });
    await writeJson(path.join(repoRoot, "runtime-summary.json"), summary);

    await runQaCoverageReportCommand({
      repoRoot,
      tools: true,
      summary: "runtime-summary.json",
    });

    expect(process.exitCode).toBe(1);
    expectWriteContains(stdoutWrite, "- Verdict: fail");
    expectWriteContains(
      stdoutWrite,
      "web_search missing successful codex tool call/result web_search",
    );
  });

  it("resolves character eval paths and passes model refs through", async () => {
    await runQaCharacterEvalCommand({
      repoRoot: "/tmp/openclaw-repo",
      outputDir: ".artifacts/qa/character",
      model: [
        "openai/gpt-5.6-luna,thinking=xhigh,fast=false",
        "codex-cli/test-model,thinking=high,fast",
      ],
      scenario: "character-vibes-gollum",
      fast: true,
      thinking: "medium",
      modelThinking: ["codex-cli/test-model=medium"],
      judgeModel: [
        "openai/gpt-5.6-luna,thinking=xhigh,fast",
        "anthropic/claude-opus-4-8,thinking=high",
      ],
      judgeTimeoutMs: 180_000,
      blindJudgeModels: true,
      concurrency: 4,
      judgeConcurrency: 3,
    });

    const characterEvalArgs = mockFirstObjectArg(runQaCharacterEval);
    expect(typeof characterEvalArgs.progress).toBe("function");
    expectFields(characterEvalArgs, {
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa/character"),
      models: ["openai/gpt-5.6-luna", "codex-cli/test-model"],
      scenarioId: "character-vibes-gollum",
      candidateFastMode: true,
      candidateThinkingDefault: "medium",
      candidateThinkingByModel: { "codex-cli/test-model": "medium" },
      candidateModelOptions: {
        "openai/gpt-5.6-luna": { thinkingDefault: "xhigh", fastMode: false },
        "codex-cli/test-model": { thinkingDefault: "high", fastMode: true },
      },
      judgeModels: ["openai/gpt-5.6-luna", "anthropic/claude-opus-4-8"],
      judgeModelOptions: {
        "openai/gpt-5.6-luna": { thinkingDefault: "xhigh", fastMode: true },
        "anthropic/claude-opus-4-8": { thinkingDefault: "high" },
      },
      judgeTimeoutMs: 180_000,
      judgeBlindModels: true,
      candidateConcurrency: 4,
      judgeConcurrency: 3,
    });
  });

  it.each([
    {
      label: "candidate failure",
      runs: [{ model: "qa/candidate", status: "fail" }],
      judgments: [{ model: "qa/judge", rankings: [{ model: "qa/candidate", rank: 1 }] }],
      expectedVerdict: "QA character eval failed: 1 candidate(s), 0 judge(s).",
    },
    {
      label: "judge failure",
      runs: [{ model: "qa/candidate", status: "pass" }],
      judgments: [{ model: "qa/judge", rankings: [], error: "judge unavailable" }],
      expectedVerdict: "QA character eval failed: 0 candidate(s), 1 judge(s).",
    },
  ])("returns a failing exit code on $label without hiding artifacts", async (failure) => {
    runQaCharacterEval.mockResolvedValueOnce({
      reportPath: "/tmp/character-report.md",
      summaryPath: "/tmp/character-summary.json",
      runs: failure.runs,
      judgments: failure.judgments,
    });
    await runQaCharacterEvalCommand({ model: ["qa/candidate"] });

    expect(process.exitCode).toBe(1);
    expectWriteContains(stderrWrite, failure.expectedVerdict);
    expectWriteContains(stdoutWrite, "QA character eval report: /tmp/character-report.md");
    expectWriteContains(stdoutWrite, "QA character eval summary: /tmp/character-summary.json");
  });

  it("rejects invalid character eval thinking levels", async () => {
    function rejects(options: Parameters<typeof runQaCharacterEvalCommand>[0], message: string) {
      return expect(runQaCharacterEvalCommand(options)).rejects.toThrow(message);
    }
    await rejects({ thinking: "enormous" }, "--thinking must be one of");
    await rejects(
      { model: ["openai/gpt-5.6-luna,thinking=galaxy"] },
      "--model thinking must be one of",
    );
    await rejects(
      { model: ["openai/gpt-5.6-luna,warp"] },
      "--model options must be thinking=<level>",
    );
    await rejects(
      { modelThinking: ["openai/gpt-5.6-luna"] },
      "--model-thinking must use provider/model=level",
    );
  });

  it("passes the explicit repo root into manual runs", async () => {
    await parseQa(["manual"], {
      "repo-root": "/tmp/openclaw-repo",
      "provider-mode": "live-frontier",
      model: "openai/gpt-5.6-luna",
      message: "read qa kickoff and reply short",
      "timeout-ms": 45_000,
    });

    expect(runQaManualLane).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      transportId: "qa-channel",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-luna",
      fastMode: undefined,
      message: "read qa kickoff and reply short",
      timeoutMs: 45_000,
    });
  });

  it("routes suite runs through multipass when the runner is selected", async () => {
    await parseQa(["suite"], {
      "repo-root": "/tmp/openclaw-repo",
      "output-dir": ".artifacts/qa-multipass",
      runner: "multipass",
      "provider-mode": "mock-openai",
      scenario: ["channel-chat-baseline"],
      "allow-failures": true,
      concurrency: 3,
      "runtime-pair": "openclaw,codex",
      "channel-driver": "crabline",
      channel: "telegram",
      "enable-plugin": ["browser", "memory-core"],
      image: "lts",
      cpus: 2,
      memory: "4G",
      disk: "24G",
    });

    expect(runQaMultipass).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa-multipass"),
      transportId: "qa-channel",
      providerMode: "mock-openai",
      primaryModel: undefined,
      alternateModel: undefined,
      fastMode: undefined,
      allowFailures: true,
      scenarioIds: ["channel-chat-baseline"],
      concurrency: 3,
      runtimePair: ["openclaw", "codex"],
      channelDriver: "crabline",
      channelId: "telegram",
      enabledPluginIds: ["browser", "memory-core"],
      image: "lts",
      cpus: 2,
      memory: "4G",
      disk: "24G",
    });
    expect(runQaSuite).not.toHaveBeenCalled();
  });

  it.each([
    { allowFailures: false, counts: { total: 2, passed: 1, failed: 0, skipped: 1 }, exitCode: 1 },
    { allowFailures: true, counts: { total: 2, passed: 1, failed: 1 }, exitCode: 0 },
  ])(
    "gates Multipass outcomes with allowFailures=$allowFailures",
    async ({ allowFailures, counts, exitCode }) => {
      await writeSuiteSummary({ run: { status: "completed" }, counts });
      await runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
        runner: "multipass",
        allowFailures,
      });
      expect(process.exitCode).toBe(exitCode);
    },
  );

  it("fails unsuccessful self-checks after stopping the lab server", async () => {
    const stop = vi.fn();
    startQaLabServer.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:58000",
      runSelfCheck: vi.fn().mockResolvedValue({
        outputPath: "/tmp/failed-report.md",
        report: "",
        checks: [{ name: "QA self-check scenario", status: "fail" }],
        scenarioResult: {
          name: "QA self-check scenario",
          status: "fail",
          steps: [],
        },
      }),
      stop,
    });

    await expect(
      parseQa(["run"], {
        "repo-root": "/tmp/openclaw-repo",
        output: ".artifacts/qa/self-check.md",
      }),
    ).rejects.toThrow("QA self-check failed. See /tmp/failed-report.md.");

    expect(startQaLabServer).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputPath: path.resolve("/tmp/openclaw-repo", ".artifacts/qa/self-check.md"),
    });
    expect(stop).toHaveBeenCalledOnce();
    expectWriteContains(stdoutWrite, "QA self-check report: /tmp/failed-report.md");
  });

  it("rejects oversized credential payload files before broker setup", async () => {
    const payloadPath = path.join(suiteArtifactsDir, "oversized-credential.json");
    await fs.writeFile(payloadPath, JSON.stringify({ blob: "x".repeat(64) }), "utf8");
    vi.stubEnv("OPENCLAW_QA_CREDENTIAL_PAYLOAD_MAX_BYTES", "32");
    await expect(
      parseQa(["credentials", "add"], { kind: "telegram", "payload-file": payloadPath }),
    ).rejects.toThrow("Payload file exceeds OPENCLAW_QA_CREDENTIAL_PAYLOAD_MAX_BYTES (32 bytes).");
  });

  it("routes image builds to the requested repository", async () => {
    buildQaDockerHarnessImage.mockResolvedValueOnce({ imageName: "openclaw:qa-test" });
    await parseQa(["docker-build-image"], {
      "repo-root": "/tmp/openclaw-repo",
      image: "openclaw:qa-test",
    });
    expect(buildQaDockerHarnessImage).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      imageName: "openclaw:qa-test",
    });
  });

  it("rejects token-efficiency reports without a runtime axis", async () => {
    await expect(runQaParityReportCommand({ tokenEfficiency: true })).rejects.toThrow(
      "--token-efficiency requires --runtime-axis.",
    );
  });

  it("resolves docker scaffold paths relative to the explicit repo root", async () => {
    await runQaDockerScaffoldCommand({
      repoRoot: "/tmp/openclaw-repo",
      outputDir: ".artifacts/qa-docker",
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      usePrebuiltImage: true,
    });

    expect(writeQaDockerHarnessFiles).toHaveBeenCalledWith({
      outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa-docker"),
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      gatewayPort: undefined,
      qaLabPort: undefined,
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      imageName: undefined,
      usePrebuiltImage: true,
    });
  });

  it("resolves docker up paths relative to the explicit repo root", async () => {
    await runQaDockerUpCommand({
      repoRoot: "/tmp/openclaw-repo",
      outputDir: ".artifacts/qa-up",
      usePrebuiltImage: true,
      skipUiBuild: true,
    });

    expect(runQaDockerUp).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa-up"),
      gatewayPort: undefined,
      qaLabPort: undefined,
      providerBaseUrl: undefined,
      image: undefined,
      usePrebuiltImage: true,
      skipUiBuild: true,
    });
  });
  it.each([
    {
      command: "run",
      flags: {
        transport: "discord",
        scenario: "discord-status-reactions-tool-only",
        baseline: "origin/main",
        candidate: "HEAD",
        "skip-install": true,
        "skip-build": true,
      },
      mock: runMantisBeforeAfterCommand,
      expected: {
        baseline: "origin/main",
        candidate: "HEAD",
        transport: "discord",
        scenario: "discord-status-reactions-tool-only",
        credentialSource: "convex",
        credentialRole: "ci",
        fastMode: true,
        providerMode: "live-frontier",
        signal: expect.any(AbortSignal),
        skipBuild: true,
        skipInstall: true,
      },
    },
    {
      command: "desktop-browser-smoke",
      flags: { class: "beast", "keep-lease": true },
      mock: runMantisDesktopBrowserSmokeCommand,
      expected: { machineClass: "beast", keepLease: true },
    },
    {
      command: "slack-desktop-smoke",
      flags: {
        "machine-class": "beast",
        model: "openai/gpt-5.6-luna",
        "alt-model": "openai/gpt-5.6-terra",
        scenario: "slack-canary",
        fast: true,
      },
      mock: runMantisSlackDesktopSmokeCommand,
      expected: {
        machineClass: "beast",
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-terra",
        scenarioIds: ["slack-canary"],
        fastMode: true,
        gatewaySetup: undefined,
      },
    },
  ] satisfies Array<{
    command: string;
    flags: Parameters<typeof parseQa>[1];
    mock: typeof runMantisBeforeAfterCommand;
    expected: Record<string, unknown>;
  }>)(
    "routes Mantis $command options and authority",
    async ({ command, flags, mock, expected }) => {
      await parseQa(["mantis", command], flags);
      expect(mock).toHaveBeenCalledWith(expected);
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
