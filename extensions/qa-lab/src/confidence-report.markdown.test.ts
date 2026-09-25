import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { markdownToIRWithMeta } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildQaConfidenceReport, renderQaConfidenceMarkdownReport } from "./confidence-report.js";

describe("qa confidence report Markdown", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-confidence-markdown-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

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
      await fs.mkdir(path.join(tempRoot, "evidence"), { recursive: true });
      await fs.writeFile(
        path.join(tempRoot, "evidence/summary.json"),
        `${JSON.stringify(payload, null, 2)}\n`,
        "utf8",
      );
      const lane = {
        id: "evidence",
        title: "Evidence",
        kind,
        artifact: "evidence/summary.json",
        required: true,
      };
      const generatedAt = "2026-05-13T00:00:00.000Z";
      const report = await buildQaConfidenceReport({
        manifest: {
          version: 1,
          profile: "evidence-classification",
          lanes: [{ ...lane, failureVerdict: "fixture-bug" }],
        },
        artifactRoot: tempRoot,
        strictZeroUnknowns: true,
        generatedAt,
      });
      const unknown = status === "unknown";
      const expected = {
        generatedAt,
        profile: "evidence-classification",
        strictZeroUnknowns: true,
        strictGlobalPass: false,
        pass: !unknown,
        zeroUnknowns: !unknown,
        globalPass: false,
        counts: {
          total: 1,
          passed: 0,
          failed: unknown ? 0 : 1,
          blocked: 0,
          missing: 0,
          unknown: unknown ? 1 : 0,
        },
        failures: unknown ? [`evidence is unclassified: ${details}`] : [],
        lanes: [
          {
            id: lane.id,
            title: lane.title,
            kind,
            artifact: lane.artifact,
            artifactPath: lane.artifact,
            required: true,
            status,
            ...(unknown ? {} : { verdict: "fixture-bug" }),
            details,
          },
        ],
      };

      expect(JSON.stringify(report)).toBe(JSON.stringify(expected));
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
    {
      name: "ordinary priorities",
      productImpact: "P1",
      qaImpact: "P2",
      expectedImpacts: ["P1", "P2"],
    },
    {
      name: "a product-impact pipe",
      productImpact: "P1 | desktop",
      qaImpact: "P2",
      expectedImpacts: ["P1 | desktop", "P2"],
    },
    {
      name: "a QA-impact pipe",
      productImpact: "P1",
      qaImpact: "P2 | harness",
      expectedImpacts: ["P1", "P2 | harness"],
    },
    {
      name: "a product-impact backslash and pipe",
      productImpact: String.raw`P1 \| desktop`,
      qaImpact: "P2",
      expectedImpacts: [String.raw`P1 \| desktop`, "P2"],
    },
    {
      name: "a QA-impact backslash and pipe",
      productImpact: "P1",
      qaImpact: String.raw`P2 \| harness`,
      expectedImpacts: ["P1", String.raw`P2 \| harness`],
    },
    {
      name: "a product-impact newline",
      productImpact: "P1\ndesktop",
      qaImpact: "P2",
      expectedImpacts: ["P1 desktop", "P2"],
    },
    {
      name: "a QA-impact newline",
      productImpact: "P1",
      qaImpact: "P2\nharness",
      expectedImpacts: ["P1", "P2 harness"],
    },
  ])(
    "preserves $name in the confidence table",
    async ({ productImpact, qaImpact, expectedImpacts }) => {
      const report = await buildQaConfidenceReport({
        manifest: {
          version: 1,
          profile: "confidence-table",
          lanes: [
            {
              id: "missing",
              title: "Missing",
              kind: "qa-suite-summary",
              artifact: "missing/qa-suite-summary.json",
              required: true,
              missingVerdict: "environment-blocked",
              missingReason: String.raw`path\|fallback unavailable`,
              productImpact,
              qaImpact,
            },
            {
              id: "following-control",
              title: "Following control",
              kind: "qa-suite-summary",
              artifact: "control/qa-suite-summary.json",
              required: true,
              missingVerdict: "environment-blocked",
              missingReason: "Control unavailable.",
              productImpact: "P4",
              qaImpact: "P0",
            },
          ],
        },
        artifactRoot: tempRoot,
        strictGlobalPass: true,
        generatedAt: "2026-05-13T00:00:00.000Z",
      });
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
      expect(report.counts).toEqual({
        total: 2,
        passed: 0,
        failed: 0,
        blocked: 2,
        missing: 0,
        unknown: 0,
      });
      expect(report).toMatchObject({ pass: false, zeroUnknowns: true, globalPass: false });
    },
  );
});
