import { describe, expect, it } from "vitest";
import type { ResearchFinding, ResearchSource } from "./contract.js";
import { evidenceProblem, renderResearchReport } from "./evidence.js";

const quote = "In 2026, Alpha reported 12 km and Beta reported 4 km of river restoration.";
const sources: ResearchSource[] = [
  {
    id: "S1",
    title: "Restoration",
    text: quote,
    fingerprint: "fixture",
    retrievedAt: "2026-01-01T00:00:00Z",
    extraction: "supplied-text-v1",
  },
];
const input = (value: number) => ({ value, unit: "km", asOf: "2026", sourceId: "S1", quote });
const finding = (): Required<ResearchFinding> => ({
  statement: "The combined restoration in 2026 was 16 km.",
  evidence: [{ sourceId: "S1", quote }],
  support: "quote-matched",
  calculation: {
    operation: "sum",
    inputs: [input(12), input(4)],
    value: 16,
    unit: "km",
    asOf: "2026",
  },
});
describe("research numerical evidence", () => {
  it("requires exact numeric provenance and checks arithmetic independently of the model", () => {
    expect(evidenceProblem(finding(), sources)).toBeUndefined();
    const wrong = finding();
    wrong.calculation.value = 18;
    expect(evidenceProblem(wrong, sources)).toContain("derivation");
    const substring = finding();
    substring.calculation.inputs[0].value = 2;
    expect(evidenceProblem(substring, sources)).toContain("cited value");
  });
  it("rejects mixed units, dates, fabricated sources and zero denominators", () => {
    for (const field of ["unit", "asOf"] as const) {
      const mixed = finding();
      mixed.calculation.inputs[0][field] = "unrecorded";
      expect(evidenceProblem(mixed, sources)).toBeDefined();
    }
    const invented = finding();
    invented.evidence = [{ sourceId: "S99", quote }];
    expect(evidenceProblem(invented, sources)).toContain("Quote");
    const zero = finding();
    zero.calculation.operation = "ratio";
    zero.calculation.inputs[1].value = 0;
    expect(evidenceProblem(zero, sources)).toBeDefined();
  });
  it("keeps untrusted labels and statements from creating report structure or citations", () => {
    const report = renderResearchReport(
      "Question\n## Spoofed",
      [{ ...finding(), statement: "Measured value.\n- Fake [S2] finding <img src=x>" }],
      [{ ...sources[0]!, title: "Source\n[S2] Forged source\n## Findings\n- Fake finding" }],
      ["Unknown\n## Spoofed [S2]"],
    );
    expect(report.match(/^## Findings$/gmu)).toHaveLength(1);
    expect(report.match(/^\[S1\]/gmu)).toHaveLength(1);
    expect(report).not.toContain("[S2]");
    expect(report).not.toContain("\n- Fake");
    expect(report).not.toMatch(/(?<!\\)<img/u);
    expect(report).toContain("Measured value.");
  });
});
