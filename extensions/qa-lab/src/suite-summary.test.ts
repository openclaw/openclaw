import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import {
  readQaSuiteFailedOrSkippedScenarioCountFromFile as readBlockingCount,
  readQaSuiteFailedScenarioCountFromFile as readFailedCount,
} from "./suite-summary.js";
import { makeQaSuiteTestLaunch } from "./suite-test-helpers.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { makeTempDir, cleanup } = createTempDirHarness();
afterEach(cleanup);

const readers = [readFailedCount, readBlockingCount];
const passed = {
  counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
  scenarios: [{ status: "pass" }],
};
const optionalSkip = {
  name: "optional tool fixture",
  status: "skip",
  details: "expected-unavailable tool fixture; report-only",
};
const skipped = (scenario: { name: string; status: string; details?: string }) => ({
  counts: { total: 1, passed: 0, failed: 0, skipped: 1 },
  scenarios: [scenario],
});
const readWithOptional = (summaryPath: string) =>
  readBlockingCount(summaryPath, {
    optionalScenarioNames: new Set([optionalSkip.name]),
  });

async function readSummary<T>(
  summary: unknown,
  reader: (summaryPath: string) => Promise<T>,
  completed = true,
): Promise<T> {
  const outputDir = await makeTempDir("qa-suite-summary-inline-");
  const summaryPath = path.join(outputDir, "qa-suite-summary.json");
  const payload =
    summary && typeof summary === "object" && !Array.isArray(summary)
      ? { ...(completed ? { run: { status: "completed" } } : {}), ...summary }
      : summary;
  await fs.writeFile(summaryPath, JSON.stringify(payload), "utf8");
  return reader(summaryPath);
}

async function expectBoth(summary: unknown, error?: string | RegExp | { code: string }) {
  for (const reader of readers) {
    const result = expect(readSummary(summary, reader));
    if (typeof error === "string" || error instanceof RegExp) {
      await result.rejects.toThrow(error);
    } else if (error) {
      await result.rejects.toMatchObject(error);
    } else {
      await result.resolves.toBe(0);
    }
  }
}

function expectCount(summary: unknown, count: number, reader = readBlockingCount) {
  return expect(readSummary(summary, reader)).resolves.toBe(count);
}

describe("qa suite summary helpers", () => {
  it("counts the selected instance without letting retained retry failures contradict a pass", async () => {
    const invocation = createQaEvidenceInvocation({
      scenarios: [{ id: "retry-fixture", execution: { kind: "script" } }],
      channel: null,
      launch: makeQaSuiteTestLaunch(),
    });
    const first = invocation.begin(0);
    const complete = (id: string, status: "pass" | "fail", title: string) =>
      invocation.complete(id, {
        status,
        entries: [
          { test: { kind: "script", id: "same", title }, coverage: [], result: { status } },
        ],
      });
    complete(first, "fail", "First");
    invocation.select(0, first);
    const retry = invocation.begin(0, first);
    complete(retry, "pass", "Retry");
    invocation.select(0, retry);
    const evidence = invocation.snapshot({ generatedAt: "2026-09-13T00:00:00.000Z" });
    await expectBoth({ ...passed, evidence });
    await expectBoth({ evidence });
    const missing = structuredClone(evidence);
    missing.entries = [];
    await expectBoth({ ...passed, evidence: missing }, /unresolved/);
  });
  it.each([
    ["running", { run: { status: "running" } }],
    ["missing", {}],
  ])("rejects %s lifecycle state in every canonical count reader", async (_name, lifecycle) => {
    for (const reader of readers) {
      await expect(readSummary({ ...passed, ...lifecycle }, reader, false)).rejects.toMatchObject({
        code: "summary_not_completed",
      });
    }
  });

  it("rejects zero-execution summaries in the failure and skip gate", async () => {
    for (const summary of [
      {
        counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
        scenarios: [],
      },
      { counts: { failed: 0, skipped: 0 }, scenarios: [] },
      { counts: { failed: 0, skipped: 0 }, entries: [] },
      { counts: { failed: 0, skipped: 0 } },
    ]) {
      await expect(readSummary(summary, readBlockingCount)).rejects.toThrow(
        "did not include any executed scenarios",
      );
    }
  });

  it.each([
    { ...passed, entries: [{ result: { status: "timeout" } }] },
    { ...passed, counts: null },
    { ...passed, counts: { ...passed.counts, passed: Number.MAX_SAFE_INTEGER + 1 } },
  ])("rejects invalid accounting: %j", async (summary) => {
    await expectBoth(summary, { code: "summary_counts_invalid" });
  });

  it("counts missing scenario statuses as failures in both gates", async () => {
    for (const reader of readers) {
      await expectCount({ counts: { failed: 0, skipped: 0 }, scenarios: [{}] }, 1, reader);
    }
  });

  it.each([
    [
      "required skip with execution required",
      { name: "required scenario", status: "skip" },
      { requireExecutedScenario: true },
    ],
    [
      "catalog-confirmed report-only skip",
      optionalSkip,
      { optionalScenarioNames: new Set([optionalSkip.name]) },
    ],
  ] as const)("rejects zero execution with %s", async (_name, scenario, options) => {
    await expect(
      readSummary(skipped(scenario), (file) => readBlockingCount(file, options)),
    ).rejects.toThrow("did not include any executed scenarios");
  });

  it.each([
    [
      "scenario statuses",
      { scenarios: ["pass", "skip", "skipped", "fail"].map((status) => ({ status })) },
      3,
      undefined,
    ],
    ["evidence-only skips", { entries: [{ result: { status: "skip" } }] }, 1, undefined],
    ["positive legacy counts", { counts: passed.counts }, 0, undefined],
    [
      "report-only skips alongside execution",
      {
        counts: { total: 2, passed: 1, failed: 0, skipped: 1 },
        scenarios: [
          { name: "required scenario", status: "pass" },
          { ...optionalSkip, status: "skipped" },
        ],
      },
      0,
      readWithOptional,
    ],
  ] as const)("counts %s", async (_name, summary, count, reader) => {
    await expectCount(summary, count, reader);
  });

  it("uses scenario outcomes instead of counting lower-level producer checks", async () => {
    await expectBoth({
      ...passed,
      evidence: { entries: [{ result: { status: "blocked" } }, { result: { status: "pass" } }] },
    });
  });

  it("uses the larger failure signal when counts and scenarios disagree", async () => {
    for (const [failed, expected] of [
      [0, 1],
      [3, 3],
    ] as const) {
      await expectCount(
        { counts: { failed }, scenarios: [{ status: "pass" }, { status: "fail" }] },
        expected,
        readFailedCount,
      );
    }
  });

  it("rejects unsupported summary shapes", async () => {
    await expect(readSummary({ counts: { total: 2, passed: 2 } }, readFailedCount)).rejects.toThrow(
      "did not include counts.failed, scenarios[].status, or entries[].result.status",
    );
    await expect(readSummary("not-json-object", readFailedCount)).rejects.toMatchObject({
      code: "summary_not_completed",
    });
  });
});
