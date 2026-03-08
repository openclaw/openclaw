# Probability and Impact Scale

## Principle

Risk scoring uses a **probability × impact** matrix (1-9 scale) to prioritize testing efforts. Higher scores (6-9) demand immediate action; lower scores (1-3) require documentation only. This systematic approach ensures testing resources focus on the highest-value risks.

## Rationale

**The Problem**: Without quantifiable risk assessment, teams over-test low-value scenarios while missing critical risks. Gut feeling leads to inconsistent prioritization and missed edge cases.

**The Solution**: Standardize risk evaluation with a 3×3 matrix (probability: 1-3, impact: 1-3). Multiply to derive risk score (1-9). Automate classification (DOCUMENT, MONITOR, MITIGATE, BLOCK) based on thresholds. This approach surfaces hidden risks early and justifies testing decisions to stakeholders.

**Why This Matters**:

- Consistent risk language across product, engineering, and QA
- Objective prioritization of test scenarios (not politics)
- Automatic gate decisions (score=9 → FAIL until resolved)
- Audit trail for compliance and retrospectives

## Pattern Examples

### Example 1: Probability-Impact Matrix Implementation (Automated Classification)

**Context**: Implement a reusable risk scoring system with automatic threshold classification

**Implementation**:

```typescript
// src/testing/risk-matrix.ts

/**
 * Probability levels:
 * 1 = Unlikely (standard implementation, low uncertainty)
 * 2 = Possible (edge cases or partial unknowns)
 * 3 = Likely (known issues, new integrations, high ambiguity)
 */
export type Probability = 1 | 2 | 3;

/**
 * Impact levels:
 * 1 = Minor (cosmetic issues or easy workarounds)
 * 2 = Degraded (partial feature loss or manual workaround)
 * 3 = Critical (blockers, data/security/regulatory exposure)
 */
export type Impact = 1 | 2 | 3;

/**
 * Risk score (probability × impact): 1-9
 */
export type RiskScore = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * Action categories based on risk score thresholds
 */
export type RiskAction = "DOCUMENT" | "MONITOR" | "MITIGATE" | "BLOCK";

export type RiskAssessment = {
  probability: Probability;
  impact: Impact;
  score: RiskScore;
  action: RiskAction;
  reasoning: string;
};

/**
 * Calculate risk score: probability × impact
 */
export function calculateRiskScore(probability: Probability, impact: Impact): RiskScore {
  return (probability * impact) as RiskScore;
}

/**
 * Classify risk action based on score thresholds:
 * - 1-3: DOCUMENT (awareness only)
 * - 4-5: MONITOR (watch closely, plan mitigations)
 * - 6-8: MITIGATE (CONCERNS at gate until mitigated)
 * - 9: BLOCK (automatic FAIL until resolved or waived)
 */
export function classifyRiskAction(score: RiskScore): RiskAction {
  if (score >= 9) return "BLOCK";
  if (score >= 6) return "MITIGATE";
  if (score >= 4) return "MONITOR";
  return "DOCUMENT";
}

/**
 * Full risk assessment with automatic classification
 */
export function assessRisk(params: {
  probability: Probability;
  impact: Impact;
  reasoning: string;
}): RiskAssessment {
  const { probability, impact, reasoning } = params;

  const score = calculateRiskScore(probability, impact);
  const action = classifyRiskAction(score);

  return { probability, impact, score, action, reasoning };
}

/**
 * Generate risk matrix visualization (3x3 grid)
 * Returns markdown table with color-coded scores
 */
export function generateRiskMatrix(): string {
  const matrix: string[][] = [];
  const header = ["Impact \\ Probability", "Unlikely (1)", "Possible (2)", "Likely (3)"];
  matrix.push(header);

  const impactLabels = ["Critical (3)", "Degraded (2)", "Minor (1)"];
  for (let impact = 3; impact >= 1; impact--) {
    const row = [impactLabels[3 - impact]];
    for (let probability = 1; probability <= 3; probability++) {
      const score = calculateRiskScore(probability as Probability, impact as Impact);
      const action = classifyRiskAction(score);
      const emoji =
        action === "BLOCK"
          ? "🔴"
          : action === "MITIGATE"
            ? "🟠"
            : action === "MONITOR"
              ? "🟡"
              : "🟢";
      row.push(`${emoji} ${score}`);
    }
    matrix.push(row);
  }

  return matrix.map((row) => `| ${row.join(" | ")} |`).join("\n");
}
```

