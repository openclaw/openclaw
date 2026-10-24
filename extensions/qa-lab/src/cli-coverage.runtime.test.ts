import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { runQaCoverageReportCommand } from "../reporting-api.js";
import { makeRuntimeParitySummary } from "./agentic-parity-report-test-helpers.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { runQaFlowSuiteFromRuntime, runQaSuite } = vi.hoisted(() => ({
  runQaFlowSuiteFromRuntime: vi.fn(),
  runQaSuite: vi.fn(),
}));

vi.mock("./suite-launch.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./suite-launch.runtime.js")>()),
  runQaFlowSuiteFromRuntime,
  runQaSuite,
}));

const tempDirs = createTempDirHarness();

describe("qa coverage command", () => {
  let stdoutWrite: MockInstance<typeof process.stdout.write>;
  let priorExitCode: typeof process.exitCode;

  function expectWrites(...fragments: string[]) {
    for (const fragment of fragments) {
      expect(stdoutWrite.mock.calls.some(([value]) => String(value).includes(fragment))).toBe(true);
    }
  }

  async function writeInput(name: string, content: string) {
    const repoRoot = await tempDirs.makeTempDir("qa-coverage-");
    await fs.writeFile(path.join(repoRoot, name), content, "utf8");
    return repoRoot;
  }
  const evidenceOptions = (repoRoot: string, output = "gaps.json") => ({
    repoRoot,
    evidence: "qa-evidence.json",
    output,
  });
  async function runSummary(summary: unknown, json = false) {
    return runQaCoverageReportCommand({
      repoRoot: await writeInput("runtime-summary.json", JSON.stringify(summary)),
      tools: true,
      summary: "runtime-summary.json",
      json,
    });
  }

  beforeEach(() => {
    priorExitCode = process.exitCode;
    process.exitCode = 0;
    stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });

  afterEach(async () => {
    process.exitCode = priorExitCode ?? 0;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await tempDirs.cleanup();
  });

  it("writes UNKNOWN gap facts from legacy evidence without running QA or changing its input", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-gap-report-");
    await fs.copyFile(path.resolve("taxonomy.yaml"), path.join(repoRoot, "taxonomy.yaml"));
    const raw = JSON.stringify({
      kind: "openclaw.qa.evidence-summary",
      schemaVersion: 2,
      generatedAt: "2026-10-01T00:00:00Z",
      evidenceMode: "slim",
      entries: [],
    });
    const evidencePath = path.join(repoRoot, "qa-evidence.json");
    await fs.writeFile(evidencePath, raw);
    await runQaCoverageReportCommand({ ...evidenceOptions(repoRoot), json: true });
    const report = JSON.parse(await fs.readFile(path.join(repoRoot, "gaps.json"), "utf8")) as {
      coverage: Array<{ qualification: string }>;
    };
    expect(report.coverage.length).toBeGreaterThan(0);
    expect(report.coverage.every((row) => row.qualification === "unknown")).toBe(true);
    expect(await fs.readFile(evidencePath, "utf8")).toBe(raw);
    expect(process.exitCode).toBe(0);
    expect(runQaSuite).not.toHaveBeenCalled();
    expect(runQaFlowSuiteFromRuntime).not.toHaveBeenCalled();
    await expect(
      runQaCoverageReportCommand(evidenceOptions(repoRoot, "qa-evidence.json")),
    ).rejects.toThrow("must not overwrite");
    expect(await fs.readFile(evidencePath, "utf8")).toBe(raw);
  });

  it.each([{ tools: true }, { summary: "summary.json" }, { match: ["query"] }])(
    "rejects incompatible evidence options %j before reading input",
    async (options) => {
      await expect(
        runQaCoverageReportCommand({ evidence: "absent.json", ...options }),
      ).rejects.toThrow("--evidence cannot be combined");
    },
  );

  it("rejects malformed evidence without fabricating an UNKNOWN report", async () => {
    const repoRoot = await writeInput("qa-evidence.json", "null\n");
    await expect(runQaCoverageReportCommand(evidenceOptions(repoRoot))).rejects.toThrow();
    await expect(fs.stat(path.join(repoRoot, "gaps.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it.each<[Parameters<typeof runQaCoverageReportCommand>[0], string[], string | undefined]>([
    [{}, ["# QA Coverage Inventory", "session-memory.embedding-search-recall"], undefined],
    [{ tools: true }, ["# OpenClaw Runtime Tool Coverage", "codex-native-workspace"], undefined],
    [
      { repoRoot: process.cwd(), match: ["image roundtrip"] },
      [
        "# QA Scenario Matches",
        "image-generation-roundtrip",
        "--scenario image-generation-roundtrip",
      ],
      "memory-recall",
    ],
  ])("prints coverage metadata for %j", async (options, fragments, excluded) => {
    await runQaCoverageReportCommand(options);
    expectWrites(...fragments);
    if (excluded) {
      expect(stdoutWrite.mock.calls.flat().join("")).not.toContain(excluded);
    }
  });

  it("rejects null tool coverage summary JSON", async () => {
    await expect(runSummary(null, true)).rejects.toMatchObject({ code: "summary_not_completed" });
    expect(process.exitCode).toBe(0);
  });

  it("exits nonzero when tool coverage summary is missing a required runtime tool call", async () => {
    const baseSummary = makeRuntimeParitySummary();
    const summary = { ...baseSummary, run: { ...baseSummary.run, status: "completed" } };
    const scenario = summary.scenarios[0];
    if (!scenario?.runtimeParity) {
      throw new Error("runtime parity fixture missing");
    }
    summary.scenarios = [scenario];
    scenario.name = "runtime-tool-web-search";
    scenario.runtimeParity.scenarioId = "runtime-tool-web-search";
    scenario.status = "fail";
    summary.counts = { total: 1, passed: 0, failed: 1 };
    scenario.runtimeParity.drift = "tool-call-shape";
    scenario.runtimeParity.driftDetails = "Codex emitted no web_search call";
    scenario.runtimeParity.cells.openclaw.toolCalls = [
      { tool: "web_search", argsHash: "a", resultHash: "r" },
    ];
    scenario.runtimeParity.cells.codex.toolCalls = [];
    await runSummary(summary);
    expect(process.exitCode).toBe(1);
    expectWrites(
      "- Verdict: fail",
      "web_search missing successful codex tool call/result web_search",
    );
  });
});
