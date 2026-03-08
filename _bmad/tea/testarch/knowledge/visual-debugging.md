# Visual Debugging and Developer Ergonomics

## Principle

Fast feedback loops and transparent debugging artifacts are critical for maintaining test reliability and developer confidence. Visual debugging tools (trace viewers, screenshots, videos, HAR files) turn cryptic test failures into actionable insights, reducing triage time from hours to minutes.

## Rationale

**The Problem**: CI failures often provide minimal context—a timeout, a selector mismatch, or a network error—forcing developers to reproduce issues locally (if they can). This wastes time and discourages test maintenance.

**The Solution**: Capture rich debugging artifacts **only on failure** to balance storage costs with diagnostic value. Modern tools like Playwright Trace Viewer, Cypress Debug UI, and HAR recordings provide interactive, time-travel debugging that reveals exactly what the test saw at each step.

**Why This Matters**:

- Reduces failure triage time by 80-90% (visual context vs logs alone)
- Enables debugging without local reproduction
- Improves test maintenance confidence (clear failure root cause)
- Catches timing/race conditions that are hard to reproduce locally

## Pattern Examples

### Example 1: Playwright Trace Viewer Configuration (Production Pattern)

**Context**: Capture traces on first retry only (balances storage and diagnostics)

**Implementation**:

```typescript
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  use: {
    // Visual debugging artifacts (space-efficient)
    trace: "on-first-retry", // Only when test fails once
    screenshot: "only-on-failure", // Not on success
    video: "retain-on-failure", // Delete on pass

    // Context for debugging
    baseURL: process.env.BASE_URL || "http://localhost:3000",

    // Timeout context
    actionTimeout: 15_000, // 15s for clicks/fills
    navigationTimeout: 30_000, // 30s for page loads
  },

  // CI-specific artifact retention
  reporter: [
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["junit", { outputFile: "results.xml" }],
    ["list"], // Console output
  ],

  // Failure handling
  retries: process.env.CI ? 2 : 0, // Retry in CI to capture trace
  workers: process.env.CI ? 1 : undefined,
});
```

**Opening and Using Trace Viewer**:

```bash
# After test failure in CI, download trace artifact
# Then open locally:
npx playwright show-trace path/to/trace.zip

# Or serve trace viewer:
npx playwright show-report
```

**Key Features to Use in Trace Viewer**:

1. **Timeline**: See each action (click, navigate, assertion) with timing
2. **Snapshots**: Hover over timeline to see DOM state at that moment
3. **Network Tab**: Inspect all API calls, headers, payloads, timing
4. **Console Tab**: View console.log/error messages
5. **Source Tab**: See test code with execution markers
6. **Metadata**: Browser, OS, test duration, screenshots

**Why This Works**:

- `on-first-retry` avoids capturing traces for flaky passes (saves storage)
- Screenshots + video give visual context without trace overhead
- Interactive timeline makes timing issues obvious (race conditions, slow API)

---

### Example 2: HAR File Recording for Network Debugging

**Context**: Capture all network activity for reproducible API debugging

**Implementation**:

```typescript
// tests/e2e/checkout-with-har.spec.ts
import { test, expect } from "@playwright/test";
import path from "path";

test.describe("Checkout Flow with HAR Recording", () => {
  test("should complete payment with full network capture", async ({ page, context }) => {
    // Start HAR recording BEFORE navigation
    await context.routeFromHAR(path.join(__dirname, "../fixtures/checkout.har"), {
      url: "**/api/**", // Only capture API calls
      update: true, // Update HAR if file exists
    });

    await page.goto("/checkout");

    // Interact with page
    await page.getByTestId("payment-method").selectOption("credit-card");
    await page.getByTestId("card-number").fill("4242424242424242");
    await page.getByTestId("submit-payment").click();

    // Wait for payment confirmation
    await expect(page.getByTestId("success-message")).toBeVisible();

    // HAR file saved to fixtures/checkout.har
    // Contains all network requests/responses for replay
  });
});
```

