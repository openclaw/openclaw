import { expect, it } from "vitest";
import { reportBlocks, reportSegments, safeSourceUrl } from "../browser/report.js";

it("renders text-only headings without changing UTF-8 citation attribution", () => {
  const report = "# Café [S1]\n\n## Findings\nA ☕ source [S1]\n<script>unsafe()</script>";
  const startByte = Buffer.byteLength(report.slice(0, report.lastIndexOf("[S1]")));
  const view = {
    report,
    citations: [{ sourceId: "S1", startByte, endByte: startByte + 4 }],
    sources: [
      {
        id: "S1",
        title: "Café",
        provenance: "provider-cited" as const,
        retrievalStatus: "not-fetched" as const,
      },
    ],
  };
  const segments = reportSegments(view);
  expect(segments.map((segment) => segment.text).join("")).toBe(report);
  const blocks = reportBlocks(view);
  expect(blocks.slice(0, 2)).toEqual([
    { heading: 1, segments: [{ text: "Café [S1]" }] },
    { heading: 2, segments: [{ text: "Findings" }] },
  ]);
  expect(blocks.flatMap((block) => block.segments).filter((segment) => segment.sourceId)).toEqual([
    { text: "[S1]", sourceId: "S1" },
  ]);
  expect(blocks.at(-1)?.segments).toEqual([{ text: "<script>unsafe()</script>" }]);
  const invalid = reportSegments({
    ...view,
    citations: [
      { sourceId: "S1", startByte: 5, endByte: 6 },
      { sourceId: "S1", startByte: 0, endByte: 900 },
      { sourceId: "missing", startByte, endByte: startByte + 4 },
    ],
  });
  expect(invalid.map((segment) => segment.text).join("")).toBe(report);
  expect(invalid.some((segment) => segment.sourceId)).toBe(false);
});

it.each([
  "javascript:alert(1)",
  "data:text/html,hello",
  "https://user:pass@example.org",
  "file:///private",
  "//example.org",
])("rejects unsafe external link %s", (url) => {
  expect(safeSourceUrl(url)).toBeUndefined();
});
