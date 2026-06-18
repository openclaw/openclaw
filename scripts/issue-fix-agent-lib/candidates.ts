import type { IssueCandidate, QualifiedCandidate, SkippedCandidate } from "./types.js";

const highRiskLabels = new Set([
  "security",
  "auth",
  "migration",
  "release",
  "installer",
  "feature",
  "enhancement",
]);

const maintainerAuthors = new Set([
  "vincentkoc",
  "Takhoffman",
  "gumadeiras",
  "obviyus",
  "shakkernerd",
  "mbelinky",
  "joshavant",
  "ngutman",
  "vignesh07",
  "huntharo",
]);

export type CandidateClassification =
  | { kind: "qualified"; candidate: QualifiedCandidate }
  | { kind: "skipped"; candidate: SkippedCandidate; reason: string };

function hasConcreteSymptom(issue: IssueCandidate): boolean {
  const haystack = `${issue.title}\n${issue.body}`.toLowerCase();
  return /\b(repro|steps|stack|trace|throws|error|crash|fails?|typeerror|exception|regression|expected|actual)\b/u.test(
    haystack,
  );
}

function pathHintScore(issue: IssueCandidate): number {
  return /\b(?:src|scripts|test|packages|extensions|docs)\/[^\s)]+/u.test(issue.body) ? 2 : 0;
}

function skipped(issue: IssueCandidate, reason: string): CandidateClassification {
  return { kind: "skipped", candidate: { ...issue, reason }, reason };
}

export function classifyIssueCandidate(issue: IssueCandidate): CandidateClassification {
  if (issue.isPullRequest) {
    return skipped(issue, "item is a pull request");
  }
  const risky = issue.labels.find((label) => highRiskLabels.has(label));
  if (risky) {
    return skipped(issue, `high-risk label: ${risky}`);
  }
  if (maintainerAuthors.has(issue.author) && !issue.labels.includes("clawsweeper:queueable-fix")) {
    return skipped(issue, "maintainer-owned queue item without queueable-fix signal");
  }
  if (!hasConcreteSymptom(issue)) {
    return skipped(issue, "missing concrete symptom");
  }

  const evidence = ["concrete symptom"];
  let score = 1 + pathHintScore(issue);
  if (/\b(stack|trace|typeerror|exception)\b/iu.test(issue.body)) {
    score += 3;
    evidence.push("error evidence");
  }
  if (issue.labels.includes("clawsweeper:source-repro")) {
    score += 2;
    evidence.push("source repro label");
  }
  if (issue.labels.includes("clawsweeper:queueable-fix")) {
    score += 2;
    evidence.push("queueable fix label");
  }
  return { kind: "qualified", candidate: { ...issue, evidence, score } };
}

export function sortQualifiedCandidates(
  candidates: readonly QualifiedCandidate[],
): QualifiedCandidate[] {
  return [...candidates].sort((left, right) => right.score - left.score || left.number - right.number);
}

export function formatScanResult(params: {
  qualified: readonly QualifiedCandidate[];
  skipped: readonly SkippedCandidate[];
}): string {
  const lines = ["Qualified candidates:"];
  for (const candidate of sortQualifiedCandidates(params.qualified)) {
    lines.push(`#${candidate.number} ${candidate.title} score=${candidate.score} ${candidate.url}`);
    lines.push(`  evidence: ${candidate.evidence.join(", ")}`);
  }
  lines.push("Skipped candidates:");
  for (const candidate of params.skipped) {
    lines.push(`skipped #${candidate.number}: ${candidate.reason}`);
  }
  return `${lines.join("\n")}\n`;
}
