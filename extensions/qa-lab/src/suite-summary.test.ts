// Qa Lab tests cover suite summary plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import {
  readQaSuiteFailedOrSkippedScenarioCountFromFile,
  readQaSuiteFailedScenarioCountFromFile,
} from "./suite-summary.js";

async function readSummary<T>(
  summary: unknown,
  reader: (summaryPath: string) => Promise<T>,
): Promise<T> {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-suite-summary-inline-"));
  const summaryPath = path.join(outputDir, "qa-suite-summary.json");
  const payload =
    summary && typeof summary === "object" && !Array.isArray(summary)
      ? { run: { status: "completed" }, ...summary }
      : summary;
  await fs.writeFile(summaryPath, JSON.stringify(payload), "utf8");
  try {
    return await reader(summaryPath);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
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
    invocation.complete(first, {
      status: "fail",
      entries: [
        {
          test: { kind: "script", id: "same", title: "First" },
          coverage: [],
          result: { status: "fail" },
        },
      ],
    });
    invocation.select(0, first);
    const retry = invocation.begin(0, first);
    invocation.complete(retry, {
      status: "pass",
      entries: [
        {
          test: { kind: "script", id: "same", title: "Retry" },
          coverage: [],
          result: { status: "pass" },
        },
      ],
    });
    invocation.select(0, retry);
    const evidence = invocation.snapshot({ generatedAt: "2026-09-13T00:00:00.000Z" });
    for (const reader of [
      readQaSuiteFailedScenarioCountFromFile,
      readQaSuiteFailedOrSkippedScenarioCountFromFile,
    ]) {
      await expect(
        readSummary(
          {
            counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
            scenarios: [{ status: "pass" }],
            evidence,
          },
          reader,
        ),
      ).resolves.toBe(0);
      await expect(readSummary({ evidence }, reader)).resolves.toBe(0);
      const missing = structuredClone(evidence);
      missing.entries = [];
      await expect(
        readSummary(
          {
            counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
            scenarios: [{ status: "pass" }],
            evidence: missing,
          },
          reader,
        ),
      ).rejects.toThrow(/unresolved/);
    }
  });
  it.each([
    ["running", { run: { status: "running" } }],
    ["missing", {}],
    ["unsupported", { run: { status: "paused" } }],
  ])("rejects %s lifecycle state in every canonical count reader", async (_name, lifecycle) => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-suite-summary-lifecycle-"));
    const summaryPath = path.join(outputDir, "qa-suite-summary.json");
    await fs.writeFile(
      summaryPath,
      JSON.stringify({
        ...lifecycle,
        counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
        scenarios: [{ status: "pass" }],
      }),
      "utf8",
    );
    try {
      for (const reader of [
        readQaSuiteFailedScenarioCountFromFile,
        readQaSuiteFailedOrSkippedScenarioCountFromFile,
      ]) {
        await expect(reader(summaryPath)).rejects.toMatchObject({ code: "summary_not_completed" });
      }
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each([["failure and skip", readQaSuiteFailedOrSkippedScenarioCountFromFile]] as const)(
    "rejects zero-execution summaries in the %s gate",
    async (_name, reader) => {
      for (const summary of [
        {
          counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
          scenarios: [],
        },
        { counts: { failed: 0, skipped: 0 }, scenarios: [] },
        { counts: { failed: 0, skipped: 0 }, entries: [] },
        { counts: { failed: 0, skipped: 0 } },
      ]) {
        await expect(readSummary(summary, reader)).rejects.toThrow(
          "did not include any executed scenarios",
        );
      }
    },
  );

  it.each([
    {
      name: "unaccounted total",
      summary: {
        counts: { total: 2, passed: 1, failed: 0, skipped: 0 },
        scenarios: [{ status: "pass" }],
      },
    },
    {
      name: "positive counts without their claimed scenario rows",
      summary: {
        counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
        scenarios: [],
      },
    },
  ])("rejects complete suite accounting with $name", async ({ summary }) => {
    for (const reader of [
      readQaSuiteFailedScenarioCountFromFile,
      readQaSuiteFailedOrSkippedScenarioCountFromFile,
    ]) {
      await expect(readSummary(summary, reader)).rejects.toMatchObject({
        code: "summary_counts_invalid",
      });
    }
  });

  it("rejects a claimed pass that contradicts observed skipped-only scenarios", async () => {
    const summary = {
      counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
      scenarios: [{ name: "never executed", status: "skip" }],
    };

    for (const reader of [
      readQaSuiteFailedScenarioCountFromFile,
      readQaSuiteFailedOrSkippedScenarioCountFromFile,
    ]) {
      await expect(readSummary(summary, reader)).rejects.toMatchObject({
        code: "summary_counts_invalid",
      });
    }
  });

  it.each([["null", null]] as const)(
    "rejects %s counts containers even when a scenario claims to pass",
    async (_name, counts) => {
      const summary = { counts, scenarios: [{ status: "pass" }] };

      await expect(readSummary(summary, readQaSuiteFailedScenarioCountFromFile)).rejects.toThrow(
        "counts must be a non-array object",
      );
      await expect(
        readSummary(summary, readQaSuiteFailedOrSkippedScenarioCountFromFile),
      ).rejects.toThrow("counts must be a non-array object");
    },
  );

  it.each([
    ["unsafe passed", { total: 1, passed: Number.MAX_SAFE_INTEGER + 1, failed: 0, skipped: 0 }],
  ] as const)(
    "rejects %s instead of normalizing an invalid execution count",
    async (_name, counts) => {
      const summary = { counts, scenarios: [{ status: "pass" }] };

      await expect(readSummary(summary, readQaSuiteFailedScenarioCountFromFile)).rejects.toThrow(
        "must be a non-negative safe integer",
      );
      await expect(
        readSummary(summary, readQaSuiteFailedOrSkippedScenarioCountFromFile),
      ).rejects.toThrow("must be a non-negative safe integer");
    },
  );

  it("counts failed and skipped scenarios from scenario statuses", async () => {
    await expect(
      readSummary(
        {
          scenarios: [
            { status: "pass" },
            { status: "skip" },
            { status: "skipped" },
            { status: "fail" },
          ],
        },
        readQaSuiteFailedOrSkippedScenarioCountFromFile,
      ),
    ).resolves.toBe(3);
  });

  it.each([["missing", {}]] as const)(
    "counts %s scenario statuses as failures in both gates",
    async (_name, scenario) => {
      const summary = {
        counts: { failed: 0, skipped: 0 },
        scenarios: [scenario],
      };

      await expect(readSummary(summary, readQaSuiteFailedScenarioCountFromFile)).resolves.toBe(1);
      await expect(
        readSummary(summary, readQaSuiteFailedOrSkippedScenarioCountFromFile),
      ).resolves.toBe(1);
    },
  );

  it.each([
    {
      name: "required skip",
      summary: {
        counts: { total: 1, passed: 0, failed: 0, skipped: 1 },
        scenarios: [{ name: "required scenario", status: "skip" }],
      },
    },
  ])("requires a completed scenario before tolerating $name", async ({ summary }) => {
    await expect(
      readSummary(summary, (summaryPath) =>
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
          scenarios: [
            {
              name: "optional tool fixture",
              status: "skip",
              details: "expected-unavailable tool fixture; report-only",
            },
          ],
        },
        (summaryPath) =>
          readQaSuiteFailedOrSkippedScenarioCountFromFile(summaryPath, {
            optionalScenarioNames: new Set(["optional tool fixture"]),
          }),
      ),
    ).rejects.toThrow("did not include any executed scenarios");
  });

  it.each(["skip"] as const)(
    "keeps evidence-only %s results blocking for strict package gates",
    async (status) => {
      await expect(
        readSummary(
          { entries: [{ result: { status } }] },
          readQaSuiteFailedOrSkippedScenarioCountFromFile,
        ),
      ).resolves.toBe(1);
    },
  );

  it("uses scenario outcomes instead of counting lower-level producer checks", async () => {
    const summary = {
      counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
      scenarios: [{ status: "pass" }],
      evidence: {
        entries: [{ result: { status: "blocked" } }, { result: { status: "pass" } }],
      },
    };

    for (const reader of [
      readQaSuiteFailedScenarioCountFromFile,
      readQaSuiteFailedOrSkippedScenarioCountFromFile,
    ]) {
      await expect(readSummary(summary, reader)).resolves.toBe(0);
    }
  });

  it.each([["timeout", { status: "timeout" }]] as const)(
    "rejects unsupported %s evidence alongside complete counts",
    async (_name, result) => {
      const summary = {
        counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
        scenarios: [{ status: "pass" }],
        entries: [{ result }],
      };

      for (const reader of [
        readQaSuiteFailedScenarioCountFromFile,
        readQaSuiteFailedOrSkippedScenarioCountFromFile,
      ]) {
        await expect(readSummary(summary, reader)).rejects.toMatchObject({
          code: "summary_counts_invalid",
        });
      }
    },
  );

  it.each([["failure and skip", readQaSuiteFailedOrSkippedScenarioCountFromFile]] as const)(
    "retains positive legacy execution counts in the %s gate",
    async (_name, reader) => {
      await expect(
        readSummary({ counts: { total: 1, passed: 1, failed: 0, skipped: 0 } }, reader),
      ).resolves.toBe(0);
    },
  );

  it("keeps a report-only skip non-blocking when a real scenario also ran", async () => {
    await expect(
      readSummary(
        {
          counts: { total: 2, passed: 1, failed: 0, skipped: 1 },
          scenarios: [
            { name: "required scenario", status: "pass" },
            {
              name: "optional tool fixture",
              status: "skipped",
              details: "expected-unavailable tool fixture; report-only",
            },
          ],
        },
        (summaryPath) =>
          readQaSuiteFailedOrSkippedScenarioCountFromFile(summaryPath, {
            optionalScenarioNames: new Set(["optional tool fixture"]),
          }),
      ),
    ).resolves.toBe(0);
  });

  it("uses the larger failure signal when counts and scenarios disagree", async () => {
    await expect(
      readSummary(
        { counts: { failed: 0 }, scenarios: [{ status: "pass" }, { status: "fail" }] },
        readQaSuiteFailedScenarioCountFromFile,
      ),
    ).resolves.toBe(1);
    await expect(
      readSummary(
        { counts: { failed: 3 }, scenarios: [{ status: "pass" }, { status: "fail" }] },
        readQaSuiteFailedScenarioCountFromFile,
      ),
    ).resolves.toBe(3);
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
