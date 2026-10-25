import fs from "node:fs/promises";
import path from "node:path";
import { markdownToIRWithMeta } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, describe, expect, it } from "vitest";
import { buildQaConfidenceReport, renderQaConfidenceMarkdownReport } from "./confidence-report.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { makeTempDir, cleanup } = createTempDirHarness();
afterEach(cleanup);
const generatedAt = "2026-05-13T00:00:00.000Z";
const counts = { total: 1, passed: 0, failed: 0, blocked: 0, missing: 0, unknown: 0 };
const lane = {
  id: "evidence",
  title: "Evidence",
  artifact: "summary.json",
  required: true,
};
type Lane = Parameters<typeof buildQaConfidenceReport>[0]["manifest"]["lanes"][number];
function buildReport(artifactRoot: string, lanes: Lane[], strictGlobalPass = false) {
  return buildQaConfidenceReport({
    manifest: {
      version: 1,
      profile: strictGlobalPass ? "confidence-table" : "evidence-classification",
      lanes,
    },
    artifactRoot,
    generatedAt,
    strictZeroUnknowns: !strictGlobalPass,
    strictGlobalPass,
  });
}
function missingLane(
  id: string,
  title: string,
  productImpact: string,
  qaImpact: string,
  missingReason: string,
): Lane {
  return {
    id,
    title,
    kind: "qa-suite-summary",
    artifact: `${id}/qa-suite-summary.json`,
    required: true,
    missingVerdict: "environment-blocked",
    missingReason,
    productImpact,
    qaImpact,
  };
}

describe("qa confidence report Markdown", () => {
  it.each([
    [
      "non-object suite",
      "qa-suite-summary",
      [],
      "qa-suite-summary payload was not an object",
      "unknown",
    ],
    [
      "unsupported generic status",
      "generic-pass-summary",
      { status: "skipped" },
      "summary status=skipped",
      "unknown",
    ],
    [
      "missing replay transcripts",
      "jsonl-replay-summary",
      {},
      "jsonl replay summary missing transcripts array",
      "unknown",
    ],
    [
      "invalid replay row before mismatched drift",
      "jsonl-replay-summary",
      { transcripts: [null, { userTurnCount: 2, drift: ["none"] }] },
      "jsonl replay summary has an invalid transcript row",
      "unknown",
    ],
    [
      "mismatched drift before invalid replay row",
      "jsonl-replay-summary",
      { transcripts: [{ userTurnCount: 2, drift: ["none"] }, null] },
      "jsonl replay transcript drift count does not match userTurnCount",
      "unknown",
    ],
    [
      "missing self-test canaries",
      "self-test-summary",
      {},
      "confidence self-test summary missing canaries array",
      "unknown",
    ],
    [
      "non-object generic failure",
      "generic-pass-summary",
      null,
      "summary payload was not an object",
      "fail",
    ],
    [
      "explicit failure before skipped status",
      "generic-pass-summary",
      { pass: false, status: "skipped" },
      "summary pass=false",
      "fail",
    ],
  ] as const)(
    "preserves evidence classification for %s",
    async (_name, kind, payload, details, status) => {
      const tempRoot = await makeTempDir("qa-confidence-markdown-");
      await fs.writeFile(path.join(tempRoot, lane.artifact), JSON.stringify(payload));
      const report = await buildReport(tempRoot, [
        { ...lane, kind, failureVerdict: "fixture-bug" },
      ]);
      const unknown = status === "unknown";
      expect(report).toEqual({
        generatedAt,
        profile: "evidence-classification",
        strictZeroUnknowns: true,
        strictGlobalPass: false,
        pass: !unknown,
        zeroUnknowns: !unknown,
        globalPass: false,
        counts: { ...counts, failed: unknown ? 0 : 1, unknown: unknown ? 1 : 0 },
        failures: unknown ? [`evidence is unclassified: ${details}`] : [],
        lanes: [
          {
            ...lane,
            kind,
            artifactPath: lane.artifact,
            status,
            ...(unknown ? {} : { verdict: "fixture-bug" }),
            details,
          },
        ],
      });
      expect(report.lanes[0]).not.toHaveProperty("skippedCount");
      if (unknown) {
        expect(report.lanes[0]).not.toHaveProperty("verdict");
      }
      expect(renderQaConfidenceMarkdownReport(report)).toContain(
        `| evidence | ${status} | ${unknown ? "unclassified" : "fixture-bug"} |  |  | ${details} |`,
      );
    },
  );

  it.each([
    ["P1", "P2", ["P1", "P2"]],
    ["P1 | desktop", "P2", ["P1 | desktop", "P2"]],
    ["P1", "P2 | harness", ["P1", "P2 | harness"]],
    [String.raw`P1 \| desktop`, "P2", [String.raw`P1 \| desktop`, "P2"]],
    ["P1", String.raw`P2 \| harness`, ["P1", String.raw`P2 \| harness`]],
    ["P1\ndesktop", "P2", ["P1 desktop", "P2"]],
    ["P1", "P2\nharness", ["P1", "P2 harness"]],
  ] as const)(
    "preserves impacts %s / %s in the confidence table",
    async (productImpact, qaImpact, expectedImpacts) => {
      const tempRoot = await makeTempDir("qa-confidence-markdown-");
      const report = await buildReport(
        tempRoot,
        [
          missingLane(
            "missing",
            "Missing",
            productImpact,
            qaImpact,
            String.raw`path\|fallback unavailable`,
          ),
          missingLane("following-control", "Following control", "P4", "P0", "Control unavailable."),
        ],
        true,
      );
      const markdown = renderQaConfidenceMarkdownReport(report);
      const { tables } = markdownToIRWithMeta(markdown, { tableMode: "block" });

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
        [
          "missing",
          "blocked",
          "environment-blocked",
          ...expectedImpacts,
          String.raw`path\|fallback unavailable`,
        ],
        ["following-control", "blocked", "environment-blocked", "P4", "P0", "Control unavailable."],
      ]);
      expect(report.lanes[0]).toMatchObject({
        productImpact,
        qaImpact,
        details: String.raw`path\|fallback unavailable`,
      });
      expect(report.counts).toEqual({ ...counts, total: 2, blocked: 2 });
      expect(report).toMatchObject({ pass: false, zeroUnknowns: true, globalPass: false });
    },
  );
});