**Key Points**:

- Type-safe probability/impact (1-3 enforced at compile time)
- Automatic action classification (DOCUMENT, MONITOR, MITIGATE, BLOCK)
- Visual matrix generation for documentation
- Risk score formula: `probability * impact` (max = 9)
- Threshold-based decision rules (6-8 = MITIGATE, 9 = BLOCK)

---

### Example 2: Risk Assessment Workflow (Test Planning Integration)

**Context**: Apply risk matrix during test design to prioritize scenarios

**Implementation**:

```typescript
// tests/e2e/test-planning/risk-assessment.ts
import {
  assessRisk,
  generateRiskMatrix,
  type RiskAssessment,
} from "../../../src/testing/risk-matrix";

export type TestScenario = {
  id: string;
  title: string;
  feature: string;
  risk: RiskAssessment;
  testLevel: "E2E" | "API" | "Unit";
  priority: "P0" | "P1" | "P2" | "P3";
  owner: string;
};

/**
 * Assess test scenarios and auto-assign priority based on risk score
 */
export function assessTestScenarios(
  scenarios: Omit<TestScenario, "risk" | "priority">[],
): TestScenario[] {
  return scenarios.map((scenario) => {
    // Auto-assign priority based on risk score
    const priority = mapRiskToPriority(scenario.risk.score);
    return { ...scenario, priority };
  });
}

/**
 * Map risk score to test priority (P0-P3)
 * P0: Critical (score 9) - blocks release
 * P1: High (score 6-8) - must fix before release
 * P2: Medium (score 4-5) - fix if time permits
 * P3: Low (score 1-3) - document and defer
 */
function mapRiskToPriority(score: number): "P0" | "P1" | "P2" | "P3" {
  if (score === 9) return "P0";
  if (score >= 6) return "P1";
  if (score >= 4) return "P2";
  return "P3";
}

/**
 * Example: Payment flow risk assessment
 */
export const paymentScenarios: Array<Omit<TestScenario, "priority">> = [
  {
    id: "PAY-001",
    title: "Valid credit card payment completes successfully",
    feature: "Checkout",
    risk: assessRisk({
      probability: 2, // Possible (standard Stripe integration)
      impact: 3, // Critical (revenue loss if broken)
      reasoning: "Core revenue flow, but Stripe is well-tested",
    }),
    testLevel: "E2E",
    owner: "qa-team",
  },
  {
    id: "PAY-002",
    title: "Expired credit card shows user-friendly error",
    feature: "Checkout",
    risk: assessRisk({
      probability: 3, // Likely (edge case handling often buggy)
      impact: 2, // Degraded (users see error, but can retry)
      reasoning: "Error handling logic is custom and complex",
    }),
    testLevel: "E2E",
    owner: "qa-team",
  },
  {
    id: "PAY-003",
    title: "Payment confirmation email formatting is correct",
    feature: "Email",
    risk: assessRisk({
      probability: 2, // Possible (template changes occasionally break)
      impact: 1, // Minor (cosmetic issue, email still sent)
      reasoning: "Non-blocking, users get email regardless",
    }),
    testLevel: "Unit",
    owner: "dev-team",
  },
  {
    id: "PAY-004",
    title: "Payment fails gracefully when Stripe is down",
    feature: "Checkout",
    risk: assessRisk({
      probability: 1, // Unlikely (Stripe has 99.99% uptime)
      impact: 3, // Critical (complete checkout failure)
      reasoning: "Rare but catastrophic, requires retry mechanism",
    }),
    testLevel: "API",
    owner: "qa-team",
  },
];

/**
 * Generate risk assessment report with priority distribution
 */
export function generateRiskReport(scenarios: TestScenario[]): string {
  const priorityCounts = scenarios.reduce(
    (acc, s) => {
      acc[s.priority] = (acc[s.priority] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const actionCounts = scenarios.reduce(
    (acc, s) => {
      acc[s.risk.action] = (acc[s.risk.action] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return `