**Using HAR for Deterministic Mocking**:

```typescript
// tests/e2e/checkout-replay-har.spec.ts
import { test, expect } from "@playwright/test";
import path from "path";

test("should replay checkout flow from HAR", async ({ page, context }) => {
  // Replay network from HAR (no real API calls)
  await context.routeFromHAR(path.join(__dirname, "../fixtures/checkout.har"), {
    url: "**/api/**",
    update: false, // Read-only mode
  });

  await page.goto("/checkout");

  // Same test, but network responses come from HAR file
  await page.getByTestId("payment-method").selectOption("credit-card");
  await page.getByTestId("card-number").fill("4242424242424242");
  await page.getByTestId("submit-payment").click();

  await expect(page.getByTestId("success-message")).toBeVisible();
});
```

**Key Points**:

- **`update: true`** records new HAR or updates existing (for flaky API debugging)
- **`update: false`** replays from HAR (deterministic, no real API)
- Filter by URL pattern (`**/api/**`) to avoid capturing static assets
- HAR files are human-readable JSON (easy to inspect/modify)

**When to Use HAR**:

- Debugging flaky tests caused by API timing/responses
- Creating deterministic mocks for integration tests
- Analyzing third-party API behavior (Stripe, Auth0)
- Reproducing production issues locally (record HAR in staging)

---

### Example 3: Custom Artifact Capture (Console Logs + Network on Failure)

**Context**: Capture additional debugging context automatically on test failure

**Implementation**:

```typescript
// playwright/support/fixtures/debug-fixture.ts
import { test as base } from "@playwright/test";
import fs from "fs";
import path from "path";

type DebugFixture = {
  captureDebugArtifacts: () => Promise<void>;
};

export const test = base.extend<DebugFixture>({
  captureDebugArtifacts: async ({ page }, use, testInfo) => {
    const consoleLogs: string[] = [];
    const networkRequests: Array<{ url: string; status: number; method: string }> = [];

    // Capture console messages
    page.on("console", (msg) => {
      consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
    });

    // Capture network requests
    page.on("request", (request) => {
      networkRequests.push({
        url: request.url(),
        method: request.method(),
        status: 0, // Will be updated on response
      });
    });

    page.on("response", (response) => {
      const req = networkRequests.find((r) => r.url === response.url());
      if (req) req.status = response.status();
    });

    await use(async () => {
      // This function can be called manually in tests
      // But it also runs automatically on failure via afterEach
    });

    // After test completes, save artifacts if failed
    if (testInfo.status !== testInfo.expectedStatus) {
      const artifactDir = path.join(testInfo.outputDir, "debug-artifacts");
      fs.mkdirSync(artifactDir, { recursive: true });

      // Save console logs
      fs.writeFileSync(path.join(artifactDir, "console.log"), consoleLogs.join("\n"), "utf-8");

      // Save network summary
      fs.writeFileSync(
        path.join(artifactDir, "network.json"),
        JSON.stringify(networkRequests, null, 2),
        "utf-8",
      );

      console.log(`Debug artifacts saved to: ${artifactDir}`);
    }
  },
});
```

**Usage in Tests**:

```typescript
// tests/e2e/payment-with-debug.spec.ts
import { test, expect } from "../support/fixtures/debug-fixture";

test("payment flow captures debug artifacts on failure", async ({
  page,
  captureDebugArtifacts,
}) => {
  await page.goto("/checkout");

  // Test will automatically capture console + network on failure
  await page.getByTestId("submit-payment").click();
  await expect(page.getByTestId("success-message")).toBeVisible({ timeout: 5000 });

  // If this fails, console.log and network.json saved automatically
});
```

**CI Integration (GitHub Actions)**:

```yaml
# .github/workflows/e2e.yml
name: E2E Tests with Artifacts
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: ".nvmrc"

      - name: Install dependencies
        run: npm ci

      - name: Run Playwright tests
        run: npm run test:e2e
        continue-on-error: true # Capture artifacts even on failure

      - name: Upload test artifacts on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-artifacts
          path: |
            test-results/
            playwright-report/
          retention-days: 30
```

**Key Points**:

- Fixtures automatically capture context without polluting test code
- Only saves artifacts on failure (storage-efficient)
- CI uploads artifacts for post-mortem analysis
- `continue-on-error: true` ensures artifact upload even when tests fail

---

### Example 4: Accessibility Debugging Integration (axe-core in Trace Viewer)

**Context**: Catch accessibility regressions during visual debugging

**Implementation**:

```typescript
// playwright/support/fixtures/a11y-fixture.ts
import { test as base } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

type A11yFixture = {
  checkA11y: () => Promise<void>;
};

export const test = base.extend<A11yFixture>({
  checkA11y: async ({ page }, use) => {
    await use(async () => {
      // Run axe accessibility scan
      const results = await new AxeBuilder({ page }).analyze();

      // Attach results to test report (visible in trace viewer)
      if (results.violations.length > 0) {
        console.log(`Found ${results.violations.length} accessibility violations:`);
        results.violations.forEach((violation) => {
          console.log(`- [${violation.impact}] ${violation.id}: ${violation.description}`);
          console.log(`  Help: ${violation.helpUrl}`);
        });

        throw new Error(`Accessibility violations found: ${results.violations.length}`);
      }
    });
  },
});
```

**Usage with Visual Debugging**:

```typescript
// tests/e2e/checkout-a11y.spec.ts
import { test, expect } from "../support/fixtures/a11y-fixture";

test("checkout page is accessible", async ({ page, checkA11y }) => {
  await page.goto("/checkout");

  // Verify page loaded
  await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible();

  // Run accessibility check
  await checkA11y();

  // If violations found, test fails and trace captures:
  // - Screenshot showing the problematic element
  // - Console log with violation details
  // - Network tab showing any failed resource loads
});
```

**Trace Viewer Benefits**:

- **Screenshot shows visual context** of accessibility issue (contrast, missing labels)
- **Console tab shows axe-core violations** with impact level and helpUrl
- **DOM snapshot** allows inspecting ARIA attributes at failure point
- **Network tab** reveals if icon fonts or images failed (common a11y issue)

**Cypress Equivalent**:

```javascript
// cypress/support/commands.ts
import "cypress-axe";

Cypress.Commands.add("checkA11y", (context = null, options = {}) => {
  cy.injectAxe(); // Inject axe-core
  cy.checkA11y(context, options, (violations) => {
    if (violations.length) {
      cy.task("log", `Found ${violations.length} accessibility violations`);
      violations.forEach((violation) => {
        cy.task("log", `- [${violation.impact}] ${violation.id}: ${violation.description}`);
      });
    }
  });
});

// tests/e2e/checkout-a11y.cy.ts
describe("Checkout Accessibility", () => {
  it("should have no a11y violations", () => {
    cy.visit("/checkout");
    cy.injectAxe();
    cy.checkA11y();
    // On failure, Cypress UI shows:
    // - Screenshot of page
    // - Console log with violation details
    // - Network tab with API calls
  });
});
```

**Key Points**:

- Accessibility checks integrate seamlessly with visual debugging
- Violations are captured in trace viewer/Cypress UI automatically
- Provides actionable links (helpUrl) to fix issues
- Screenshots show visual context (contrast, layout)

---

### Example 5: Time-Travel Debugging Workflow (Playwright Inspector)

**Context**: Debug tests interactively with step-through execution

**Implementation**:

```typescript
// tests/e2e/checkout-debug.spec.ts
import { test, expect } from "@playwright/test";

test("debug checkout flow step-by-step", async ({ page }) => {
  // Set breakpoint by uncommenting this:
  // await page.pause()

  await page.goto("/checkout");

  // Use Playwright Inspector to:
  // 1. Step through each action
  // 2. Inspect DOM at each step
  // 3. View network calls per action
  // 4. Take screenshots manually

  await page.getByTestId("payment-method").selectOption("credit-card");

  // Pause here to inspect form state
  // await page.pause()

  await page.getByTestId("card-number").fill("4242424242424242");
  await page.getByTestId("submit-payment").click();

  await expect(page.getByTestId("success-message")).toBeVisible();
});
```

**Running with Inspector**:

```bash
# Open Playwright Inspector (GUI debugger)
npx playwright test --debug

# Or use headed mode with slowMo
npx playwright test --headed --slow-mo=1000

# Debug specific test
npx playwright test checkout-debug.spec.ts --debug

# Set environment variable for persistent debugging
PWDEBUG=1 npx playwright test
```

**Inspector Features**:

1. **Step-through execution**: Click "Next" to execute one action at a time
2. **DOM inspector**: Hover over elements to see selectors
3. **Network panel**: See API calls with timing
4. **Console panel**: View console.log output
5. **Pick locator**: Click element in browser to get selector
6. **Record mode**: Record interactions to generate test code

**Common Debugging Patterns**:

```typescript
// Pattern 1: Debug selector issues
test("debug selector", async ({ page }) => {
  await page.goto("/dashboard");
  await page.pause(); // Inspector opens

  // In Inspector console, test selectors:
  // page.getByTestId('user-menu') ✅
  // page.getByRole('button', { name: 'Profile' }) ✅
  // page.locator('.btn-primary') ❌ (fragile)
});

// Pattern 2: Debug timing issues
test("debug network timing", async ({ page }) => {
  await page.goto("/dashboard");

  // Set up network listener BEFORE interaction
  const responsePromise = page.waitForResponse("**/api/users");
  await page.getByTestId("load-users").click();

  await page.pause(); // Check network panel for timing

  const response = await responsePromise;
  expect(response.status()).toBe(200);
});

// Pattern 3: Debug state changes
test("debug state mutation", async ({ page }) => {
  await page.goto("/cart");

  // Check initial state
  await expect(page.getByTestId("cart-count")).toHaveText("0");

  await page.pause(); // Inspect DOM

  await page.getByTestId("add-to-cart").click();

  await page.pause(); // Inspect DOM again (compare state)

  await expect(page.getByTestId("cart-count")).toHaveText("1");
});
```

**Key Points**:

- `page.pause()` opens Inspector at that exact moment
- Inspector shows DOM state, network activity, console at pause point
- "Pick locator" feature helps find robust selectors
- Record mode generates test code from manual interactions

---

## Visual Debugging Checklist

Before deploying tests to CI, ensure:

- [ ] **Artifact configuration**: `trace: 'on-first-retry'`, `screenshot: 'only-on-failure'`, `video: 'retain-on-failure'`
- [ ] **CI artifact upload**: GitHub Actions/GitLab CI configured to upload `test-results/` and `playwright-report/`
- [ ] **HAR recording**: Set up for flaky API tests (record once, replay deterministically)
- [ ] **Custom debug fixtures**: Console logs + network summary captured on failure
- [ ] **Accessibility integration**: axe-core violations visible in trace viewer
- [ ] **Trace viewer docs**: README explains how to open traces locally (`npx playwright show-trace`)
- [ ] **Inspector workflow**: Document `--debug` flag for interactive debugging
- [ ] **Storage optimization**: Artifacts deleted after 30 days (CI retention policy)

## Integration Points

- **Used in workflows**: `*framework` (initial setup), `*ci` (artifact upload), `*test-review` (validate artifact config)
- **Related fragments**: `playwright-config.md` (artifact configuration), `ci-burn-in.md` (CI artifact upload), `test-quality.md` (debugging best practices)
- **Tools**: Playwright Trace Viewer, Cypress Debug UI, axe-core, HAR files

_Source: Playwright official docs, Murat testing philosophy (visual debugging manifesto), SEON production debugging patterns_
