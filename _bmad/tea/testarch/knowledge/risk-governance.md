# Risk Governance and Gatekeeping

## Principle

Risk governance transforms subjective "should we ship?" debates into objective, data-driven decisions. By scoring risk (probability × impact), classifying by category (TECH, SEC, PERF, etc.), and tracking mitigation ownership, teams create transparent quality gates that balance speed with safety.

## Rationale

**The Problem**: Without formal risk governance, releases become political—loud voices win, quiet risks hide, and teams discover critical issues in production. "We thought it was fine" isn't a release strategy.

**The Solution**: Risk scoring (1-3 scale for probability and impact, total 1-9) creates shared language. Scores ≥6 demand documented mitigation. Scores = 9 mandate gate failure. Every acceptance criterion maps to a test, and gaps require explicit waivers with owners and expiry dates.

**Why This Matters**:

- Removes ambiguity from release decisions (objective scores vs subjective opinions)
- Creates audit trail for compliance (FDA, SOC2, ISO require documented risk management)
- Identifies true blockers early (prevents last-minute production fires)
- Distributes responsibility (owners, mitigation plans, deadlines for every risk >4)

## Pattern Examples

### Example 1: Risk Scoring Matrix with Automated Classification (TypeScript)

**Context**: Calculate risk scores automatically from test results and categorize by risk type

**Implementation**:

```typescript
// risk-scoring.ts - Risk classification and scoring system
export const RISK_CATEGORIES = {
  TECH: "TECH", // Technical debt, architecture fragility
  SEC: "SEC", // Security vulnerabilities
  PERF: "PERF", // Performance degradation
  DATA: "DATA", // Data integrity, corruption
  BUS: "BUS", // Business logic errors
  OPS: "OPS", // Operational issues (deployment, monitoring)
} as const;

export type RiskCategory = keyof typeof RISK_CATEGORIES;

export type RiskScore = {
  id: string;
  category: RiskCategory;
  title: string;
  description: string;
  probability: 1 | 2 | 3; // 1=Low, 2=Medium, 3=High
  impact: 1 | 2 | 3; // 1=Low, 2=Medium, 3=High
  score: number; // probability × impact (1-9)
  owner: string;
  mitigationPlan?: string;
  deadline?: Date;
  status: "OPEN" | "MITIGATED" | "WAIVED" | "ACCEPTED";
  waiverReason?: string;
  waiverApprover?: string;
  waiverExpiry?: Date;
};

// Risk scoring rules
export function calculateRiskScore(probability: 1 | 2 | 3, impact: 1 | 2 | 3): number {
  return probability * impact;
}

export function requiresMitigation(score: number): boolean {
  return score >= 6; // Scores 6-9 demand action
}

export function isCriticalBlocker(score: number): boolean {
  return score === 9; // Probability=3 AND Impact=3 → FAIL gate
}

export function classifyRiskLevel(score: number): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  if (score === 9) return "CRITICAL";
  if (score >= 6) return "HIGH";
  if (score >= 4) return "MEDIUM";
  return "LOW";
}

// Example: Risk assessment from test failures
export function assessTestFailureRisk(failure: {
  test: string;
  category: RiskCategory;
  affectedUsers: number;
  revenueImpact: number;
  securityVulnerability: boolean;
}): RiskScore {
  // Probability based on test failure frequency (simplified)
  const probability: 1 | 2 | 3 = 3; // Test failed = High probability

  // Impact based on business context
  let impact: 1 | 2 | 3 = 1;
  if (failure.securityVulnerability) impact = 3;
  else if (failure.revenueImpact > 10000) impact = 3;
  else if (failure.affectedUsers > 1000) impact = 2;
  else impact = 1;

  const score = calculateRiskScore(probability, impact);

  return {
    id: `risk-${Date.now()}`,
    category: failure.category,
    title: `Test failure: ${failure.test}`,
    description: `Affects ${failure.affectedUsers} users, $${failure.revenueImpact} revenue`,
    probability,
    impact,
    score,
    owner: "unassigned",
    status: score === 9 ? "OPEN" : "OPEN",
  };
}
```

**Key Points**:

- **Objective scoring**: Probability (1-3) × Impact (1-3) = Score (1-9)
- **Clear thresholds**: Score ≥6 requires mitigation, score = 9 blocks release
- **Business context**: Revenue, users, security drive impact calculation
- **Status tracking**: OPEN → MITIGATED → WAIVED → ACCEPTED lifecycle

---

### Example 2: Gate Decision Engine with Traceability Validation

