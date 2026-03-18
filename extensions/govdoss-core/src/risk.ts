export type GovdossRiskTier = "LOW" | "MEDIUM" | "HIGH";

export type GovdossRiskInput = {
  action?: string;
  mode?: string;
  targetType?: string;
  containsSensitiveData?: boolean;
  externalDestination?: boolean;
};

export type GovdossRiskScore = {
  tier: GovdossRiskTier;
  score: number;
  reasons: string[];
};

export function scoreGovdossRisk(input: GovdossRiskInput): GovdossRiskScore {
  let score = 0;
  const reasons: string[] = [];

  if (input.mode === "bounded-autonomy") {
    score += 15;
    reasons.push("autonomous-execution-mode");
  }

  if (input.action === "command" || input.action === "navigate") {
    score += 20;
    reasons.push("higher-impact-action");
  }

  if (input.targetType === "file" || input.targetType === "device") {
    score += 20;
    reasons.push("sensitive-target-surface");
  }

  if (input.containsSensitiveData) {
    score += 25;
    reasons.push("sensitive-data-present");
  }

  if (input.externalDestination) {
    score += 25;
    reasons.push("external-destination");
  }

  if (score >= 50) {
    return { tier: "HIGH", score, reasons };
  }

  if (score >= 20) {
    return { tier: "MEDIUM", score, reasons };
  }

  return { tier: "LOW", score, reasons };
}
