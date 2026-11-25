import fs from "node:fs/promises";
import path from "node:path";
import { markdownToIRWithMeta } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, expect, it } from "vitest";
import { buildQaConfidenceReport, renderQaConfidenceMarkdownReport } from "./confidence-report.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { makeTempDir, cleanup } = createTempDirHarness();
afterEach(cleanup);
type Lane = Parameters<typeof buildQaConfidenceReport>[0]["manifest"]["lanes"][number];
const lane = (id: string, options: Partial<Lane> = {}): Lane => ({
  id,
  title: id,
  kind: "qa-suite-summary",
  artifact: `${id}.json`,
  required: true,
  ...options,
});
function buildReport(artifactRoot: string, lanes: Lane[], strictGlobalPass = false) {
  return buildQaConfidenceReport({
    manifest: { version: 1, profile: "markdown", lanes },
    artifactRoot,
    strictZeroUnknowns: true,
    strictGlobalPass,
  });
}

it.each([
  ["qa-suite-summary", [], "unknown"],
  ["generic-pass-summary", { status: "skipped" }, "unknown"],
  ["jsonl-replay-summary", {}, "unknown"],
  ["jsonl-replay-summary", { transcripts: [null] }, "unknown"],
  ["jsonl-replay-summary", { transcripts: [{ userTurnCount: 1, drift: [] }] }, "unknown"],
  ["self-test-summary", {}, "unknown"],
  ["generic-pass-summary", null, "fail"],
  ["generic-pass-summary", { pass: false, status: "skipped" }, "fail"],
] as const)("renders %s payload %j as %s", async (kind, payload, status) => {
  const root = await makeTempDir("qa-confidence-markdown-");
  await fs.writeFile(path.join(root, "evidence.json"), JSON.stringify(payload));
  const report = await buildReport(root, [
    lane("evidence", { kind, failureVerdict: "fixture-bug" }),
  ]);
  const verdict = status === "unknown" ? undefined : "fixture-bug";
  expect(report).toMatchObject({
    pass: status === "fail",
    zeroUnknowns: status === "fail",
    globalPass: false,
  });
  expect(report.lanes[0]).toMatchObject({ status });
  expect(report.lanes[0]?.verdict).toBe(verdict);
  const { tables } = markdownToIRWithMeta(renderQaConfidenceMarkdownReport(report), {
    tableMode: "block",
  });
  expect(tables[0]?.rows.map((row) => row.slice(0, 5))).toEqual([
    ["evidence", status, verdict ?? "unclassified", "", ""],
  ]);
});

it.each([
  ["P1", "P2", ["P1", "P2"]],
  ["P1 | desktop", "P2 | harness", ["P1 | desktop", "P2 | harness"]],
  [
    String.raw`P1 \| desktop`,
    String.raw`P2 \| harness`,
    [String.raw`P1 \| desktop`, String.raw`P2 \| harness`],
  ],
  ["P1\ndesktop", "P2\nharness", ["P1 desktop", "P2 harness"]],
] as const)(
  "preserves impacts %s / %s in the confidence table",
  async (productImpact, qaImpact, expectedImpacts) => {
    const details = String.raw`path\|fallback unavailable`;
    const blockedLane = (id: string, product: string, qa: string, missingReason: string) =>
      lane(id, {
        productImpact: product,
        qaImpact: qa,
        missingReason,
        missingVerdict: "environment-blocked",
      });
    const report = await buildReport(
      await makeTempDir("qa-confidence-markdown-"),
      [
        blockedLane("missing", productImpact, qaImpact, details),
        blockedLane("following-control", "P4", "P0", "Control unavailable."),
      ],
      true,
    );
    const { tables } = markdownToIRWithMeta(renderQaConfidenceMarkdownReport(report), {
      tableMode: "block",
    });
    expect(tables).toHaveLength(1);
    expect(tables[0]?.headers).toEqual([
      "Lane",
      "Status",
      "Verdict",
      "Product impact",
      "QA impact",
      "Details",
    ]);
    expect(tables[0]?.rows).toEqual([
      ["missing", "blocked", "environment-blocked", ...expectedImpacts, details],
      ["following-control", "blocked", "environment-blocked", "P4", "P0", "Control unavailable."],
    ]);
    expect(report.lanes[0]).toMatchObject({ productImpact, qaImpact, details });
    expect(report).toMatchObject({
      pass: false,
      zeroUnknowns: true,
      globalPass: false,
      counts: { blocked: 2 },
    });
  },
);