**Context**: Automated gate decision based on risk scores and test coverage

**Implementation**:

```typescript
// gate-decision-engine.ts
export type GateDecision = "PASS" | "CONCERNS" | "FAIL" | "WAIVED";

export type CoverageGap = {
  acceptanceCriteria: string;
  testMissing: string;
  reason: string;
};

export type GateResult = {
  decision: GateDecision;
  timestamp: Date;
  criticalRisks: RiskScore[];
  highRisks: RiskScore[];
  coverageGaps: CoverageGap[];
  summary: string;
  recommendations: string[];
};

export function evaluateGate(params: {
  risks: RiskScore[];
  coverageGaps: CoverageGap[];
  waiverApprover?: string;
}): GateResult {
  const { risks, coverageGaps, waiverApprover } = params;

  // Categorize risks
  const criticalRisks = risks.filter((r) => r.score === 9 && r.status === "OPEN");
  const highRisks = risks.filter((r) => r.score >= 6 && r.score < 9 && r.status === "OPEN");
  const unresolvedGaps = coverageGaps.filter((g) => !g.reason);

  // Decision logic
  let decision: GateDecision;

  // FAIL: Critical blockers (score=9) or missing coverage
  if (criticalRisks.length > 0 || unresolvedGaps.length > 0) {
    decision = "FAIL";
  }
  // WAIVED: All risks waived by authorized approver
  else if (risks.every((r) => r.status === "WAIVED") && waiverApprover) {
    decision = "WAIVED";
  }
  // CONCERNS: High risks (score 6-8) with mitigation plans
  else if (
    highRisks.length > 0 &&
    highRisks.every((r) => r.mitigationPlan && r.owner !== "unassigned")
  ) {
    decision = "CONCERNS";
  }
  // PASS: No critical issues, all risks mitigated or low
  else {
    decision = "PASS";
  }

  // Generate recommendations
  const recommendations: string[] = [];
  if (criticalRisks.length > 0) {
    recommendations.push(
      `🚨 ${criticalRisks.length} CRITICAL risk(s) must be mitigated before release`,
    );
  }
  if (unresolvedGaps.length > 0) {
    recommendations.push(`📋 ${unresolvedGaps.length} acceptance criteria lack test coverage`);
  }
  if (highRisks.some((r) => !r.mitigationPlan)) {
    recommendations.push(`⚠️  High risks without mitigation plans: assign owners and deadlines`);
  }
  if (decision === "PASS") {
    recommendations.push(`✅ All risks mitigated or acceptable. Ready for release.`);
  }

  return {
    decision,
    timestamp: new Date(),
    criticalRisks,
    highRisks,
    coverageGaps: unresolvedGaps,
    summary: generateSummary(decision, risks, unresolvedGaps),
    recommendations,
  };
}

function generateSummary(decision: GateDecision, risks: RiskScore[], gaps: CoverageGap[]): string {
  const total = risks.length;
  const critical = risks.filter((r) => r.score === 9).length;
  const high = risks.filter((r) => r.score >= 6 && r.score < 9).length;

  return `Gate Decision: ${decision}. Total Risks: ${total} (${critical} critical, ${high} high). Coverage Gaps: ${gaps.length}.`;
}
```

**Usage Example**:

```typescript
// Example: Running gate check before deployment
import { assessTestFailureRisk, evaluateGate } from "./gate-decision-engine";

// Collect risks from test results
const risks: RiskScore[] = [
  assessTestFailureRisk({
    test: "Payment processing with expired card",
    category: "BUS",
    affectedUsers: 5000,
    revenueImpact: 50000,
    securityVulnerability: false,
  }),
  assessTestFailureRisk({
    test: "SQL injection in search endpoint",
    category: "SEC",
    affectedUsers: 10000,
    revenueImpact: 0,
    securityVulnerability: true,
  }),
];

// Identify coverage gaps
const coverageGaps: CoverageGap[] = [
  {
    acceptanceCriteria: "User can reset password via email",
    testMissing: "e2e/auth/password-reset.spec.ts",
    reason: "", // Empty = unresolved
  },
];

// Evaluate gate
const gateResult = evaluateGate({ risks, coverageGaps });

console.log(gateResult.decision); // 'FAIL'
console.log(gateResult.summary);
// "Gate Decision: FAIL. Total Risks: 2 (1 critical, 1 high). Coverage Gaps: 1."

console.log(gateResult.recommendations);
// [
//   "🚨 1 CRITICAL risk(s) must be mitigated before release",
//   "📋 1 acceptance criteria lack test coverage"
// ]
```

