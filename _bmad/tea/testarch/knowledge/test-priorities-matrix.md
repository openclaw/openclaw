<!-- Powered by BMAD-CORE™ -->

# Test Priorities Matrix

Guide for prioritizing test scenarios based on risk, criticality, and business impact.

## Priority Levels

### P0 - Critical (Must Test)

**Criteria:**

- Revenue-impacting functionality
- Security-critical paths
- Data integrity operations
- Regulatory compliance requirements
- Previously broken functionality (regression prevention)

**Examples:**

- Payment processing
- Authentication/authorization
- User data creation/deletion
- Financial calculations
- GDPR/privacy compliance

**Testing Requirements:**

- Comprehensive coverage at all levels
- Both happy and unhappy paths
- Edge cases and error scenarios
- Performance under load

### P1 - High (Should Test)

**Criteria:**

- Core user journeys
- Frequently used features
- Features with complex logic
- Integration points between systems
- Features affecting user experience

**Examples:**

- User registration flow
- Search functionality
- Data import/export
- Notification systems
- Dashboard displays

**Testing Requirements:**

- Primary happy paths required
- Key error scenarios
- Critical edge cases
- Basic performance validation

### P2 - Medium (Nice to Test)

**Criteria:**

- Secondary features
- Admin functionality
- Reporting features
- Configuration options
- UI polish and aesthetics

**Examples:**

- Admin settings panels
- Report generation
- Theme customization
- Help documentation
- Analytics tracking

**Testing Requirements:**

- Happy path coverage
- Basic error handling
- Can defer edge cases

### P3 - Low (Test if Time Permits)

**Criteria:**

- Rarely used features
- Nice-to-have functionality
- Cosmetic issues
- Non-critical optimizations

**Examples:**

- Advanced preferences
- Legacy feature support
- Experimental features
- Debug utilities

**Testing Requirements:**

- Smoke tests only
- Can rely on manual testing
- Document known limitations

## Risk-Based Priority Adjustments

### Increase Priority When:

- High user impact (affects >50% of users)
- High financial impact (>$10K potential loss)
- Security vulnerability potential
- Compliance/legal requirements
- Customer-reported issues
- Complex implementation (>500 LOC)
- Multiple system dependencies

### Decrease Priority When:

- Feature flag protected
- Gradual rollout planned
- Strong monitoring in place
- Easy rollback capability
- Low usage metrics
- Simple implementation
- Well-isolated component

## Test Coverage by Priority

| Priority | Unit Coverage | Integration Coverage | E2E Coverage       |
| -------- | ------------- | -------------------- | ------------------ |
| P0       | >90%          | >80%                 | All critical paths |
| P1       | >80%          | >60%                 | Main happy paths   |
| P2       | >60%          | >40%                 | Smoke tests        |
| P3       | Best effort   | Best effort          | Manual only        |

## Priority Assignment Rules

1. **Start with business impact** - What happens if this fails?
2. **Consider probability** - How likely is failure?
3. **Factor in detectability** - Would we know if it failed?
4. **Account for recoverability** - Can we fix it quickly?

## Priority Decision Tree

```
Is it revenue-critical?
├─ YES → P0
└─ NO → Does it affect core user journey?
    ├─ YES → Is it high-risk?
    │   ├─ YES → P0
    │   └─ NO → P1
    └─ NO → Is it frequently used?
        ├─ YES → P1
        └─ NO → Is it customer-facing?
            ├─ YES → P2
            └─ NO → P3
```

## Test Execution Order

1. Execute P0 tests first (fail fast on critical issues)
2. Execute P1 tests second (core functionality)
3. Execute P2 tests if time permits
4. P3 tests only in full regression cycles

## Continuous Adjustment

Review and adjust priorities based on:

- Production incident patterns
- User feedback and complaints
- Usage analytics
- Test failure history
- Business priority changes

---

## Automated Priority Classification

### Example: Priority Calculator (Risk-Based Automation)

```typescript
// src/testing/priority-calculator.ts

export type Priority = "P0" | "P1" | "P2" | "P3";

export type PriorityFactors = {
  revenueImpact: "critical" | "high" | "medium" | "low" | "none";
  userImpact: "all" | "majority" | "some" | "few" | "minimal";
  securityRisk: boolean;
  complianceRequired: boolean;
  previousFailure: boolean;
  complexity: "high" | "medium" | "low";
  usage: "frequent" | "regular" | "occasional" | "rare";
};

/**
 * Calculate test priority based on multiple factors
 * Mirrors the priority decision tree with objective criteria
 */
export function calculatePriority(factors: PriorityFactors): Priority {
  const {
    revenueImpact,
    userImpact,
    securityRisk,
    complianceRequired,
    previousFailure,
    complexity,
    usage,
  } = factors;

  // P0: Revenue-critical, security, or compliance
  if (
    revenueImpact === "critical" ||
    securityRisk ||
    complianceRequired ||
    (previousFailure && revenueImpact === "high")
  ) {
    return "P0";
  }

  // P0: High revenue + high complexity + frequent usage
  if (revenueImpact === "high" && complexity === "high" && usage === "frequent") {
    return "P0";
  }

  // P1: Core user journey (majority impacted + frequent usage)
  if (userImpact === "all" || userImpact === "majority") {
    if (usage === "frequent" || complexity === "high") {
      return "P1";
    }
  }

  // P1: High revenue OR high complexity with regular usage
  if (
    (revenueImpact === "high" && usage === "regular") ||
    (complexity === "high" && usage === "frequent")
  ) {
    return "P1";
  }

  // P2: Secondary features (some impact, occasional usage)
  if (userImpact === "some" || usage === "occasional") {
    return "P2";
  }

  // P3: Rarely used, low impact
  return "P3";
}

/**
 * Generate priority justification (for audit trail)
 */
export function justifyPriority(factors: PriorityFactors): string {
  const priority = calculatePriority(factors);
  const reasons: string[] = [];

  if (factors.revenueImpact === "critical") reasons.push("critical revenue impact");
  if (factors.securityRisk) reasons.push("security-critical");
  if (factors.complianceRequired) reasons.push("compliance requirement");
  if (factors.previousFailure) reasons.push("regression prevention");
  if (factors.userImpact === "all" || factors.userImpact === "majority") {
    reasons.push(`impacts ${factors.userImpact} users`);
  }
  if (factors.complexity === "high") reasons.push("high complexity");
  if (factors.usage === "frequent") reasons.push("frequently used");

  return `${priority}: ${reasons.join(", ")}`;
}

/**
 * Example: Payment scenario priority calculation
 */
const paymentScenario: PriorityFactors = {
  revenueImpact: "critical",
  userImpact: "all",
  securityRisk: true,
  complianceRequired: true,
  previousFailure: false,
  complexity: "high",
  usage: "frequent",
};

console.log(calculatePriority(paymentScenario)); // 'P0'
console.log(justifyPriority(paymentScenario));
// 'P0: critical revenue impact, security-critical, compliance requirement, impacts all users, high complexity, frequently used'
```

