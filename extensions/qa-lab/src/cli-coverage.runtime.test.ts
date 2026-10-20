import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRuntimeParitySummary } from "./agentic-parity-report-test-helpers.js";
import { runQaCoverageReportCommand } from "./cli-coverage.runtime.js";
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
  let stdoutWrite: ReturnType<typeof vi.spyOn>;
  let priorExitCode: typeof process.exitCode;

  function expectWrites(...fragments: string[]) {
    for (const fragment of fragments) {
      expect(
        stdoutWrite.mock.calls.some(([value]) => String(value).includes(fragment)),
        `write contains ${fragment}`,
      ).toBe(true);
    }
  }

  async function writeInput(name: string, content: string) {
    const repoRoot = await tempDirs.makeTempDir("qa-coverage-");
    await fs.writeFile(path.join(repoRoot, name), content, "utf8");
    return repoRoot;
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

  describe("coverage inventory command", () => {
    it("prints a markdown report from scenario metadata", async () => {
      await runQaCoverageReportCommand({});

      expectWrites("# QA Coverage Inventory", "session-memory.embedding-search-recall");
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
      await runQaCoverageReportCommand({
        repoRoot,
        evidence: "qa-evidence.json",
        json: true,
        output: "gaps.json",
      });
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
        runQaCoverageReportCommand({
          repoRoot,
          evidence: "qa-evidence.json",
          output: "qa-evidence.json",
        }),
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
      await expect(
        runQaCoverageReportCommand({ repoRoot, evidence: "qa-evidence.json", output: "gaps.json" }),
      ).rejects.toThrow();
      await expect(fs.stat(path.join(repoRoot, "gaps.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("prints a markdown tool coverage inventory without a run summary", async () => {
    await runQaCoverageReportCommand({ tools: true });
    expectWrites("# OpenClaw Runtime Tool Coverage", "codex-native-workspace");
  });

  it("prints a focused scenario match report from coverage metadata", async () => {
    await runQaCoverageReportCommand({
      repoRoot: process.cwd(),
      match: ["image roundtrip"],
    });

    expectWrites(
      "# QA Scenario Matches",
      "image-generation-roundtrip",
      "--scenario image-generation-roundtrip",
    );
    expect(stdoutWrite.mock.calls.flat().join("")).not.toContain("memory-recall");
  });

  it("rejects null tool coverage summary JSON", async () => {
    const repoRoot = await writeInput("runtime-summary.json", "null\n");
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

  it("exits nonzero when tool coverage summary is missing a required runtime tool call", async () => {
    const baseSummary = makeRuntimeParitySummary();
    const scenario = baseSummary.scenarios[0];
    if (!scenario?.runtimeParity) {
      throw new Error("runtime parity fixture missing");
    }
    const summary = {
      ...baseSummary,
      scenarios: [scenario],
      run: { ...baseSummary.run, status: "completed" },
    };
    scenario.name = "runtime-tool-web-search";
    scenario.runtimeParity.scenarioId = "runtime-tool-web-search";
    scenario.status = "fail";
    summary.counts = { total: 1, passed: 0, failed: 1 };
    scenario.runtimeParity.drift = "tool-call-shape";
    scenario.runtimeParity.driftDetails = "Codex emitted no web_search call";
    const cell = {
      transcriptBytes: "",
      finalText: "",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      wallClockMs: 1,
    };
    Object.assign(scenario.runtimeParity.cells.openclaw, {
      ...cell,
      toolCalls: [{ tool: "web_search", argsHash: "a", resultHash: "r" }],
    });
    Object.assign(scenario.runtimeParity.cells.codex, { ...cell, toolCalls: [] });
    const repoRoot = await writeInput("runtime-summary.json", JSON.stringify(summary));

    await runQaCoverageReportCommand({
      repoRoot,
      tools: true,
      summary: "runtime-summary.json",
    });

    expect(process.exitCode).toBe(1);
    expectWrites(
      "- Verdict: fail",
      "web_search missing successful codex tool call/result web_search",
    );
  });
});
