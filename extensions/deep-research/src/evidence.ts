import type { ResearchFinding, ResearchSource } from "./contract.js";

type CalculationInput = {
  value: number;
  unit: string;
  asOf: string;
  sourceId: string;
  quote: string;
};

export type Calculation = {
  operation: "sum" | "difference" | "ratio" | "percent-change";
  inputs: [CalculationInput, CalculationInput];
  value: number;
  unit: string;
  asOf: string;
};

/** Mechanical provenance is independent of the fallible model's support verdict. */
export function evidenceProblem(
  finding: ResearchFinding,
  sources: ResearchSource[],
): string | undefined {
  for (const evidence of finding.evidence) {
    const source = sources.find((candidate) => candidate.id === evidence.sourceId);
    if (
      !source ||
      evidence.quote.replace(/\s/gu, "").length < 20 ||
      !source.text.includes(evidence.quote)
    ) {
      return "Quote does not occur in the recorded source.";
    }
  }
  if (!finding.calculation) {
    return undefined;
  }
  const { inputs, operation, value, unit, asOf } = finding.calculation;
  if (inputs.length !== 2 || inputs.some((input) => !Number.isFinite(input.value))) {
    return "A calculation requires two finite inputs.";
  }
  for (const input of inputs) {
    if (
      !finding.evidence.some(
        (evidence) => evidence.sourceId === input.sourceId && evidence.quote === input.quote,
      ) ||
      !input.quote
        .split(/[^\d.+-]+/u)
        .some((token) => token !== "" && Number(token) === input.value) ||
      !input.quote.includes(input.unit) ||
      !input.quote.includes(input.asOf)
    ) {
      return "Calculation input is missing a cited value, unit, or date.";
    }
  }
  const [left, right] = inputs;
  if (left.unit !== right.unit || left.asOf !== right.asOf || asOf !== left.asOf) {
    return "Calculation inputs use different units or dates.";
  }
  let expected: number;
  if (operation === "sum") {
    expected = left.value + right.value;
  } else if (operation === "difference") {
    expected = left.value - right.value;
  } else if (operation === "ratio") {
    expected = left.value / right.value;
  } else {
    expected = ((right.value - left.value) / left.value) * 100;
  }
  const expectedUnit =
    operation === "ratio" ? "ratio" : operation === "percent-change" ? "%" : left.unit;
  if (
    unit !== expectedUnit ||
    !Number.isFinite(expected) ||
    Math.abs(value - expected) > 1e-9 * Math.max(1, Math.abs(expected))
  ) {
    return "Calculation result or unit does not match the stated derivation.";
  }
  return undefined;
}

/** The producer records citation ranges while composing, never by scanning user text. */
export function renderResearchDocument(
  question: string,
  findings: ResearchFinding[],
  sources: ResearchSource[],
  gaps: string[],
) {
  let report = `# ${question}\n\n## Findings`;
  const citations: Array<{ sourceId: string; startByte: number; endByte: number }> = [];
  for (const finding of findings) {
    report += `\n- ${finding.statement}`;
    for (const evidence of finding.evidence) {
      report += " ";
      const startByte = Buffer.byteLength(report);
      report += `[${evidence.sourceId}]`;
      citations.push({
        sourceId: evidence.sourceId,
        startByte,
        endByte: Buffer.byteLength(report),
      });
    }
  }
  if (gaps.length) {
    report += `\n\n## Unresolved\n${gaps.map((gap) => `- ${gap}`).join("\n")}`;
  }
  report += "\n\n## Sources";
  for (const source of sources) {
    report += `\n[${source.id}] ${source.title}${source.url ? ` — ${source.url}` : " (supplied document)"}`;
  }
  return { report, citations };
}