# Risk Assessment Report

## Risk Matrix
${generateRiskMatrix()}

## Priority Distribution
- **P0 (Blocker)**: ${priorityCounts.P0 || 0} scenarios
- **P1 (High)**: ${priorityCounts.P1 || 0} scenarios
- **P2 (Medium)**: ${priorityCounts.P2 || 0} scenarios
- **P3 (Low)**: ${priorityCounts.P3 || 0} scenarios

## Action Required
- **BLOCK**: ${actionCounts.BLOCK || 0} scenarios (auto-fail gate)
- **MITIGATE**: ${actionCounts.MITIGATE || 0} scenarios (concerns at gate)
- **MONITOR**: ${actionCounts.MONITOR || 0} scenarios (watch closely)
- **DOCUMENT**: ${actionCounts.DOCUMENT || 0} scenarios (awareness only)

## Scenarios by Risk Score (Highest First)
${scenarios
  .sort((a, b) => b.risk.score - a.risk.score)
  .map(
    (s) => `- **[${s.priority}]** ${s.id}: ${s.title} (Score: ${s.risk.score} - ${s.risk.action})`,
  )
  .join("\n")}
`.trim();
}
```

**Key Points**:

- Risk score → Priority mapping (P0-P3 automated)
- Report generation with priority/action distribution
- Scenarios sorted by risk score (highest first)
- Visual matrix included in reports
- Reusable across projects (extract to shared library)

---

### Example 3: Dynamic Risk Re-Assessment (Continuous Evaluation)

**Context**: Recalculate risk scores as project evolves (requirements change, mitigations implemented)

**Implementation**:

```typescript
// src/testing/risk-tracking.ts
import { type RiskAssessment, assessRisk, type Probability, type Impact } from "./risk-matrix";

export type RiskHistory = {
  timestamp: Date;
  assessment: RiskAssessment;
  changedBy: string;
  reason: string;
};

export type TrackedRisk = {
  id: string;
  title: string;
  feature: string;
  currentRisk: RiskAssessment;
  history: RiskHistory[];
  mitigations: string[];
  status: "OPEN" | "MITIGATED" | "WAIVED" | "RESOLVED";
};

export class RiskTracker {
  private risks: Map<string, TrackedRisk> = new Map();

  /**
   * Add new risk to tracker
   */
  addRisk(params: {
    id: string;
    title: string;
    feature: string;
    probability: Probability;
    impact: Impact;
    reasoning: string;
    changedBy: string;
  }): TrackedRisk {
    const { id, title, feature, probability, impact, reasoning, changedBy } = params;

    const assessment = assessRisk({ probability, impact, reasoning });

    const risk: TrackedRisk = {
      id,
      title,
      feature,
      currentRisk: assessment,
      history: [
        {
          timestamp: new Date(),
          assessment,
          changedBy,
          reason: "Initial assessment",
        },
      ],
      mitigations: [],
      status: "OPEN",
    };

    this.risks.set(id, risk);
    return risk;
  }

  /**
   * Reassess risk (probability or impact changed)
   */
  reassessRisk(params: {
    id: string;
    probability?: Probability;
    impact?: Impact;
    reasoning: string;
    changedBy: string;
  }): TrackedRisk | null {
    const { id, probability, impact, reasoning, changedBy } = params;
    const risk = this.risks.get(id);
    if (!risk) return null;

    // Use existing values if not provided
    const newProbability = probability ?? risk.currentRisk.probability;
    const newImpact = impact ?? risk.currentRisk.impact;

    const newAssessment = assessRisk({
      probability: newProbability,
      impact: newImpact,
      reasoning,
    });

    risk.currentRisk = newAssessment;
    risk.history.push({
      timestamp: new Date(),
      assessment: newAssessment,
      changedBy,
      reason: reasoning,
    });

    this.risks.set(id, risk);
    return risk;
  }

  /**
   * Mark risk as mitigated (probability reduced)
   */
  mitigateRisk(params: {
    id: string;
    newProbability: Probability;
    mitigation: string;
    changedBy: string;
  }): TrackedRisk | null {
    const { id, newProbability, mitigation, changedBy } = params;
    const risk = this.reassessRisk({
      id,
      probability: newProbability,
      reasoning: `Mitigation implemented: ${mitigation}`,
      changedBy,
    });

    if (risk) {
      risk.mitigations.push(mitigation);
      if (risk.currentRisk.action === "DOCUMENT" || risk.currentRisk.action === "MONITOR") {
        risk.status = "MITIGATED";
      }
    }

    return risk;
  }

  /**
   * Get risks requiring action (MITIGATE or BLOCK)
   */
  getRisksRequiringAction(): TrackedRisk[] {
    return Array.from(this.risks.values()).filter(
      (r) =>
        r.status === "OPEN" &&
        (r.currentRisk.action === "MITIGATE" || r.currentRisk.action === "BLOCK"),
    );
  }

  /**
   * Generate risk trend report (show changes over time)
   */
  generateTrendReport(riskId: string): string | null {
    const risk = this.risks.get(riskId);
    if (!risk) return null;

    return `
