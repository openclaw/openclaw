# Feature Flag Governance

## Principle

Feature flags enable controlled rollouts and A/B testing, but require disciplined testing governance. Centralize flag definitions in a frozen enum, test both enabled and disabled states, clean up targeting after each spec, and maintain a comprehensive flag lifecycle checklist. For LaunchDarkly-style systems, script API helpers to seed variations programmatically rather than manual UI mutations.

## Rationale

Poorly managed feature flags become technical debt: untested variations ship broken code, forgotten flags clutter the codebase, and shared environments become unstable from leftover targeting rules. Structured governance ensures flags are testable, traceable, temporary, and safe. Testing both states prevents surprises when flags flip in production.

## Pattern Examples

### Example 1: Feature Flag Enum Pattern with Type Safety

**Context**: Centralized flag management with TypeScript type safety and runtime validation.

**Implementation**:

```typescript
// src/utils/feature-flags.ts
/**
 * Centralized feature flag definitions
 * - Object.freeze prevents runtime modifications
 * - TypeScript ensures compile-time type safety
 * - Single source of truth for all flag keys
 */
export const FLAGS = Object.freeze({
  // User-facing features
  NEW_CHECKOUT_FLOW: "new-checkout-flow",
  DARK_MODE: "dark-mode",
  ENHANCED_SEARCH: "enhanced-search",

  // Experiments
  PRICING_EXPERIMENT_A: "pricing-experiment-a",
  HOMEPAGE_VARIANT_B: "homepage-variant-b",

  // Infrastructure
  USE_NEW_API_ENDPOINT: "use-new-api-endpoint",
  ENABLE_ANALYTICS_V2: "enable-analytics-v2",

  // Killswitches (emergency disables)
  DISABLE_PAYMENT_PROCESSING: "disable-payment-processing",
  DISABLE_EMAIL_NOTIFICATIONS: "disable-email-notifications",
} as const);

/**
 * Type-safe flag keys
 * Prevents typos and ensures autocomplete in IDEs
 */
export type FlagKey = (typeof FLAGS)[keyof typeof FLAGS];

/**
 * Flag metadata for governance
 */
type FlagMetadata = {
  key: FlagKey;
  name: string;
  owner: string;
  createdDate: string;
  expiryDate?: string;
  defaultState: boolean;
  requiresCleanup: boolean;
  dependencies?: FlagKey[];
  telemetryEvents?: string[];
};

/**
 * Flag registry with governance metadata
 * Used for flag lifecycle tracking and cleanup alerts
 */
export const FLAG_REGISTRY: Record<FlagKey, FlagMetadata> = {
  [FLAGS.NEW_CHECKOUT_FLOW]: {
    key: FLAGS.NEW_CHECKOUT_FLOW,
    name: "New Checkout Flow",
    owner: "payments-team",
    createdDate: "2025-01-15",
    expiryDate: "2025-03-15",
    defaultState: false,
    requiresCleanup: true,
    dependencies: [FLAGS.USE_NEW_API_ENDPOINT],
    telemetryEvents: ["checkout_started", "checkout_completed"],
  },
  [FLAGS.DARK_MODE]: {
    key: FLAGS.DARK_MODE,
    name: "Dark Mode UI",
    owner: "frontend-team",
    createdDate: "2025-01-10",
    defaultState: false,
    requiresCleanup: false, // Permanent feature toggle
  },
  // ... rest of registry
};

/**
 * Validate flag exists in registry
 * Throws at runtime if flag is unregistered
 */
export function validateFlag(flag: string): asserts flag is FlagKey {
  if (!Object.values(FLAGS).includes(flag as FlagKey)) {
    throw new Error(`Unregistered feature flag: ${flag}`);
  }
}

/**
 * Check if flag is expired (needs removal)
 */
export function isFlagExpired(flag: FlagKey): boolean {
  const metadata = FLAG_REGISTRY[flag];
  if (!metadata.expiryDate) return false;

  const expiry = new Date(metadata.expiryDate);
  return Date.now() > expiry.getTime();
}

/**
 * Get all expired flags requiring cleanup
 */
export function getExpiredFlags(): FlagMetadata[] {
  return Object.values(FLAG_REGISTRY).filter((meta) => isFlagExpired(meta.key));
}
```

