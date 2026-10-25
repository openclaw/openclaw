import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildQaConfidenceReport, renderQaConfidenceMarkdownReport } from "./confidence-report.js";
import { writeQaConfidenceSelfTestArtifacts } from "./confidence-self-test.js";

type QaConfidenceManifest = Parameters<typeof buildQaConfidenceReport>[0]["manifest"];
type Lane = QaConfidenceManifest["lanes"][number];

function lane(id: string, artifact: string, options: Partial<Lane> = {}): Lane {
  return { id, title: id, kind: "qa-suite-summary", artifact, required: true, ...options };
}

const passedCounts = { total: 1, passed: 1, skipped: 0, failed: 0 };
const environmentSentinel = {
  kind: "live-quota-or-subscription",
  verdict: "environment-blocked",
  owner: "environment",
  line: 12,
  text: "OpenAI quota exceeded",
};
type Report = Awaited<ReturnType<typeof buildQaConfidenceReport>>;

function expectUnknown(report: Report, details: string, counts?: Partial<Report["counts"]>) {
  expect(report).toMatchObject({ pass: false, globalPass: false, zeroUnknowns: false });
  if (counts) {
    expect(report.counts).toMatchObject(counts);
  }
  expect(report.lanes[0]).toMatchObject({ status: "unknown" });
  expect(report.lanes[0]?.details).toContain(details);
}

const scenario = (status: string) => ({ name: status, status });
const suiteCounts = (total: number, passed: number, skipped = 0, failed = 0) => ({
  total,
  passed,
  skipped,
  failed,
});
const invalid = (artifact: object, detail: string, kind?: Lane["kind"]) =>
  [artifact, detail, kind] as const;