**Key Points**:

- **Automated decision**: No human interpretation required
- **Clear criteria**: FAIL = critical risks or gaps, CONCERNS = high risks with plans, PASS = low risks
- **Actionable output**: Recommendations drive next steps
- **Audit trail**: Timestamp, decision, and context for compliance

---

### Example 3: Risk Mitigation Workflow with Owner Tracking

**Context**: Track risk mitigation from identification to resolution

**Implementation**:

```typescript
// risk-mitigation.ts
export type MitigationAction = {
  riskId: string;
  action: string;
  owner: string;
  deadline: Date;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "BLOCKED";
  completedAt?: Date;
  blockedReason?: string;
};

export class RiskMitigationTracker {
  private risks: Map<string, RiskScore> = new Map();
  private actions: Map<string, MitigationAction[]> = new Map();
  private history: Array<{ riskId: string; event: string; timestamp: Date }> = [];

  // Register a new risk
  addRisk(risk: RiskScore): void {
    this.risks.set(risk.id, risk);
    this.logHistory(risk.id, `Risk registered: ${risk.title} (Score: ${risk.score})`);

    // Auto-assign mitigation requirements for score ≥6
    if (requiresMitigation(risk.score) && !risk.mitigationPlan) {
      this.logHistory(
        risk.id,
        `⚠️  Mitigation required (score ${risk.score}). Assign owner and plan.`,
      );
    }
  }

  // Add mitigation action
  addMitigationAction(action: MitigationAction): void {
    const risk = this.risks.get(action.riskId);
    if (!risk) throw new Error(`Risk ${action.riskId} not found`);

    const existingActions = this.actions.get(action.riskId) || [];
    existingActions.push(action);
    this.actions.set(action.riskId, existingActions);

    this.logHistory(
      action.riskId,
      `Mitigation action added: ${action.action} (Owner: ${action.owner})`,
    );
  }

  // Complete mitigation action
  completeMitigation(riskId: string, actionIndex: number): void {
    const actions = this.actions.get(riskId);
    if (!actions || !actions[actionIndex]) throw new Error("Action not found");

    actions[actionIndex].status = "COMPLETED";
    actions[actionIndex].completedAt = new Date();

    this.logHistory(riskId, `Mitigation completed: ${actions[actionIndex].action}`);

    // If all actions completed, mark risk as MITIGATED
    if (actions.every((a) => a.status === "COMPLETED")) {
      const risk = this.risks.get(riskId)!;
      risk.status = "MITIGATED";
      this.logHistory(riskId, `✅ Risk mitigated. All actions complete.`);
    }
  }

  // Request waiver for a risk
  requestWaiver(riskId: string, reason: string, approver: string, expiryDays: number): void {
    const risk = this.risks.get(riskId);
    if (!risk) throw new Error(`Risk ${riskId} not found`);

    risk.status = "WAIVED";
    risk.waiverReason = reason;
    risk.waiverApprover = approver;
    risk.waiverExpiry = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

    this.logHistory(riskId, `⚠️  Waiver granted by ${approver}. Expires: ${risk.waiverExpiry}`);
  }

  // Generate risk report
  generateReport(): string {
    const allRisks = Array.from(this.risks.values());
    const critical = allRisks.filter((r) => r.score === 9 && r.status === "OPEN");
    const high = allRisks.filter((r) => r.score >= 6 && r.score < 9 && r.status === "OPEN");
    const mitigated = allRisks.filter((r) => r.status === "MITIGATED");
    const waived = allRisks.filter((r) => r.status === "WAIVED");

    let report = `# Risk Mitigation Report\n\n`;
    report += `**Generated**: ${new Date().toISOString()}\n\n`;
    report += `## Summary\n`;
    report += `- Total Risks: ${allRisks.length}\n`;
    report += `- Critical (Score=9, OPEN): ${critical.length}\n`;
    report += `- High (Score 6-8, OPEN): ${high.length}\n`;
    report += `- Mitigated: ${mitigated.length}\n`;
    report += `- Waived: ${waived.length}\n\n`;

    if (critical.length > 0) {
      report += `## 🚨 Critical Risks (BLOCKERS)\n\n`;
      critical.forEach((r) => {
        report += `- **${r.title}** (${r.category})\n`;
        report += `  - Score: ${r.score} (Probability: ${r.probability}, Impact: ${r.impact})\n`;
        report += `  - Owner: ${r.owner}\n`;
        report += `  - Mitigation: ${r.mitigationPlan || "NOT ASSIGNED"}\n\n`;
      });
    }

    if (high.length > 0) {
      report += `## ⚠️  High Risks\n\n`;
      high.forEach((r) => {
        report += `- **${r.title}** (${r.category})\n`;
        report += `  - Score: ${r.score}\n`;
        report += `  - Owner: ${r.owner}\n`;
        report += `  - Deadline: ${r.deadline?.toISOString().split("T")[0] || "NOT SET"}\n\n`;
      });
    }

    return report;
  }

  private logHistory(riskId: string, event: string): void {
    this.history.push({ riskId, event, timestamp: new Date() });
  }

  getHistory(riskId: string): Array<{ event: string; timestamp: Date }> {
    return this.history
      .filter((h) => h.riskId === riskId)
      .map((h) => ({ event: h.event, timestamp: h.timestamp }));
  }
}
```

**Usage Example**:

```typescript
const tracker = new RiskMitigationTracker();