**Usage in application code**:

```typescript
// components/Checkout.tsx
import { FLAGS } from '@/utils/feature-flags';
import { useFeatureFlag } from '@/hooks/useFeatureFlag';

export function Checkout() {
  const isNewFlow = useFeatureFlag(FLAGS.NEW_CHECKOUT_FLOW);

  return isNewFlow ? <NewCheckoutFlow /> : <LegacyCheckoutFlow />;
}
```

**Key Points**:

- **Type safety**: TypeScript catches typos at compile time
- **Runtime validation**: validateFlag ensures only registered flags used
- **Metadata tracking**: Owner, dates, dependencies documented
- **Expiry alerts**: Automated detection of stale flags
- **Single source of truth**: All flags defined in one place

---

### Example 2: Feature Flag Testing Pattern (Both States)

**Context**: Comprehensive testing of feature flag variations with proper cleanup.

**Implementation**:

```typescript
// tests/e2e/checkout-feature-flag.spec.ts
import { test, expect } from "@playwright/test";
import { FLAGS } from "@/utils/feature-flags";

/**
 * Feature Flag Testing Strategy:
 * 1. Test BOTH enabled and disabled states
 * 2. Clean up targeting after each test
 * 3. Use dedicated test users (not production data)
 * 4. Verify telemetry events fire correctly
 */

test.describe("Checkout Flow - Feature Flag Variations", () => {
  let testUserId: string;

  test.beforeEach(async () => {
    // Generate unique test user ID
    testUserId = `test-user-${Date.now()}`;
  });

  test.afterEach(async ({ request }) => {
    // CRITICAL: Clean up flag targeting to prevent shared env pollution
    await request.post("/api/feature-flags/cleanup", {
      data: {
        flagKey: FLAGS.NEW_CHECKOUT_FLOW,
        userId: testUserId,
      },
    });
  });

  test("should use NEW checkout flow when flag is ENABLED", async ({ page, request }) => {
    // Arrange: Enable flag for test user
    await request.post("/api/feature-flags/target", {
      data: {
        flagKey: FLAGS.NEW_CHECKOUT_FLOW,
        userId: testUserId,
        variation: true, // ENABLED
      },
    });

    // Act: Navigate as targeted user
    await page.goto("/checkout", {
      extraHTTPHeaders: {
        "X-Test-User-ID": testUserId,
      },
    });

    // Assert: New flow UI elements visible
    await expect(page.getByTestId("checkout-v2-container")).toBeVisible();
    await expect(page.getByTestId("express-payment-options")).toBeVisible();
    await expect(page.getByTestId("saved-addresses-dropdown")).toBeVisible();

    // Assert: Legacy flow NOT visible
    await expect(page.getByTestId("checkout-v1-container")).not.toBeVisible();

    // Assert: Telemetry event fired
    const analyticsEvents = await page.evaluate(() => (window as any).__ANALYTICS_EVENTS__ || []);
    expect(analyticsEvents).toContainEqual(
      expect.objectContaining({
        event: "checkout_started",
        properties: expect.objectContaining({
          variant: "new_flow",
        }),
      }),
    );
  });

  test("should use LEGACY checkout flow when flag is DISABLED", async ({ page, request }) => {
    // Arrange: Disable flag for test user (or don't target at all)
    await request.post("/api/feature-flags/target", {
      data: {
        flagKey: FLAGS.NEW_CHECKOUT_FLOW,
        userId: testUserId,
        variation: false, // DISABLED
      },
    });

    // Act: Navigate as targeted user
    await page.goto("/checkout", {
      extraHTTPHeaders: {
        "X-Test-User-ID": testUserId,
      },
    });

    // Assert: Legacy flow UI elements visible
    await expect(page.getByTestId("checkout-v1-container")).toBeVisible();
    await expect(page.getByTestId("legacy-payment-form")).toBeVisible();

    // Assert: New flow NOT visible
    await expect(page.getByTestId("checkout-v2-container")).not.toBeVisible();
    await expect(page.getByTestId("express-payment-options")).not.toBeVisible();

    // Assert: Telemetry event fired with correct variant
    const analyticsEvents = await page.evaluate(() => (window as any).__ANALYTICS_EVENTS__ || []);
    expect(analyticsEvents).toContainEqual(
      expect.objectContaining({
        event: "checkout_started",
        properties: expect.objectContaining({
          variant: "legacy_flow",
        }),
      }),
    );
  });

  test("should handle flag evaluation errors gracefully", async ({ page, request }) => {
    // Arrange: Simulate flag service unavailable
    await page.route("**/api/feature-flags/evaluate", (route) =>
      route.fulfill({ status: 500, body: "Service Unavailable" }),
    );

    // Act: Navigate (should fallback to default state)
    await page.goto("/checkout", {
      extraHTTPHeaders: {
        "X-Test-User-ID": testUserId,
      },
    });

    // Assert: Fallback to safe default (legacy flow)
    await expect(page.getByTestId("checkout-v1-container")).toBeVisible();

    // Assert: Error logged but no user-facing error
    const consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    expect(consoleErrors).toContain(expect.stringContaining("Feature flag evaluation failed"));
  });
});
```

