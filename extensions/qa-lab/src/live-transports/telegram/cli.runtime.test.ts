import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTelegramQaTransportAdapter: vi.fn(),
  listTelegramQaScenarios: vi.fn(),
  printLiveTransportQaArtifacts: vi.fn(),
  resolveTelegramQaRunOptions: vi.fn((options: Parameters<typeof runQaTelegramSuite>[0]) => ({
    ...options,
    allowFailures: options.allowFailures ?? false,
    listScenarios: false,
  })),
  resolveTelegramQaScenarioIds: vi.fn(),
  runQaFlowSuiteFromRuntime: vi.fn(),
}));

vi.mock("../../suite-launch.runtime.js", () => ({
  runQaFlowSuiteFromRuntime: mocks.runQaFlowSuiteFromRuntime,
}));

vi.mock("../shared/live-artifacts.js", () => ({
  printLiveTransportQaArtifacts: mocks.printLiveTransportQaArtifacts,
}));

vi.mock("./adapter.runtime.js", () => ({
  createTelegramQaTransportAdapter: mocks.createTelegramQaTransportAdapter,
}));

vi.mock("./run-options.runtime.js", () => ({
  resolveTelegramQaRunOptions: mocks.resolveTelegramQaRunOptions,
}));

vi.mock("./scenario-selection.js", () => ({
  listTelegramQaScenarios: mocks.listTelegramQaScenarios,
  resolveTelegramQaScenarioIds: mocks.resolveTelegramQaScenarioIds,
}));

import { runQaTelegramCommand, runQaTelegramSuite } from "./cli.runtime.js";

let previousExitCode: typeof process.exitCode;
let tempRoot: string;
let summaryPath: string;

function writeSummary(status: string) {
  const skipped = status === "skip" || status === "skipped";
  const empty = status === "zero-work";
  const summary = {
    run: { status: "completed" },
    counts: {
      total: empty ? 0 : 1,
      passed: Number(status === "pass"),
      failed: Number(status === "fail"),
      skipped: Number(skipped),
    },
    scenarios: empty ? [] : [{ name: "channel-canary", status }],
  };
  writeFileSync(summaryPath, JSON.stringify(summary), "utf8");
}

const runSuite = (allowFailures = false) =>
  runQaTelegramSuite({ repoRoot: "/repo", providerMode: "mock-openai", allowFailures });

beforeEach(() => {
  previousExitCode = process.exitCode;
  // Bun does not clear a previous failure when assigned undefined.
  process.exitCode = 0;
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_OPENCLAW_COMMAND", undefined);
  tempRoot = mkdtempSync(path.join(tmpdir(), "openclaw-qa-telegram-gate-"));
  summaryPath = path.join(tempRoot, "qa-suite-summary.json");
  writeSummary("pass");
  mocks.resolveTelegramQaScenarioIds.mockReturnValue(["channel-canary"]);
  mocks.runQaFlowSuiteFromRuntime.mockResolvedValue({
    reportPath: ".artifacts/qa-e2e/telegram/qa-suite-report.md",
    summaryPath,
  });
});

afterEach(() => {
  process.exitCode = previousExitCode ?? 0;
  rmSync(tempRoot, { force: true, recursive: true });
  vi.unstubAllEnvs();
});

it.each([
  { status: "fail", allowFailures: false, exitCode: 1 },
  { status: "skip", allowFailures: false, exitCode: 1 },
  { status: "fail", allowFailures: true, exitCode: 0 },
])(
  "gates $status with allowFailures=$allowFailures",
  async ({ status, allowFailures, exitCode }) => {
    writeSummary(status);
    await runSuite(allowFailures);
    expect(process.exitCode).toBe(exitCode);
  },
);

it.each([
  { summary: "missing", expected: "Could not read QA summary" },
  { summary: "malformed", expected: "Could not parse QA summary" },
  { summary: "zero-work", expected: "did not include any executed scenarios" },
  { summary: "required-skip", expected: "did not include any executed scenarios" },
])(
  "rejects $summary Telegram summaries even with --allow-failures",
  async ({ summary, expected }) => {
    if (summary === "missing") {
      rmSync(summaryPath);
    } else if (summary === "malformed") {
      writeFileSync(summaryPath, "{not-json", "utf8");
    } else {
      writeSummary(summary === "zero-work" ? summary : "skip");
    }

    await expect(runSuite(true)).rejects.toThrow(expected);
    expect(process.exitCode).toBe(0);
  },
);

it("lists only scenarios accepted by its flow runner", async () => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  mocks.listTelegramQaScenarios.mockReturnValue([
    { id: "flow", defaultEnabled: true, title: "Flow", rationale: "QA", regressionRefs: [] },
  ]);
  const options = {
    listScenarios: true,
    providerMode: "mock-openai",
    repoRoot: process.cwd(),
  };
  mocks.resolveTelegramQaRunOptions.mockReturnValueOnce({ ...options, allowFailures: false });
  await runQaTelegramSuite(options);

  const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");
  expect(output).toContain("flow\tdefault\t");
  expect(output).not.toContain("telegram-startup-getme-live");
  expect(mocks.runQaFlowSuiteFromRuntime).not.toHaveBeenCalled();
});

it("selects scenarios against the exact requested model before suite startup", async () => {
  await runQaTelegramCommand({
    allowFailures: true,
    primaryModel: "openai/custom-selection-model",
    providerMode: "live-frontier",
    repoRoot: process.cwd(),
  });

  expect(mocks.resolveTelegramQaScenarioIds).toHaveBeenCalledWith({
    profile: undefined,
    primaryModel: "openai/custom-selection-model",
    providerMode: "live-frontier",
    scenarioIds: undefined,
  });
  expect(mocks.runQaFlowSuiteFromRuntime).toHaveBeenCalledWith(
    expect.objectContaining({ primaryModel: "openai/custom-selection-model" }),
  );
});