describe("qa confidence report", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-confidence-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function fixture(id: string, payload: object, options: Partial<Lane> = {}) {
    const relativePath = `${id}/${options.kind ? "summary.json" : "qa-suite-summary.json"}`;
    const filePath = path.join(tempRoot, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const value = options.kind ? payload : { run: { status: "completed" }, ...payload };
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return lane(id, relativePath, options);
  }

  async function buildReport(
    lanes: (Lane | Promise<Lane>)[],
    options: Omit<Parameters<typeof buildQaConfidenceReport>[0], "manifest" | "artifactRoot"> = {},
  ) {
    return buildQaConfidenceReport({
      manifest: { version: 1, profile: "codex-100", lanes: await Promise.all(lanes) },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      generatedAt: "2026-05-13T00:00:00.000Z",
      ...options,
    });
  }

  function evaluate(artifact: object, options: Partial<Lane> = {}, strictGlobalPass = false) {
    return buildReport([fixture("evidence", artifact, options)], { strictGlobalPass });
  }

  async function buildStrictSuiteReport(payload: Record<string, unknown>, withBackfill = false) {
    const lanes = [
      fixture("report-only", payload, withBackfill ? { skipBackfillLane: "backfill" } : {}),
    ];
    if (withBackfill) {
      lanes.push(fixture("backfill", { counts: passedCounts }));
    }
    return buildReport(lanes, { strictGlobalPass: true });
  }

  it("passes strict zero-unknowns when every lane passes or has an allowed blocked verdict", async () => {
    const report = await buildReport([
      fixture("tool-defaults", { counts: suiteCounts(20, 18, 2) }),
      fixture(
        "mock-token-efficiency",
        {
          status: "estimated",
          pass: true,
          rows: [{ usageSource: "mock-estimate" }],
        },
        {
          kind: "token-efficiency-summary",
          expectedTokenUsageSource: "mock-estimate",
        },
      ),
      lane("live-token-efficiency", "live/qa-runtime-token-efficiency-summary.json", {
        kind: "token-efficiency-summary",
        missingVerdict: "environment-blocked",
        missingReason: "OPENAI OAuth credentials are not available in this runner.",
      }),
    ]);

    expect(report).toMatchObject({
      pass: true,
      globalPass: false,
      counts: { passed: 2, blocked: 1, unknown: 0, failed: 0 },
    });
    expect(report.lanes.map((entry) => entry.verdict)).toEqual([
      "pass",
      "pass",
      "environment-blocked",
    ]);
    expect(report.lanes[0]?.artifactPath).toBe("tool-defaults/qa-suite-summary.json");
    expect(report.lanes[0]?.artifactPath).not.toContain(tempRoot);
    expect(report.lanes[0]?.details).toContain("counts.skipped=2");
    expect(renderQaConfidenceMarkdownReport(report)).toContain("Zero unknowns: yes");
    expect(renderQaConfidenceMarkdownReport(report)).toContain("Global pass: no");
  });

  it("does not let optional lanes block strict gates", async () => {
    const report = await buildReport(
      [
        fixture("required", { counts: passedCounts }),
        lane("optional-missing", "optional/qa-suite-summary.json", { required: false }),
      ],
      { strictGlobalPass: true },
    );

    expect(report).toMatchObject({
      pass: true,
      counts: { total: 1, passed: 1, unknown: 0 },
      failures: [],
      lanes: [{ status: "pass" }, { id: "optional-missing", status: "missing" }],
    });
  });

  it("fails strict global pass when any lane is blocked, missing, unknown, or classified failed", async () => {
    const failed = { counts: suiteCounts(1, 0, 0, 1), scenarios: [scenario("fail")] };
    const report = await buildReport(
      [
        lane("blocked-live", "live/qa-suite-summary.json", {
          missingVerdict: "environment-blocked",
          missingReason: "OPENAI_API_KEY missing.",
        }),
        lane("missing-soak", "soak/qa-suite-summary.json"),
        fixture("classified-fixture", failed, {
          failureVerdict: "fixture-bug",
        }),
        fixture("unknown-failure", failed),
      ],
      {
        strictGlobalPass: true,
      },
    );

    expect(report).toMatchObject({
      pass: false,
      zeroUnknowns: false,
      globalPass: false,
      counts: { blocked: 1, missing: 1, failed: 1, unknown: 2 },
    });
    expect(report.failures).toEqual([
      "blocked-live is blocked: OPENAI_API_KEY missing.",
      "missing-soak is missing: artifact missing and no missingVerdict was configured",
      "classified-fixture is classified fixture-bug: qa-suite-summary counts.failed=1 counts.total=1 counts.skipped=0",
      "unknown-failure is unclassified: qa-suite-summary counts.failed=1 counts.total=1 counts.skipped=0",
    ]);
  });

  it.each([
    [suiteCounts(1, 0, 1), "skip"],
    [undefined, "skipped"],
    [{ passed: 1, failed: 0 }, "skip"],
  ] as const)("rejects unexecuted evidence %j despite backfill", async (counts, status) => {
    const report = await buildStrictSuiteReport({ counts, scenarios: [scenario(status)] }, true);
    expectUnknown(report, "no executed scenarios");
    expect(report.globalPass).toBe(false);
    expect(report.lanes[1]).toMatchObject({ status: "pass" });
  });

  it.each([
    { counts: suiteCounts(3, 2, 1) },
    { scenarios: [scenario("pass"), scenario("skip")] },
    { counts: { skipped: 1 }, scenarios: [scenario("pass")] },
    { counts: { total: 3, passed: 2, failed: 0 } },
    { counts: { total: 2, passed: 2, failed: 0 }, scenarios: [scenario("pass"), scenario("skip")] },
  ])("requires backfill for explicit or inferred skips: %j", async (artifact) => {
    for (const hasBackfill of [false, true]) {
      const report = await buildStrictSuiteReport(artifact, hasBackfill);
      expect(report).toMatchObject({
        pass: hasBackfill,
        globalPass: hasBackfill,
        zeroUnknowns: true,
        lanes: [{ status: "pass", skippedCount: 1 }],
      });
      if (hasBackfill) {
        expect(report.lanes[0]).toMatchObject({ skipBackfilled: true });
      } else {
        expect(report.failures).toEqual([
          "report-only has 1 skipped row(s) with no passing backfill lane",
        ]);
      }
    }
  });

  it("distinguishes omitted scenario rows from explicitly empty evidence", async () => {
    for (const [counts, scenarios, pass, expectedDetail] of [
      [passedCounts, undefined, true, "counts.failed=0"],
      [passedCounts, [scenario("pass")], true, "counts.failed=0"],
      [passedCounts, [], false, "count/scenario mismatch"],
      [{ total: 3, passed: 2, failed: 0 }, [], false, "no executed scenarios"],
    ] as const) {
      const report = await buildStrictSuiteReport({ counts, ...(scenarios ? { scenarios } : {}) });
      expect(report).toMatchObject({ pass, globalPass: pass });
      expect(report.lanes[0]).toMatchObject({ status: pass ? "pass" : "unknown" });
      expect(report.lanes[0]?.details).toContain(expectedDetail);
    }
  });

  it.each([
    ["skipped", "skipped", [], undefined, false, "token summary has no usage rows"],
    ["missing", "estimated", undefined, undefined, false, "token summary missing rows"],
    [
      "executed",
      "estimated",
      [{ usageSource: "mock-estimate" }],
      undefined,
      true,
      "summary pass=true",
    ],
    ["live", "skipped", [], "live-usage", false, "token summary has no live-usage rows"],
  ] as const)(
    "evaluates %s token evidence",
    async (_name, status, rows, expectedSource, passed, details) => {
      const report = await evaluate(
        {
          status,
          pass: true,
          ...(rows ? { rows } : {}),
        },
        {
          kind: "token-efficiency-summary",
          ...(expectedSource ? { expectedTokenUsageSource: expectedSource } : {}),
        },
        true,
      );

      expect(report.pass).toBe(passed);
      expect(report.globalPass).toBe(passed);
      expect(report.lanes[0]).toMatchObject({
        status: passed ? "pass" : "unknown",
        details,
      });
    },
  );

  it.each(["environment", "plugin"])(
    "classifies %s gateway sentinels without unknowns",
    async (owner) => {
      const environment = owner === "environment";
      const verdict = environment ? "environment-blocked" : "qa-harness-bug";
      const kind = environment ? environmentSentinel.kind : "plugin-hook-failure";
      const sentinelFindings = [{ ...environmentSentinel, kind, owner, verdict }];
      const cells = { codex: { sentinelFindings } };
      const artifact = environment
        ? { gatewayLogSentinels: sentinelFindings }
        : { scenarios: [{ ...scenario("pass"), runtimeParity: { cells } }] };
      const status = environment ? "blocked" : "fail";
      const report = await evaluate({ counts: passedCounts, ...artifact });
      expect(report).toMatchObject({
        pass: true,
        globalPass: false,
        counts: { unknown: 0 },
        lanes: [{ status, verdict }],
      });
      expect(status === "blocked" ? report.counts.blocked : report.counts.failed).toBe(1);
    },
  );

  it("treats corrupt artifacts as unknown instead of allowed missing lanes", async () => {
    const artifactPath = path.join(tempRoot, "live", "qa-suite-summary.json");
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, "{not-json", "utf8");

    const report = await buildReport([
      lane("corrupt", "live/qa-suite-summary.json", { missingVerdict: "environment-blocked" }),
    ]);

    expectUnknown(report, "artifact unreadable", { blocked: 0, unknown: 1 });
  });

  it.each([
    ...(
      [
        [{}, "missing run.status"],
        [{ status: "running" }, "still running"],
        [{ status: "paused" }, "unsupported run.status=paused"],
      ] as const
    ).map(([run, detail]) =>
      invalid({ run, counts: passedCounts, scenarios: [scenario("pass")] }, detail),
    ),
    invalid({}, "missing counts.failed and scenarios[]"),
    invalid({ counts: suiteCounts(0, 0), scenarios: [] }, "no executed scenarios"),
    invalid(
      {
        counts: suiteCounts(2, 2),
        scenarios: [scenario("pass"), scenario("fail")],
      },
      "count/scenario mismatch",
    ),
    invalid(
      { counts: passedCounts, scenarios: [scenario("error")] },
      "unsupported non-pass status",
    ),
    invalid({ scenarios: [scenario("timeout")] }, "unsupported non-pass status"),
    invalid(
      {
        counts: suiteCounts(2, 1, 0, 1),
        gatewayLogSentinels: [environmentSentinel],
        scenarios: [scenario("pass"), scenario("fail")],
      },
      "suite also reports failures",
    ),
    invalid({ counts: suiteCounts(1, -1) }, "counts.passed must be a non-negative"),
    invalid({ counts: { total: 1, passed: 2, failed: 0 } }, "less than provided count sum"),
    invalid(
      { counts: suiteCounts(5, 2, 2) },
      "does not match counts.passed+counts.failed+counts.skipped",
    ),
    invalid({}, "explicit pass signal", "runtime-parity-summary"),
    invalid({ pass: true, canaries: [] }, "no canaries", "self-test-summary"),
    invalid(
      { pass: true, canaries: [{ id: "prompt-drift", detected: true }] },
      "missing expected canaries",
      "self-test-summary",
    ),
  ])("treats artifact %j as unknown: %s", async (artifact, detail, kind) => {
    const report = await evaluate(
      artifact,
      {
        failureVerdict: "qa-harness-bug",
        missingVerdict: "environment-blocked",
        ...(kind ? { kind } : {}),
      },
      true,
    );
    expectUnknown(report, detail, { failed: 0, unknown: 1 });
  });

  it("requires JSONL replay summaries to contain replayed user turns", async () => {
    const full = {
      transcriptPath: "complete.jsonl",
      userTurnCount: 1,
      drift: ["none"],
      cells: { openclaw: [{}], codex: [{}] },
    };
    const empty = { ...full, userTurnCount: 0, drift: [], cells: { openclaw: [], codex: [] } };
    const mismatch = "runtime cell counts do not match userTurnCount";
    const replayCase = (row: object, reason: string) => [[full, row], reason] as const;
    for (const [transcripts, expectedDetail, expectedPass = false] of [
      [[], "no transcripts"],
      [[empty], "no replayed user turns"],
      [[{ ...full, drift: undefined }], "missing drift array"],
      ...[
        undefined,
        empty.cells,
        { openclaw: [], codex: [{}] },
        { openclaw: [{}], codex: [] },
        { openclaw: [{}], codex: [{}, {}] },
      ].map((cells) => replayCase({ ...full, cells }, mismatch)),
      ...[undefined, { openclaw: [{}], codex: [] }, { openclaw: [], codex: [{}] }].map((cells) =>
        replayCase({ ...empty, cells }, mismatch),
      ),
      ...[undefined, null, -1, 1.5, "1"].map((userTurnCount) =>
        replayCase({ ...empty, userTurnCount }, "invalid userTurnCount"),
      ),
      [[full, empty], "replay turns=1, drifted transcripts=0", true],
    ] as const) {
      const report = await evaluate(
        { transcripts },
        {
          kind: "jsonl-replay-summary",
          failureVerdict: "fixture-bug",
        },
      );

      expect(report.pass).toBe(expectedPass);
      expect(report.lanes[0]).toMatchObject({ status: expectedPass ? "pass" : "unknown" });
      expect(report.lanes[0]?.details).toContain(expectedDetail);
    }
  });

  it("accepts a classified failing lane without treating it as unknown", async () => {
    const report = await evaluate(
      {
        transcripts: [
          {
            transcriptPath: "curated.jsonl",
            userTurnCount: 2,
            cells: { openclaw: [{}, {}], codex: [{}, {}] },
            drift: ["none", "tool-result-shape"],
            firstDriftAtTurn: 2,
          },
        ],
      },
      {
        kind: "jsonl-replay-summary",
        failureVerdict: "fixture-bug",
        productImpact: "P4",
        qaImpact: "P1",
      },
    );

    expect(report).toMatchObject({
      pass: true,
      globalPass: false,
      counts: { failed: 1, unknown: 0 },
      lanes: [
        {
          status: "fail",
          verdict: "fixture-bug",
          productImpact: "P4",
          qaImpact: "P1",
        },
      ],
    });
  });

  it("emits confidence self-test canaries for every drift class we need to catch", async () => {
    const { summary, summaryPath, reportPath } = await writeQaConfidenceSelfTestArtifacts({
      outputDir: tempRoot,
    });

    expect(JSON.parse(await fs.readFile(summaryPath, "utf8"))).toEqual(summary);
    expect(await fs.readFile(reportPath, "utf8")).toContain("- Verdict: pass");
    const report = await evaluate(summary, { kind: "self-test-summary" }, true);
    expect(report.pass).toBe(true);
  });
});