### Example: Test Suite Tagging Strategy

```typescript
// tests/e2e/checkout.spec.ts
import { test, expect } from "@playwright/test";

// Tag tests with priority for selective execution
test.describe("Checkout Flow", () => {
  test("valid payment completes successfully @p0 @smoke @revenue", async ({ page }) => {
    // P0: Revenue-critical happy path
    await page.goto("/checkout");
    await page.getByTestId("payment-method").selectOption("credit-card");
    await page.getByTestId("card-number").fill("4242424242424242");
    await page.getByRole("button", { name: "Place Order" }).click();

    await expect(page.getByText("Order confirmed")).toBeVisible();
  });

  test("expired card shows user-friendly error @p1 @error-handling", async ({ page }) => {
    // P1: Core error scenario (frequent user impact)
    await page.goto("/checkout");
    await page.getByTestId("payment-method").selectOption("credit-card");
    await page.getByTestId("card-number").fill("4000000000000069"); // Test card: expired
    await page.getByRole("button", { name: "Place Order" }).click();

    await expect(page.getByText("Card expired. Please use a different card.")).toBeVisible();
  });

  test("coupon code applies discount correctly @p2", async ({ page }) => {
    // P2: Secondary feature (nice-to-have)
    await page.goto("/checkout");
    await page.getByTestId("coupon-code").fill("SAVE10");
    await page.getByRole("button", { name: "Apply" }).click();

    await expect(page.getByText("10% discount applied")).toBeVisible();
  });

  test("gift message formatting preserved @p3", async ({ page }) => {
    // P3: Cosmetic feature (rarely used)
    await page.goto("/checkout");
    await page.getByTestId("gift-message").fill("Happy Birthday!\n\nWith love.");
    await page.getByRole("button", { name: "Place Order" }).click();

    // Message formatting preserved (linebreaks intact)
    await expect(page.getByTestId("order-summary")).toContainText("Happy Birthday!");
  });
});
```

**Run tests by priority:**

```bash
# P0 only (smoke tests, 2-5 min)
npx playwright test --grep @p0

# P0 + P1 (core functionality, 10-15 min)
npx playwright test --grep "@p0|@p1"

# Full regression (all priorities, 30+ min)
npx playwright test
```

---

## Integration with Risk Scoring

Priority should align with risk score from `probability-impact.md`:

| Risk Score | Typical Priority | Rationale                                  |
| ---------- | ---------------- | ------------------------------------------ |
| 9          | P0               | Critical blocker (probability=3, impact=3) |
| 6-8        | P0 or P1         | High risk (requires mitigation)            |
| 4-5        | P1 or P2         | Medium risk (monitor closely)              |
| 1-3        | P2 or P3         | Low risk (document and defer)              |

**Example**: Risk score 9 (checkout API failure) → P0 priority → comprehensive coverage required.

---

## Priority Checklist

Before finalizing test priorities:

- [ ] **Revenue impact assessed**: Payment, subscription, billing features → P0
- [ ] **Security risks identified**: Auth, data exposure, injection attacks → P0
- [ ] **Compliance requirements documented**: GDPR, PCI-DSS, SOC2 → P0
- [ ] **User impact quantified**: >50% users → P0/P1, <10% → P2/P3
- [ ] **Previous failures reviewed**: Regression prevention → increase priority
- [ ] **Complexity evaluated**: >500 LOC or multiple dependencies → increase priority
- [ ] **Usage metrics consulted**: Frequent use → P0/P1, rare use → P2/P3
- [ ] **Monitoring coverage confirmed**: Strong monitoring → can decrease priority
- [ ] **Rollback capability verified**: Easy rollback → can decrease priority
- [ ] **Priorities tagged in tests**: @p0, @p1, @p2, @p3 for selective execution

## Integration Points

- **Used in workflows**: `*automate` (priority-based test generation), `*test-design` (scenario prioritization), `*trace` (coverage validation by priority)
- **Related fragments**: `risk-governance.md` (risk scoring), `probability-impact.md` (impact assessment), `selective-testing.md` (tag-based execution)
- **Tools**: Playwright/Cypress grep for tag filtering, CI scripts for priority-based execution

_Source: Risk-based testing practices, test prioritization strategies, production incident analysis_