// Register critical security risk
tracker.addRisk({
  id: "risk-001",
  category: "SEC",
  title: "SQL injection vulnerability in user search",
  description: "Unsanitized input allows arbitrary SQL execution",
  probability: 3,
  impact: 3,
  score: 9,
  owner: "security-team",
  status: "OPEN",
});

// Add mitigation actions
tracker.addMitigationAction({
  riskId: "risk-001",
  action: "Add parameterized queries to user-search endpoint",
  owner: "alice@example.com",
  deadline: new Date("2025-10-20"),
  status: "IN_PROGRESS",
});

tracker.addMitigationAction({
  riskId: "risk-001",
  action: "Add WAF rule to block SQL injection patterns",
  owner: "bob@example.com",
  deadline: new Date("2025-10-22"),
  status: "PENDING",
});

// Complete first action
tracker.completeMitigation("risk-001", 0);

// Generate report
console.log(tracker.generateReport());
// Markdown report with critical risks, owners, deadlines

// View history
console.log(tracker.getHistory("risk-001"));
// [
//   { event: 'Risk registered: SQL injection...', timestamp: ... },
//   { event: 'Mitigation action added: Add parameterized queries...', timestamp: ... },
//   { event: 'Mitigation completed: Add parameterized queries...', timestamp: ... }
// ]
```

**Key Points**:

- **Ownership enforcement**: Every risk >4 requires owner assignment
- **Deadline tracking**: Mitigation actions have explicit deadlines
- **Audit trail**: Complete history of risk lifecycle (registered → mitigated)
- **Automated reports**: Markdown output for Confluence/GitHub wikis

---

### Example 4: Coverage Traceability Matrix (Test-to-Requirement Mapping)

**Context**: Validate that every acceptance criterion maps to at least one test

**Implementation**:

```typescript
// coverage-traceability.ts
export type AcceptanceCriterion = {
  id: string;
  story: string;
  criterion: string;
  priority: "P0" | "P1" | "P2" | "P3";
};

export type TestCase = {
  file: string;
  name: string;
  criteriaIds: string[]; // Links to acceptance criteria
};

export type CoverageMatrix = {
  criterion: AcceptanceCriterion;
  tests: TestCase[];
  covered: boolean;
  waiverReason?: string;
};

export function buildCoverageMatrix(
  criteria: AcceptanceCriterion[],
  tests: TestCase[],
): CoverageMatrix[] {
  return criteria.map((criterion) => {
    const matchingTests = tests.filter((t) => t.criteriaIds.includes(criterion.id));

    return {
      criterion,
      tests: matchingTests,
      covered: matchingTests.length > 0,
    };
  });
}

export function validateCoverage(matrix: CoverageMatrix[]): {
  gaps: CoverageMatrix[];
  passRate: number;
} {
  const gaps = matrix.filter((m) => !m.covered && !m.waiverReason);
  const passRate = ((matrix.length - gaps.length) / matrix.length) * 100;

  return { gaps, passRate };
}

// Example: Extract criteria IDs from test names
export function extractCriteriaFromTests(testFiles: string[]): TestCase[] {
  // Simplified: In real implementation, parse test files with AST
  // Here we simulate extraction from test names
  return [
    {
      file: "tests/e2e/auth/login.spec.ts",
      name: "should allow user to login with valid credentials",
      criteriaIds: ["AC-001", "AC-002"], // Linked to acceptance criteria
    },
    {
      file: "tests/e2e/auth/password-reset.spec.ts",
      name: "should send password reset email",
      criteriaIds: ["AC-003"],
    },
  ];
}

