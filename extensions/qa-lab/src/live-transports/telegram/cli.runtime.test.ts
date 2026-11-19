import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as scenarioSelection from "./scenario-selection.js";

const mocks = vi.hoisted(() => ({
  createTelegramQaTransportAdapter: vi.fn(),
  runQaFlowSuiteFromRuntime: vi.fn(),
}));

vi.mock("../../suite-launch.runtime.js", () => ({
  runQaFlowSuiteFromRuntime: mocks.runQaFlowSuiteFromRuntime,
}));

vi.mock("./adapter.runtime.js", () => ({
  createTelegramQaTransportAdapter: mocks.createTelegramQaTransportAdapter,
}));

import { runQaTelegramCommand, runQaTelegramSuite } from "./cli.runtime.js";

let previousExitCode: typeof process.exitCode;
let tempRoot: string;
let summaryPath: string;

function writeSummary(status: string) {
  const summary = {
    run: { status: "completed" },
    counts: {
      total: 1,
      passed: Number(status === "pass"),
      failed: Number(status === "fail"),
      skipped: Number(status === "skip"),
    },
    scenarios: [{ name: "channel-canary", status }],
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

it("prints the report and summary paths in order", async () => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await runSuite();
  expect(write.mock.calls.map(([chunk]) => String(chunk))).toEqual([
    "Telegram QA report: .artifacts/qa-e2e/telegram/qa-suite-report.md\n",
    `Telegram QA summary: ${summaryPath}\n`,
  ]);
});

it.each([
  ["fail", false, 1],
  ["skip", false, 1],
  ["fail", true, 0],
] as const)("gates %s with allowFailures=%s", async (status, allowFailures, exitCode) => {
  writeSummary(status);
  await runSuite(allowFailures);
  expect(process.exitCode).toBe(exitCode);
});

it.each([
  ["missing", "Could not read QA summary", () => rmSync(summaryPath)],
  [
    "malformed",
    "Could not parse QA summary",
    () => writeFileSync(summaryPath, "{not-json", "utf8"),
  ],
  ["required-skip", "did not include any executed scenarios", () => writeSummary("skip")],
] as const)("rejects %s even with --allow-failures", async (_name, expected, setup) => {
  setup();
  await expect(runSuite(true)).rejects.toThrow(expected);
  expect(process.exitCode).toBe(0);
});

it("lists only scenarios accepted by its flow runner", async () => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await runQaTelegramSuite({ listScenarios: true, providerMode: "mock-openai" });

  const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");
  expect(output).toContain("telegram-long-final-three-chunks\tdefault\t");
  expect(output).not.toContain("telegram-startup-getme-live");
  expect(mocks.runQaFlowSuiteFromRuntime).not.toHaveBeenCalled();
});

it("selects scenarios against the exact requested model before suite startup", async () => {
  const select = vi.spyOn(scenarioSelection, "resolveTelegramQaScenarioIds");
  const primaryModel = "openai/custom-selection-model";
  await runQaTelegramCommand({
    allowFailures: true,
    primaryModel,
    providerMode: "live-frontier",
    repoRoot: process.cwd(),
  });

  expect(select.mock.calls[0]?.[0]).toMatchObject({ primaryModel, providerMode: "live-frontier" });
  expect(mocks.runQaFlowSuiteFromRuntime).toHaveBeenCalledWith(
    expect.objectContaining({ primaryModel }),
  );
  select.mockRestore();
});
