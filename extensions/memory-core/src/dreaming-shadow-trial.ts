import fs from "node:fs/promises";
import path from "node:path";

export type DreamingShadowTrialVerdict = "helpful" | "neutral" | "harmful";
export type DreamingShadowTrialRecommendation = "promote" | "defer" | "reject";

export type DreamingShadowTrialInput = {
  candidate: string;
  trialPrompt: string;
  baselineOutcome: string;
  candidateOutcome: string;
  verdict: DreamingShadowTrialVerdict;
  reason: string;
  riskFlags?: string[];
  evidenceRefs?: string[];
  workspaceDir?: string;
  reportPath?: string;
  nowMs?: number;
};

export type DreamingShadowTrialReport = {
  candidate: string;
  trialPrompt: string;
  baselineOutcome: string;
  candidateOutcome: string;
  verdict: DreamingShadowTrialVerdict;
  recommendation: DreamingShadowTrialRecommendation;
  reason: string;
  riskFlags: string[];
  evidenceRefs: string[];
  promotionAction: "report-only";
  reportPath?: string;
  markdown: string;
};

function normalizeRequiredText(value: string, label: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new Error(`dreaming shadow trial requires ${label}`);
  }
  return normalized;
}

function normalizeList(values: string[] | undefined, fallback: string): string[] {
  const normalized = (values ?? []).map((value) => value.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : [fallback];
}

export function resolveDreamingShadowTrialRecommendation(
  verdict: DreamingShadowTrialVerdict,
): DreamingShadowTrialRecommendation {
  if (verdict === "helpful") {
    return "promote";
  }
  if (verdict === "harmful") {
    return "reject";
  }
  return "defer";
}

function formatList(values: string[]): string {
  return values.map((value) => `- ${value}`).join("\n");
}

function formatShadowTrialDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function defaultDreamingShadowTrialReportPath(params: {
  workspaceDir: string;
  nowMs?: number;
}): string {
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  return path.join(
    params.workspaceDir,
    "memory",
    "dreaming",
    "shadow-trials",
    `${formatShadowTrialDay(nowMs)}.md`,
  );
}

function resolveReportPath(params: {
  workspaceDir?: string;
  reportPath?: string;
  nowMs?: number;
}): string | undefined {
  if (params.reportPath) {
    if (path.isAbsolute(params.reportPath)) {
      return params.reportPath;
    }
    if (!params.workspaceDir) {
      throw new Error("dreaming shadow trial relative reportPath requires workspaceDir");
    }
    return path.join(params.workspaceDir, params.reportPath);
  }
  if (!params.workspaceDir) {
    return undefined;
  }
  return defaultDreamingShadowTrialReportPath({
    workspaceDir: params.workspaceDir,
    nowMs: params.nowMs,
  });
}

export function buildDreamingShadowTrialReport(
  input: DreamingShadowTrialInput,
): DreamingShadowTrialReport {
  const candidate = normalizeRequiredText(input.candidate, "candidate");
  const trialPrompt = normalizeRequiredText(input.trialPrompt, "trialPrompt");
  const baselineOutcome = normalizeRequiredText(input.baselineOutcome, "baselineOutcome");
  const candidateOutcome = normalizeRequiredText(input.candidateOutcome, "candidateOutcome");
  const reason = normalizeRequiredText(input.reason, "reason");
  const riskFlags = normalizeList(input.riskFlags, "none recorded");
  const evidenceRefs = normalizeList(input.evidenceRefs, "none supplied");
  const recommendation = resolveDreamingShadowTrialRecommendation(input.verdict);
  const reportPath = resolveReportPath({
    workspaceDir: input.workspaceDir,
    reportPath: input.reportPath,
    nowMs: input.nowMs,
  });

  const markdown = [
    "# Dreaming Shadow Trial Report",
    "",
    `candidate: ${candidate}`,
    `trial prompt: ${trialPrompt}`,
    `baseline outcome: ${baselineOutcome}`,
    `candidate outcome: ${candidateOutcome}`,
    `verdict: ${input.verdict}`,
    `recommendation: ${recommendation}`,
    `reason: ${reason}`,
    "risk flags:",
    formatList(riskFlags),
    "evidence refs:",
    formatList(evidenceRefs),
    "promotion action: report-only",
    "",
  ].join("\n");

  return {
    candidate,
    trialPrompt,
    baselineOutcome,
    candidateOutcome,
    verdict: input.verdict,
    recommendation,
    reason,
    riskFlags,
    evidenceRefs,
    promotionAction: "report-only",
    ...(reportPath ? { reportPath } : {}),
    markdown,
  };
}

export async function writeDreamingShadowTrialReport(
  input: DreamingShadowTrialInput & { workspaceDir: string },
): Promise<DreamingShadowTrialReport> {
  const report = buildDreamingShadowTrialReport(input);
  if (!report.reportPath) {
    throw new Error("dreaming shadow trial report path could not be resolved");
  }
  await fs.mkdir(path.dirname(report.reportPath), { recursive: true });
  await fs.writeFile(report.reportPath, report.markdown, "utf-8");
  return report;
}