**Cypress equivalent**:

```javascript
// cypress/e2e/checkout-feature-flag.cy.ts
import { FLAGS } from "@/utils/feature-flags";

describe("Checkout Flow - Feature Flag Variations", () => {
  let testUserId;

  beforeEach(() => {
    testUserId = `test-user-${Date.now()}`;
  });

  afterEach(() => {
    // Clean up targeting
    cy.task("removeFeatureFlagTarget", {
      flagKey: FLAGS.NEW_CHECKOUT_FLOW,
      userId: testUserId,
    });
  });

  it("should use NEW checkout flow when flag is ENABLED", () => {
    // Arrange: Enable flag via Cypress task
    cy.task("setFeatureFlagVariation", {
      flagKey: FLAGS.NEW_CHECKOUT_FLOW,
      userId: testUserId,
      variation: true,
    });

    // Act
    cy.visit("/checkout", {
      headers: { "X-Test-User-ID": testUserId },
    });

    // Assert
    cy.get('[data-testid="checkout-v2-container"]').should("be.visible");
    cy.get('[data-testid="checkout-v1-container"]').should("not.exist");
  });

  it("should use LEGACY checkout flow when flag is DISABLED", () => {
    // Arrange: Disable flag
    cy.task("setFeatureFlagVariation", {
      flagKey: FLAGS.NEW_CHECKOUT_FLOW,
      userId: testUserId,
      variation: false,
    });

    // Act
    cy.visit("/checkout", {
      headers: { "X-Test-User-ID": testUserId },
    });

    // Assert
    cy.get('[data-testid="checkout-v1-container"]').should("be.visible");
    cy.get('[data-testid="checkout-v2-container"]').should("not.exist");
  });
});
```

**Key Points**:

- **Test both states**: Enabled AND disabled variations
- **Automatic cleanup**: afterEach removes targeting (prevent pollution)
- **Unique test users**: Avoid conflicts with real user data
- **Telemetry validation**: Verify analytics events fire correctly
- **Graceful degradation**: Test fallback behavior on errors

---

### Example 3: Feature Flag Targeting Helper Pattern

**Context**: Reusable helpers for programmatic flag control via LaunchDarkly/Split.io API.

**Implementation**:

```typescript
// tests/support/feature-flag-helpers.ts
import { request as playwrightRequest } from "@playwright/test";
import { FLAGS, FlagKey } from "@/utils/feature-flags";

/**
 * LaunchDarkly API client configuration
 * Use test project SDK key (NOT production)
 */
const LD_SDK_KEY = process.env.LD_SDK_KEY_TEST;
const LD_API_BASE = "https://app.launchdarkly.com/api/v2";

type FlagVariation = boolean | string | number | object;

/**
 * Set flag variation for specific user
 * Uses LaunchDarkly API to create user target
 */
export async function setFlagForUser(
  flagKey: FlagKey,
  userId: string,
  variation: FlagVariation,
): Promise<void> {
  const response = await playwrightRequest.newContext().then((ctx) =>
    ctx.post(`${LD_API_BASE}/flags/${flagKey}/targeting`, {
      headers: {
        Authorization: LD_SDK_KEY!,
        "Content-Type": "application/json",
      },
      data: {
        targets: [
          {
            values: [userId],
            variation: variation ? 1 : 0, // 0 = off, 1 = on
          },
        ],
      },
    }),
  );

  if (!response.ok()) {
    throw new Error(`Failed to set flag ${flagKey} for user ${userId}: ${response.status()}`);
  }
}

/**
 * Remove user from flag targeting
 * CRITICAL for test cleanup
 */
export async function removeFlagTarget(flagKey: FlagKey, userId: string): Promise<void> {
  const response = await playwrightRequest.newContext().then((ctx) =>
    ctx.delete(`${LD_API_BASE}/flags/${flagKey}/targeting/users/${userId}`, {
      headers: {
        Authorization: LD_SDK_KEY!,
      },
    }),
  );

  if (!response.ok() && response.status() !== 404) {
    // 404 is acceptable (user wasn't targeted)
    throw new Error(
      `Failed to remove flag ${flagKey} target for user ${userId}: ${response.status()}`,
    );
  }
}

/**
 * Percentage rollout helper
 * Enable flag for N% of users
 */
export async function setFlagRolloutPercentage(
  flagKey: FlagKey,
  percentage: number,
): Promise<void> {
  if (percentage < 0 || percentage > 100) {
    throw new Error("Percentage must be between 0 and 100");
  }

  const response = await playwrightRequest.newContext().then((ctx) =>
    ctx.patch(`${LD_API_BASE}/flags/${flagKey}`, {
      headers: {
        Authorization: LD_SDK_KEY!,
        "Content-Type": "application/json",
      },
      data: {
        rollout: {
          variations: [
            { variation: 0, weight: 100 - percentage }, // off
            { variation: 1, weight: percentage }, // on
          ],
        },
      },
    }),
  );

  if (!response.ok()) {
    throw new Error(`Failed to set rollout for flag ${flagKey}: ${response.status()}`);
  }
}

/**
 * Enable flag globally (100% rollout)
 */
export async function enableFlagGlobally(flagKey: FlagKey): Promise<void> {
  await setFlagRolloutPercentage(flagKey, 100);
}

/**
 * Disable flag globally (0% rollout)
 */
export async function disableFlagGlobally(flagKey: FlagKey): Promise<void> {
  await setFlagRolloutPercentage(flagKey, 0);
}

/**
 * Stub feature flags in local/test environments
 * Bypasses LaunchDarkly entirely
 */
export function stubFeatureFlags(flags: Record<FlagKey, FlagVariation>): void {
  // Set flags in localStorage or inject into window
  if (typeof window !== "undefined") {
    (window as any).__STUBBED_FLAGS__ = flags;
  }
}
```

**Usage in Playwright fixture**:

```typescript
// playwright/fixtures/feature-flag-fixture.ts
import { test as base } from "@playwright/test";
import { setFlagForUser, removeFlagTarget } from "../support/feature-flag-helpers";
import { FlagKey } from "@/utils/feature-flags";

type FeatureFlagFixture = {
  featureFlags: {
    enable: (flag: FlagKey, userId: string) => Promise<void>;
    disable: (flag: FlagKey, userId: string) => Promise<void>;
    cleanup: (flag: FlagKey, userId: string) => Promise<void>;
  };
};

export const test = base.extend<FeatureFlagFixture>({
  featureFlags: async ({}, use) => {
    const cleanupQueue: Array<{ flag: FlagKey; userId: string }> = [];

    await use({
      enable: async (flag, userId) => {
        await setFlagForUser(flag, userId, true);
        cleanupQueue.push({ flag, userId });
      },
      disable: async (flag, userId) => {
        await setFlagForUser(flag, userId, false);
        cleanupQueue.push({ flag, userId });
      },
      cleanup: async (flag, userId) => {
        await removeFlagTarget(flag, userId);
      },
    });

    // Auto-cleanup after test
    for (const { flag, userId } of cleanupQueue) {
      await removeFlagTarget(flag, userId);
    }
  },
});
```

**Key Points**:

- **API-driven control**: No manual UI clicks required
- **Auto-cleanup**: Fixture tracks and removes targeting
- **Percentage rollouts**: Test gradual feature releases
- **Stubbing option**: Local development without LaunchDarkly
- **Type-safe**: FlagKey prevents typos

---

### Example 4: Feature Flag Lifecycle Checklist & Cleanup Strategy

**Context**: Governance checklist and automated cleanup detection for stale flags.

