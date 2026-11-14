import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isCrablineServerChannel, OPENCLAW_CRABLINE_DEFAULT_CHANNEL } from "@openclaw/crabline";
import { Command } from "commander";
import type { QaRunnerCliContribution } from "openclaw/plugin-sdk/qa-runner-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSingleRuntimeParitySummary as runtimeSummary } from "./agentic-parity-report-test-helpers.js";
import type { QaScenarioPack } from "./scenario-catalog.js";
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
import { runQaParityReportCommand } from "./cli-report.runtime.js";
import { registerQaLabCli } from "./cli.js";
import {
  runQaDockerScaffoldCommand,
  runQaDockerUpCommand,
  runQaCharacterEvalCommand,
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
  expect(Object.fromEntries(Object.keys(expected).map((key) => [key, record[key]]))).toEqual(
    expected,
  );
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

  const runSuite = (options: Parameters<typeof runQaSuiteCommand>[0]) =>
    runQaSuiteCommand({ repoRoot: "/tmp/openclaw-repo", ...options });
  const runProfile = (options: Parameters<typeof runQaProfileCommand>[0]) =>
    runQaProfileCommand({ repoRoot: "/tmp/openclaw-repo", ...options });
  const readArtifact = (file: string) => fs.readFile(file, "utf8");
  const parseAtRepo = (command: string, flags: Parameters<typeof parseQa>[1] = {}) =>
    parseQa([command], { "repo-root": LEGACY_TEST_REPO_ROOT, ...flags });
  const withOutput = { repoRoot: LEGACY_TEST_REPO_ROOT, outputDir: "out" };

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
    for (const mock of [
      runQaFlowSuiteFromRuntime,
      runQaSuite,
      runQaCharacterEval,
      runQaManualLane,
      runQaMultipass,
      listLiveTransportQaAdapterFactories,
      startQaLabServer,
      writeQaDockerHarnessFiles,
      buildQaDockerHarnessImage,
      runQaDockerUp,
    ]) {
      mock.mockReset();
    }
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
          observedCells: executionCellsForSuiteParams(params),
        });
      });

      await parseQa(["run"], {
        "repo-root": "/tmp/openclaw-repo",
        "output-dir": ".artifacts/qa-e2e/smoke-ci",
        "qa-profile": "smoke-ci",
        "evidence-mode": evidenceMode === "full" ? "full" : "compact",
        "exclude-test-execution-evidence": evidenceMode === "slim",
        surface: "telegram",
        category: "telegram.native-controls-and-approvals",
        scenario: ["telegram-commands-command"],
        "provider-mode": "mock-openai",
        "allow-failures": true,
      });

      const suiteArgs = mockFirstObjectArg(runQaSuite);
      expect(suiteArgs).toMatchObject({
        channelId: "telegram",
        scenarioIds: ["telegram-commands-command"],
      });
      expect(process.env.OPENCLAW_QA_PROFILE).toBe("release");
      const evidence = JSON.parse(await readArtifact(suiteEvidencePath)) as QaEvidenceSummaryJson;
      expect(evidence).toMatchObject({
        profile: "smoke-ci",
        evidenceMode,
        profilePlan: {
          counts: { selected: 1, missingCells: 0 },
        },
        scorecard: {
          run: { evidenceEntryCount: 1 },
        },
      });
      expect(evidence.profilePlan?.observedCells).toEqual(evidence.profilePlan?.expectedCells);
      expect(evidence.profilePlan?.taxonomyIdentity).toEqual(capturedIdentity);
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

  it("keeps optional skips non-blocking for implicit profile membership", async () => {
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
    runQaSuite.mockImplementationOnce(async (params) =>
      mockSuiteRuntimeResult("flow", {
        observedCells: executionCellsForSuiteParams(params),
        scenarios: [QA_PASSING_SUITE_SCENARIO, optionalScenario],
      }),
    );

    await runProfile({
      profile: "all",
      surface: "media",
      category: "media.media-generation",
      providerMode: "mock-openai",
    });
    expect(process.exitCode).toBe(0);
    expect(mockFirstObjectArg(runQaSuite).adapterOptions).toMatchObject({
      explicitScenarioSelection: false,
    });
  });

  it("filters QA-channel-pinned scenarios from an implicit Crabline driver profile", async () => {
    runQaSuite.mockImplementationOnce(async (params) => {
      await fs.writeFile(suiteEvidencePath, JSON.stringify(makeQaEvidence()), "utf8");
      return mockSuiteRuntimeResult("flow", {
        observedCells: executionCellsForSuiteParams(params),
      });
    });

    await runProfile({
      profile: "smoke-ci",
    });

    const suiteArgs = mockFirstObjectArg(runQaSuite);
    expect(suiteArgs.channelDriver).toBe("crabline");
    expect(suiteArgs.scenarioIds).toContain("telegram-commands-command");
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

  it.each([
    { isolatesInstances: undefined, requested: 8, expected: 1 },
    { isolatesInstances: true, requested: undefined, expected: 4 },
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
      await runSuite({
        outputDir: ".artifacts/qa/telegram-live",
        channelDriver: "live",
        channel: "telegram",
        concurrency: requested,
        providerMode: "mock-openai",
        scenarioIds: ["channel-chat-baseline"],
      });

      expectFields(mockFirstObjectArg(runQaSuite), {
        adapterFactories: listLiveTransportQaAdapterFactories.mock.results[0]?.value,
        channelDriver: "live",
        channelId: "telegram",
        concurrency: expected,
        adapterOptions: expect.objectContaining({
          explicitScenarioSelection: true,
          repoRoot: path.resolve("/tmp/openclaw-repo"),
        }),
        scenarioIds: ["channel-chat-baseline"],
      });
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

    expectFields(mockFirstObjectArg(runQaFlowSuiteFromRuntime), {
      scenarioIds: expect.arrayContaining([
        "telegram-commands-command",
        "telegram-help-command",
        "telegram-other-bot-command-gating",
      ]),
    });
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

    await runSuite({ preflight: true });

    expect(runQaFlowSuiteFromRuntime).toHaveBeenCalledTimes(2);
    expectWriteContains(
      stderrWrite,
      "[qa-suite] infra retry 1/1: timed out after 180000ms waiting for qa-channel ready",
    );
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
      const run = runSuite({ preflight: true, allowFailures });
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
    await runSuite({ runtimePairLane: ["extended,soak"] });

    expectFields(mockFirstObjectArg(runQaSuite), {
      scenarioIds: expect.arrayContaining(["runtime-soak-100-turn", "runtime-tool-memory-add"]),
    });
    expectWriteContains(
      stderrWrite,
      "excluded lane-incompatible scenario(s): runtime-tool-image-generate",
    );
  });

  it("keeps runtime-pair lane selection on flow scenarios and reports exclusions", async () => {
    await runSuite({
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

    const summary = runtimeSummary(1);
    const scenario = summary.scenarios[0];
    scenario.status = "fail";
    Object.assign(scenario.runtimeParity.cells.codex, cellOutcome);
    await writeJson(path.join(repoRoot, "runtime-summary.json"), summary);

    await runQaParityReportCommand({
      repoRoot,
      runtimeAxis: true,
      summary: "runtime-summary.json",
      outputDir: "report",
    });

    const reportDir = path.join(repoRoot, "report");
    const report = JSON.parse(
      await readArtifact(path.join(reportDir, "qa-runtime-parity-summary.json")),
    );
    expect(report.scenarios[0].codexStatus).toBe(cellOutcome.status);
    expect(await readArtifact(path.join(reportDir, "qa-runtime-parity-report.md"))).toContain(
      `- codex: ${cellOutcome.status} (`,
    );
    expect(process.exitCode).toBe(0);
    expectWriteContains(stdoutWrite, "QA runtime parity report:");
    expectWriteContains(stdoutWrite, "QA runtime parity verdict: pass");
  });

  it("writes a runtime-axis token-efficiency report when requested", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-runtime-token-efficiency-");

    const summary = runtimeSummary(0, "runtime-tool-fs-read");
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
    const reportDir = path.join(repoRoot, ".artifacts/qa-e2e", artifactDir ?? "");
    const tokenSummary = JSON.parse(
      await readArtifact(path.join(reportDir, "qa-runtime-token-efficiency-summary.json")),
    ) as { aggregate?: { flaggedScenarios?: string[] } };
    expect(tokenSummary.aggregate?.flaggedScenarios).toEqual(["runtime-tool-fs-read"]);
  });

  it("uses provider defaults for omitted manual models", async () => {
    await runQaManualLaneCommand({ message: "probe" });
    expect(mockFirstObjectArg(runQaManualLane)).toMatchObject({
      providerMode: "live-frontier",
      primaryModel: defaultQaProviderModelForMode("live-frontier"),
      alternateModel: "openai/gpt-5.6-terra",
    });
  });

  it("writes a curated mock JSONL replay report and summary", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-jsonl-replay-cli-");
    await parseQa(["jsonl-replay"], {
      "repo-root": repoRoot,
      transcripts: path.resolve("qa/scenarios/jsonl-replay"),
      "output-dir": "jsonl-output",
      "runtime-pair": "openclaw,codex",
      "provider-mode": "mock-openai",
    });

    const report = await readArtifact(
      path.join(repoRoot, "jsonl-output", "qa-jsonl-replay-report.md"),
    );
    const summary = JSON.parse(
      await readArtifact(path.join(repoRoot, "jsonl-output", "qa-jsonl-replay-summary.json")),
    ) as { transcripts?: Array<{ userTurnCount?: number }> };

    expect(report).toContain("# OpenClaw JSONL Replay Report - openclaw vs codex");
    expect(report).toContain("| plan-mode-boundaries.jsonl | 3 |  | none, none, none |");
    expect(summary.transcripts).toHaveLength(7);
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

  it("returns a failing exit code on judge failure without hiding artifacts", async () => {
    runQaCharacterEval.mockResolvedValueOnce({
      reportPath: "/tmp/character-report.md",
      summaryPath: "/tmp/character-summary.json",
      runs: [{ model: "qa/candidate", status: "pass" }],
      judgments: [{ model: "qa/judge", rankings: [], error: "judge unavailable" }],
    });
    await runQaCharacterEvalCommand({ model: ["qa/candidate"] });

    expect(process.exitCode).toBe(1);
    expectWriteContains(stderrWrite, "QA character eval failed: 0 candidate(s), 1 judge(s).");
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

  it("gates Multipass skipped scenarios with allowFailures=false", async () => {
    await writeSuiteSummary({
      run: { status: "completed" },
      counts: { total: 2, passed: 1, failed: 0, skipped: 1 },
    });
    await runSuite({ runner: "multipass", allowFailures: false });
    expect(process.exitCode).toBe(1);
  });

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

    await parseQa(["run"], {
      "repo-root": "/tmp/openclaw-repo",
      output: ".artifacts/qa/self-check.md",
    });
    expectWriteContains(stderrWrite, "QA self-check failed. See /tmp/failed-report.md.");
    expect(process.exitCode).toBe(1);

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
    await parseQa(["credentials", "add"], { kind: "telegram", "payload-file": payloadPath });
    expectWriteContains(
      stderrWrite,
      "Payload file exceeds OPENCLAW_QA_CREDENTIAL_PAYLOAD_MAX_BYTES (32 bytes).",
    );
    expect(process.exitCode).toBe(1);
  });

  it.each([
    [
      "suite",
      () =>
        parseAtRepo("suite", {
          "output-dir": "out",
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
        }),
      runQaSuite,
      true,
    ],
    [
      "Telegram",
      () =>
        runQaTelegramCommand({
          ...withOutput,
          scenarioIds: ["telegram-help-command"],
          sutAccountId: "sut-live",
        }),
      runQaFlowSuiteFromRuntime,
      true,
    ],
    [
      "manual",
      () =>
        parseAtRepo("manual", {
          "provider-mode": "live-frontier",
          model: "openai/gpt-5.6-luna",
          message: "probe",
          "timeout-ms": 45000,
        }),
      runQaManualLane,
      false,
    ],
    [
      "Multipass",
      () =>
        parseAtRepo("suite", {
          "output-dir": "out",
          runner: "multipass",
          "provider-mode": "mock-openai",
          scenario: ["channel-chat-baseline"],
          "allow-failures": true,
          "runtime-pair": "openclaw,codex",
          "channel-driver": "crabline",
          channel: "telegram",
          image: "lts",
          cpus: 2,
          memory: "4G",
          disk: "24G",
        }),
      runQaMultipass,
      true,
    ],
    [
      "Docker image",
      () =>
        parseAtRepo("docker-build-image", {
          image: "openclaw:qa-test",
        }),
      buildQaDockerHarnessImage,
      false,
    ],
    [
      "Docker scaffold",
      () =>
        runQaDockerScaffoldCommand({
          ...withOutput,
          providerBaseUrl: "http://127.0.0.1:44080/v1",
          usePrebuiltImage: true,
        }),
      writeQaDockerHarnessFiles,
      true,
    ],
    [
      "Docker up",
      () =>
        runQaDockerUpCommand({
          ...withOutput,
          usePrebuiltImage: true,
          skipUiBuild: true,
        }),
      runQaDockerUp,
      true,
    ],
  ] as const)("resolves %s paths before dispatch", async (_name, run, mock, hasOutput) => {
    buildQaDockerHarnessImage.mockResolvedValueOnce({ imageName: "openclaw:qa-test" });
    await run();
    expect(mockFirstObjectArg(mock)).toMatchObject({
      repoRoot: LEGACY_TEST_REPO_ROOT,
      ...(hasOutput ? { outputDir: path.join(LEGACY_TEST_REPO_ROOT, "out") } : {}),
    });
    if (mock === runQaMultipass) {
      expect(runQaSuite).not.toHaveBeenCalled();
      expect(mockFirstObjectArg(mock)).toMatchObject({
        runtimePair: ["openclaw", "codex"],
        channelDriver: "crabline",
        channelId: "telegram",
      });
    }
    if (mock === runQaManualLane) {
      expect(mockFirstObjectArg(mock)).toMatchObject({
        message: "probe",
        timeoutMs: 45000,
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "openai/gpt-5.6-luna",
      });
    }
    if (mock === runQaSuite) {
      expect(mockFirstObjectArg(mock)).toMatchObject({
        primaryModel: "openai/gpt-5.6-luna",
        alternateModel: "anthropic/claude-sonnet-4-6",
        thinkingDefault: "medium",
        claudeCliAuthMode: "subscription",
      });
    }
    if (mock === runQaFlowSuiteFromRuntime) {
      expect(mockFirstObjectArg(mock)).toMatchObject({
        channelDriver: "live",
        channelId: "telegram",
        adapterOptions: { sutAccountId: "sut-live" },
      });
    }
  });

  it("rejects token-efficiency reports without a runtime axis", async () => {
    await expect(runQaParityReportCommand({ tokenEfficiency: true })).rejects.toThrow(
      "--token-efficiency requires --runtime-axis.",
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
