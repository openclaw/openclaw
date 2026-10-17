import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import {
  readQaSuiteFailedOrSkippedScenarioCountFromFile,
  readQaSuiteFailedScenarioCountFromFile,
} from "./suite-summary.js";

const readers = [
  readQaSuiteFailedScenarioCountFromFile,
  readQaSuiteFailedOrSkippedScenarioCountFromFile,
];
const passed = {
  counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
  scenarios: [{ status: "pass" }],
};
const optionalSkip = {
  name: "optional tool fixture",
  status: "skip",
  details: "expected-unavailable tool fixture; report-only",
};
const readWithOptional = (summaryPath: string) =>
  readQaSuiteFailedOrSkippedScenarioCountFromFile(summaryPath, {
    optionalScenarioNames: new Set([optionalSkip.name]),
  });

async function readSummary<T>(
  summary: unknown,
  reader: (summaryPath: string) => Promise<T>,
  completed = true,
): Promise<T> {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-suite-summary-inline-"));
  const summaryPath = path.join(outputDir, "qa-suite-summary.json");
  const payload =
    summary && typeof summary === "object" && !Array.isArray(summary)
      ? { ...(completed ? { run: { status: "completed" } } : {}), ...summary }
      : summary;
  await fs.writeFile(summaryPath, JSON.stringify(payload), "utf8");
  try {
    return await reader(summaryPath);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
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

function expectCount(
  summary: unknown,
  count: number,
  reader = readQaSuiteFailedOrSkippedScenarioCountFromFile,
) {
  return expect(readSummary(summary, reader)).resolves.toBe(count);
}

describe("qa suite summary helpers", () => {
  it("counts the selected instance without letting retained retry failures contradict a pass", async () => {
    const invocation = createQaEvidenceInvocation({
      scenarios: [{ id: "retry-fixture", execution: { kind: "script" } }],
      channel: null,
      launch: {
        source: { ref: null, integrity: null },
        runtime: { id: null, version: null },
        package: null,
        protocol: null,
        accountRef: null,
        proofClass: null,
      },
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
    ["unsupported", { run: { status: "paused" } }],
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
      await expect(
        readSummary(summary, readQaSuiteFailedOrSkippedScenarioCountFromFile),
      ).rejects.toThrow("did not include any executed scenarios");
    }
  });

  it.each([
    {
      name: "unaccounted total",
      summary: {
        ...passed,
        counts: { ...passed.counts, total: 2 },
      },
    },
    {
      name: "positive counts without their claimed scenario rows",
      summary: {
        ...passed,
        scenarios: [],
      },
    },
    {
      name: "claimed pass over observed skips",
      summary: { ...passed, scenarios: [{ name: "never executed", status: "skip" }] },
    },
  ])("rejects complete suite accounting with $name", async ({ summary }) => {
    await expectBoth(summary, { code: "summary_counts_invalid" });
  });

  it("rejects null counts containers even when a scenario claims to pass", async () => {
    await expectBoth({ ...passed, counts: null }, "counts must be a non-array object");
  });

  it("rejects unsafe passed instead of normalizing an invalid execution count", async () => {
    await expectBoth(
      { ...passed, counts: { ...passed.counts, passed: Number.MAX_SAFE_INTEGER + 1 } },
      "must be a non-negative safe integer",
    );
  });

  it("counts failed and skipped scenarios from scenario statuses", async () => {
    await expectCount(
      { scenarios: ["pass", "skip", "skipped", "fail"].map((status) => ({ status })) },
      3,
    );
  });

  it("counts missing scenario statuses as failures in both gates", async () => {
    for (const reader of readers) {
      await expectCount({ counts: { failed: 0, skipped: 0 }, scenarios: [{}] }, 1, reader);
    }
  });

  it("requires a completed scenario before tolerating a required skip", async () => {
    await expect(
      readSummary(
        {
          counts: { total: 1, passed: 0, failed: 0, skipped: 1 },
          scenarios: [{ name: "required scenario", status: "skip" }],
        },
        (summaryPath) =>
          readQaSuiteFailedOrSkippedScenarioCountFromFile(summaryPath, {
            requireExecutedScenario: true,
          }),
      ),
    ).rejects.toThrow("did not include any executed scenarios");
  });

  it("rejects a suite containing only catalog-confirmed report-only skips", async () => {
    await expect(
      readSummary(
        {
          counts: { total: 1, passed: 0, failed: 0, skipped: 1 },
          scenarios: [optionalSkip],
        },
        readWithOptional,
      ),
    ).rejects.toThrow("did not include any executed scenarios");
  });

  it("keeps evidence-only skip results blocking for strict package gates", async () => {
    await expectCount({ entries: [{ result: { status: "skip" } }] }, 1);
  });

  it("uses scenario outcomes instead of counting lower-level producer checks", async () => {
    const summary = {
      ...passed,
      evidence: {
        entries: [{ result: { status: "blocked" } }, { result: { status: "pass" } }],
      },
    };

    await expectBoth(summary);
  });

  it("rejects unsupported timeout evidence alongside complete counts", async () => {
    await expectBoth(
      { ...passed, entries: [{ result: { status: "timeout" } }] },
      { code: "summary_counts_invalid" },
    );
  });

  it("retains positive legacy execution counts in the failure and skip gate", async () => {
    await expectCount({ counts: passed.counts }, 0);
  });

  it("keeps a report-only skip non-blocking when a real scenario also ran", async () => {
    await expectCount(
      {
        counts: { total: 2, passed: 1, failed: 0, skipped: 1 },
        scenarios: [
          { name: "required scenario", status: "pass" },
          { ...optionalSkip, status: "skipped" },
        ],
      },
      0,
      readWithOptional,
    );
  });

  it("uses the larger failure signal when counts and scenarios disagree", async () => {
    for (const [failed, expected] of [
      [0, 1],
      [3, 3],
    ] as const) {
      await expectCount(
        { counts: { failed }, scenarios: [{ status: "pass" }, { status: "fail" }] },
        expected,
        readQaSuiteFailedScenarioCountFromFile,
      );
    }
  });

  it("rejects unsupported summary shapes", async () => {
    await expect(
      readSummary({ counts: { total: 2, passed: 2 } }, readQaSuiteFailedScenarioCountFromFile),
    ).rejects.toThrow(
      "did not include counts.failed, scenarios[].status, or entries[].result.status",
    );
    await expect(
      readSummary("not-json-object", readQaSuiteFailedScenarioCountFromFile),
    ).rejects.toMatchObject({ code: "summary_not_completed" });
  });
});
