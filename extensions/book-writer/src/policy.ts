import type { ResolvedBookWriterConfig } from "./config.js";
import type { GateFinding, GateReport } from "./types.js";

const CRITICAL_DISCUSSION_PATTERN =
  /\b(critical|critique|criticize|warning|against|oppose|opposes|history|historical|adversarial|risk|failure|failed)\b/i;

const PLATFORM_RISK_PATTERNS: Array<{ code: string; pattern: RegExp; message: string }> = [
  {
    code: "threat-group",
    pattern: /\b(kill|exterminate|eliminate)\s+all\b/i,
    message: "Threatening or violent group-targeted language is blocked.",
  },
  {
    code: "protected-class-inferiority",
    pattern: /\binferior\s+(race|ethnicity|religion|class|people)\b/i,
    message: "Protected-class inferiority claims are blocked.",
  },
  {
    code: "misleading-metadata",
    pattern: /\bguaranteed\s+(cure|profit|bestseller|income)\b/i,
    message: "Misleading guarantees are blocked.",
  },
];

export function buildEditorialPolicyReport(params: {
  config: ResolvedBookWriterConfig;
  text: string;
}): GateReport {
  const findings: GateFinding[] = [];
  const text = params.text;
  const criticalContextAllowed =
    params.config.editorialPolicy.allowCriticalHistoricalDiscussion &&
    CRITICAL_DISCUSSION_PATTERN.test(text);

  for (const theme of params.config.editorialPolicy.blockedAffirmativeThemes) {
    const pattern = new RegExp(`\\b${theme.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (!pattern.test(text)) {
      continue;
    }
    if (criticalContextAllowed) {
      findings.push({
        code: `editorial-theme-${theme.toLowerCase()}`,
        status: "warn",
        message: `${theme} appears in critical or historical context and is allowed for review.`,
      });
      continue;
    }
    findings.push({
      code: `editorial-theme-${theme.toLowerCase()}`,
      status: params.config.editorialPolicy.uncertainMeansBlocked ? "blocked" : "fail",
      message: `${theme} appears without a critical/historical cue and is blocked by editorial policy.`,
    });
  }

  for (const risk of PLATFORM_RISK_PATTERNS) {
    if (risk.pattern.test(text)) {
      findings.push({
        code: risk.code,
        status: "blocked",
        message: risk.message,
      });
    }
  }

  if (findings.length === 0) {
    findings.push({
      code: "editorial-policy",
      status: "pass",
      message: "No editorial-policy or platform-risk block detected.",
    });
  }

  return {
    status: findings.some((finding) => finding.status === "blocked")
      ? "blocked"
      : findings.some((finding) => finding.status === "fail")
        ? "fail"
        : findings.some((finding) => finding.status === "warn")
          ? "warn"
          : "pass",
    findings,
  };
}