**Implementation**:

```typescript
// scripts/feature-flag-audit.ts
/**
 * Feature Flag Lifecycle Audit Script
 * Run weekly to detect stale flags requiring cleanup
 */

import { FLAG_REGISTRY, FLAGS, getExpiredFlags, FlagKey } from "../src/utils/feature-flags";
import * as fs from "fs";
import * as path from "path";

type AuditResult = {
  totalFlags: number;
  expiredFlags: FlagKey[];
  missingOwners: FlagKey[];
  missingDates: FlagKey[];
  permanentFlags: FlagKey[];
  flagsNearingExpiry: FlagKey[];
};

/**
 * Audit all feature flags for governance compliance
 */
function auditFeatureFlags(): AuditResult {
  const allFlags = Object.keys(FLAG_REGISTRY) as FlagKey[];
  const expiredFlags = getExpiredFlags().map((meta) => meta.key);

  // Flags expiring in next 30 days
  const thirtyDaysFromNow = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const flagsNearingExpiry = allFlags.filter((flag) => {
    const meta = FLAG_REGISTRY[flag];
    if (!meta.expiryDate) return false;
    const expiry = new Date(meta.expiryDate).getTime();
    return expiry > Date.now() && expiry < thirtyDaysFromNow;
  });

  // Missing metadata
  const missingOwners = allFlags.filter((flag) => !FLAG_REGISTRY[flag].owner);
  const missingDates = allFlags.filter((flag) => !FLAG_REGISTRY[flag].createdDate);

  // Permanent flags (no expiry, requiresCleanup = false)
  const permanentFlags = allFlags.filter((flag) => {
    const meta = FLAG_REGISTRY[flag];
    return !meta.expiryDate && !meta.requiresCleanup;
  });

  return {
    totalFlags: allFlags.length,
    expiredFlags,
    missingOwners,
    missingDates,
    permanentFlags,
    flagsNearingExpiry,
  };
}

/**
 * Generate markdown report
 */
function generateReport(audit: AuditResult): string {
  let report = `# Feature Flag Audit Report\n\n`;
  report += `**Date**: ${new Date().toISOString()}\n`;
  report += `**Total Flags**: ${audit.totalFlags}\n\n`;

  if (audit.expiredFlags.length > 0) {
    report += `## ⚠️ EXPIRED FLAGS - IMMEDIATE CLEANUP REQUIRED\n\n`;
    audit.expiredFlags.forEach((flag) => {
      const meta = FLAG_REGISTRY[flag];
      report += `- **${meta.name}** (\`${flag}\`)\n`;
      report += `  - Owner: ${meta.owner}\n`;
      report += `  - Expired: ${meta.expiryDate}\n`;
      report += `  - Action: Remove flag code, update tests, deploy\n\n`;
    });
  }

  if (audit.flagsNearingExpiry.length > 0) {
    report += `## ⏰ FLAGS EXPIRING SOON (Next 30 Days)\n\n`;
    audit.flagsNearingExpiry.forEach((flag) => {
      const meta = FLAG_REGISTRY[flag];
      report += `- **${meta.name}** (\`${flag}\`)\n`;
      report += `  - Owner: ${meta.owner}\n`;
      report += `  - Expires: ${meta.expiryDate}\n`;
      report += `  - Action: Plan cleanup or extend expiry\n\n`;
    });
  }

  if (audit.permanentFlags.length > 0) {
    report += `## 🔄 PERMANENT FLAGS (No Expiry)\n\n`;
    audit.permanentFlags.forEach((flag) => {
      const meta = FLAG_REGISTRY[flag];
      report += `- **${meta.name}** (\`${flag}\`) - Owner: ${meta.owner}\n`;
    });
    report += `\n`;
  }

  if (audit.missingOwners.length > 0 || audit.missingDates.length > 0) {
    report += `## ❌ GOVERNANCE ISSUES\n\n`;
    if (audit.missingOwners.length > 0) {
      report += `**Missing Owners**: ${audit.missingOwners.join(", ")}\n`;
    }
    if (audit.missingDates.length > 0) {
      report += `**Missing Created Dates**: ${audit.missingDates.join(", ")}\n`;
    }
    report += `\n`;
  }

  return report;
}

/**
 * Feature Flag Lifecycle Checklist
 */