# Risk Trend Report: ${risk.id}

**Title**: ${risk.title}
**Feature**: ${risk.feature}
**Status**: ${risk.status}

## Current Assessment
- **Probability**: ${risk.currentRisk.probability}
- **Impact**: ${risk.currentRisk.impact}
- **Score**: ${risk.currentRisk.score}
- **Action**: ${risk.currentRisk.action}
- **Reasoning**: ${risk.currentRisk.reasoning}

## Mitigations Applied
${risk.mitigations.length > 0 ? risk.mitigations.map((m) => `- ${m}`).join("\n") : "- None"}

## History (${risk.history.length} changes)
${risk.history
  .reverse()
  .map(
    (h) =>
      `- **${h.timestamp.toISOString()}** by ${h.changedBy}: Score ${h.assessment.score} (${h.assessment.action}) - ${h.reason}`,
  )
  .join("\n")}
`.trim();
  }
}
```

**Key Points**:

- Historical tracking (audit trail for risk changes)
- Mitigation impact tracking (probability reduction)
- Status lifecycle (OPEN → MITIGATED → RESOLVED)
- Trend reports (show risk evolution over time)
- Re-assessment triggers (requirements change, new info)

---

### Example 4: Risk Matrix in Gate Decision (Integration with Trace Workflow)

**Context**: Use probability-impact scores to drive gate decisions (PASS/CONCERNS/FAIL/WAIVED)

**Implementation**:

```typescript
// src/testing/gate-decision.ts
import { type RiskScore, classifyRiskAction, type RiskAction } from "./risk-matrix";
import { type TrackedRisk } from "./risk-tracking";

export type GateDecision = "PASS" | "CONCERNS" | "FAIL" | "WAIVED";

export type GateResult = {
  decision: GateDecision;
  blockers: TrackedRisk[]; // Score=9, action=BLOCK
  concerns: TrackedRisk[]; // Score 6-8, action=MITIGATE
  monitored: TrackedRisk[]; // Score 4-5, action=MONITOR
  documented: TrackedRisk[]; // Score 1-3, action=DOCUMENT
  summary: string;
};

/**
 * Evaluate gate based on risk assessments
 */
export function evaluateGateFromRisks(risks: TrackedRisk[]): GateResult {
  const blockers = risks.filter((r) => r.currentRisk.action === "BLOCK" && r.status === "OPEN");
  const concerns = risks.filter((r) => r.currentRisk.action === "MITIGATE" && r.status === "OPEN");
  const monitored = risks.filter((r) => r.currentRisk.action === "MONITOR");
  const documented = risks.filter((r) => r.currentRisk.action === "DOCUMENT");

  let decision: GateDecision;

  if (blockers.length > 0) {
    decision = "FAIL";
  } else if (concerns.length > 0) {
    decision = "CONCERNS";
  } else {
    decision = "PASS";
  }

  const summary = generateGateSummary({ decision, blockers, concerns, monitored, documented });

  return { decision, blockers, concerns, monitored, documented, summary };
}

/**
 * Generate gate decision summary
 */
function generateGateSummary(result: Omit<GateResult, "summary">): string {
  const { decision, blockers, concerns, monitored, documented } = result;

  const lines: string[] = [`## Gate Decision: ${decision}`];

  if (decision === "FAIL") {
    lines.push(`\n**Blockers** (${blockers.length}): Automatic FAIL until resolved or waived`);
    blockers.forEach((r) => {
      lines.push(`- **${r.id}**: ${r.title} (Score: ${r.currentRisk.score})`);
      lines.push(`  - Probability: ${r.currentRisk.probability}, Impact: ${r.currentRisk.impact}`);
      lines.push(`  - Reasoning: ${r.currentRisk.reasoning}`);
    });
  }

  if (concerns.length > 0) {
    lines.push(`\n**Concerns** (${concerns.length}): Address before release`);
    concerns.forEach((r) => {
      lines.push(`- **${r.id}**: ${r.title} (Score: ${r.currentRisk.score})`);
      lines.push(`  - Mitigations: ${r.mitigations.join(", ") || "None"}`);
    });
  }

  if (monitored.length > 0) {
    lines.push(`\n**Monitored** (${monitored.length}): Watch closely`);
    monitored.forEach((r) =>
      lines.push(`- **${r.id}**: ${r.title} (Score: ${r.currentRisk.score})`),
    );
  }

  if (documented.length > 0) {
    lines.push(`\n**Documented** (${documented.length}): Awareness only`);
  }

  lines.push(`\n---\n`);
  lines.push(`**Next Steps**:`);
  if (decision === "FAIL") {
    lines.push(`- Resolve blockers or request formal waiver`);
  } else if (decision === "CONCERNS") {
    lines.push(`- Implement mitigations for high-risk scenarios (score 6-8)`);
    lines.push(`- Re-run gate after mitigations`);
  } else {
    lines.push(`- Proceed with release`);
  }

  return lines.join("\n");
}
```

**Key Points**:

- Gate decision driven by risk scores (not gut feeling)
- Automatic FAIL for score=9 (blockers)
- CONCERNS for score 6-8 (requires mitigation)
- PASS only when no blockers/concerns
- Actionable summary with next steps
- Integration with trace workflow (Phase 2)

---

## Probability-Impact Threshold Summary

| Score | Action   | Gate Impact          | Typical Use Case                       |
| ----- | -------- | -------------------- | -------------------------------------- |
| 1-3   | DOCUMENT | None                 | Cosmetic issues, low-priority bugs     |
| 4-5   | MONITOR  | None (watch closely) | Edge cases, partial unknowns           |
| 6-8   | MITIGATE | CONCERNS at gate     | High-impact scenarios needing coverage |
| 9     | BLOCK    | Automatic FAIL       | Critical blockers, must resolve        |

## Risk Assessment Checklist

Before deploying risk matrix:

- [ ] **Probability scale defined**: 1 (unlikely), 2 (possible), 3 (likely) with clear examples
- [ ] **Impact scale defined**: 1 (minor), 2 (degraded), 3 (critical) with concrete criteria
- [ ] **Threshold rules documented**: Score → Action mapping (1-3 = DOCUMENT, 4-5 = MONITOR, 6-8 = MITIGATE, 9 = BLOCK)
- [ ] **Gate integration**: Risk scores drive gate decisions (PASS/CONCERNS/FAIL/WAIVED)
- [ ] **Re-assessment process**: Risks re-evaluated as project evolves (requirements change, mitigations applied)
- [ ] **Audit trail**: Historical tracking for risk changes (who, when, why)
- [ ] **Mitigation tracking**: Link mitigations to probability reduction (quantify impact)
- [ ] **Reporting**: Risk matrix visualization, trend reports, gate summaries

## Integration Points

- **Used in workflows**: `*test-design` (initial risk assessment), `*trace` (gate decision Phase 2), `*nfr-assess` (security/performance risks)
- **Related fragments**: `risk-governance.md` (risk scoring matrix, gate decision engine), `test-priorities-matrix.md` (P0-P3 mapping), `nfr-criteria.md` (impact assessment for NFRs)
- **Tools**: TypeScript for type safety, markdown for reports, version control for audit trail

_Source: Murat risk model summary, gate decision patterns from production systems, probability-impact matrix from risk governance practices_