// Generate Markdown traceability report
export function generateTraceabilityReport(matrix: CoverageMatrix[]): string {
  let report = `# Requirements-to-Tests Traceability Matrix\n\n`;
  report += `**Generated**: ${new Date().toISOString()}\n\n`;

  const { gaps, passRate } = validateCoverage(matrix);

  report += `## Summary\n`;
  report += `- Total Criteria: ${matrix.length}\n`;
  report += `- Covered: ${matrix.filter((m) => m.covered).length}\n`;
  report += `- Gaps: ${gaps.length}\n`;
  report += `- Waived: ${matrix.filter((m) => m.waiverReason).length}\n`;
  report += `- Coverage Rate: ${passRate.toFixed(1)}%\n\n`;

  if (gaps.length > 0) {
    report += `## ❌ Coverage Gaps (MUST RESOLVE)\n\n`;
    report += `| Story | Criterion | Priority | Tests |\n`;
    report += `|-------|-----------|----------|-------|\n`;
    gaps.forEach((m) => {
      report += `| ${m.criterion.story} | ${m.criterion.criterion} | ${m.criterion.priority} | None |\n`;
    });
    report += `\n`;
  }

  report += `## ✅ Covered Criteria\n\n`;
  report += `| Story | Criterion | Tests |\n`;
  report += `|-------|-----------|-------|\n`;
  matrix
    .filter((m) => m.covered)
    .forEach((m) => {
      const testList = m.tests.map((t) => `\`${t.file}\``).join(", ");
      report += `| ${m.criterion.story} | ${m.criterion.criterion} | ${testList} |\n`;
    });

  return report;
}
```

**Usage Example**:

```typescript
// Define acceptance criteria
const criteria: AcceptanceCriterion[] = [
  { id: "AC-001", story: "US-123", criterion: "User can login with email", priority: "P0" },
  {
    id: "AC-002",
    story: "US-123",
    criterion: "User sees error on invalid password",
    priority: "P0",
  },
  {
    id: "AC-003",
    story: "US-124",
    criterion: "User receives password reset email",
    priority: "P1",
  },
  { id: "AC-004", story: "US-125", criterion: "User can update profile", priority: "P2" }, // NO TEST
];

// Extract tests
const tests: TestCase[] = extractCriteriaFromTests([
  "tests/e2e/auth/login.spec.ts",
  "tests/e2e/auth/password-reset.spec.ts",
]);

// Build matrix
const matrix = buildCoverageMatrix(criteria, tests);

// Validate
const { gaps, passRate } = validateCoverage(matrix);
console.log(`Coverage: ${passRate.toFixed(1)}%`); // "Coverage: 75.0%"
console.log(`Gaps: ${gaps.length}`); // "Gaps: 1" (AC-004 has no test)

// Generate report
const report = generateTraceabilityReport(matrix);
console.log(report);
// Markdown table showing coverage gaps
```

**Key Points**:

- **Bidirectional traceability**: Criteria → Tests and Tests → Criteria
- **Gap detection**: Automatically identifies missing coverage
- **Priority awareness**: P0 gaps are critical blockers
- **Waiver support**: Allow explicit waivers for low-priority gaps

---

## Risk Governance Checklist

Before deploying to production, ensure:

- [ ] **Risk scoring complete**: All identified risks scored (Probability × Impact)
- [ ] **Ownership assigned**: Every risk >4 has owner, mitigation plan, deadline
- [ ] **Coverage validated**: Every acceptance criterion maps to at least one test
- [ ] **Gate decision documented**: PASS/CONCERNS/FAIL/WAIVED with rationale
- [ ] **Waivers approved**: All waivers have approver, reason, expiry date
- [ ] **Audit trail captured**: Risk history log available for compliance review
- [ ] **Traceability matrix**: Requirements-to-tests mapping up to date
- [ ] **Critical risks resolved**: No score=9 risks in OPEN status

## Integration Points

- **Used in workflows**: `*trace` (Phase 2: gate decision), `*nfr-assess` (risk scoring), `*test-design` (risk identification)
- **Related fragments**: `probability-impact.md` (scoring definitions), `test-priorities-matrix.md` (P0-P3 classification), `nfr-criteria.md` (non-functional risks)
- **Tools**: Risk tracking dashboards (Jira, Linear), gate automation (CI/CD), traceability reports (Markdown, Confluence)

_Source: Murat risk governance notes, gate schema guidance, SEON production gate workflows, ISO 31000 risk management standards_