const FLAG_LIFECYCLE_CHECKLIST = `
# Feature Flag Lifecycle Checklist

## Before Creating a New Flag

- [ ] **Name**: Follow naming convention (kebab-case, descriptive)
- [ ] **Owner**: Assign team/individual responsible
- [ ] **Default State**: Determine safe default (usually false)
- [ ] **Expiry Date**: Set removal date (30-90 days typical)
- [ ] **Dependencies**: Document related flags
- [ ] **Telemetry**: Plan analytics events to track
- [ ] **Rollback Plan**: Define how to disable quickly

## During Development

- [ ] **Code Paths**: Both enabled/disabled states implemented
- [ ] **Tests**: Both variations tested in CI
- [ ] **Documentation**: Flag purpose documented in code/PR
- [ ] **Telemetry**: Analytics events instrumented
- [ ] **Error Handling**: Graceful degradation on flag service failure

## Before Launch

- [ ] **QA**: Both states tested in staging
- [ ] **Rollout Plan**: Gradual rollout percentage defined
- [ ] **Monitoring**: Dashboards/alerts for flag-related metrics
- [ ] **Stakeholder Communication**: Product/design aligned

## After Launch (Monitoring)

- [ ] **Metrics**: Success criteria tracked
- [ ] **Error Rates**: No increase in errors
- [ ] **Performance**: No degradation
- [ ] **User Feedback**: Qualitative data collected

## Cleanup (Post-Launch)

- [ ] **Remove Flag Code**: Delete if/else branches
- [ ] **Update Tests**: Remove flag-specific tests
- [ ] **Remove Targeting**: Clear all user targets
- [ ] **Delete Flag Config**: Remove from LaunchDarkly/registry
- [ ] **Update Documentation**: Remove references
- [ ] **Deploy**: Ship cleanup changes
`;

// Run audit
const audit = auditFeatureFlags();
const report = generateReport(audit);

// Save report
const outputPath = path.join(__dirname, "../feature-flag-audit-report.md");
fs.writeFileSync(outputPath, report);
fs.writeFileSync(path.join(__dirname, "../FEATURE-FLAG-CHECKLIST.md"), FLAG_LIFECYCLE_CHECKLIST);

console.log(`✅ Audit complete. Report saved to: ${outputPath}`);
console.log(`Total flags: ${audit.totalFlags}`);
console.log(`Expired flags: ${audit.expiredFlags.length}`);
console.log(`Flags expiring soon: ${audit.flagsNearingExpiry.length}`);

// Exit with error if expired flags exist
if (audit.expiredFlags.length > 0) {
  console.error(`\n❌ EXPIRED FLAGS DETECTED - CLEANUP REQUIRED`);
  process.exit(1);
}
```

**package.json scripts**:

```json
{
  "scripts": {
    "feature-flags:audit": "ts-node scripts/feature-flag-audit.ts",
    "feature-flags:audit:ci": "npm run feature-flags:audit || true"
  }
}
```

**Key Points**:

- **Automated detection**: Weekly audit catches stale flags
- **Lifecycle checklist**: Comprehensive governance guide
- **Expiry tracking**: Flags auto-expire after defined date
- **CI integration**: Audit runs in pipeline, warns on expiry
- **Ownership clarity**: Every flag has assigned owner

---

## Feature Flag Testing Checklist

Before merging flag-related code, verify:

- [ ] **Both states tested**: Enabled AND disabled variations covered
- [ ] **Cleanup automated**: afterEach removes targeting (no manual cleanup)
- [ ] **Unique test data**: Test users don't collide with production
- [ ] **Telemetry validated**: Analytics events fire for both variations
- [ ] **Error handling**: Graceful fallback when flag service unavailable
- [ ] **Flag metadata**: Owner, dates, dependencies documented in registry
- [ ] **Rollback plan**: Clear steps to disable flag in production
- [ ] **Expiry date set**: Removal date defined (or marked permanent)

## Integration Points

- Used in workflows: `*automate` (test generation), `*framework` (flag setup)
- Related fragments: `test-quality.md`, `selective-testing.md`
- Flag services: LaunchDarkly, Split.io, Unleash, custom implementations

_Source: LaunchDarkly strategy blog, Murat test architecture notes, SEON feature flag governance_
