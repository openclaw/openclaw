# Playwright Configuration Guardrails

## Principle

Load environment configs via a central map (`envConfigMap`), standardize timeouts (action 15s, navigation 30s, expect 10s, test 60s), emit HTML + JUnit reporters, and store artifacts under `test-results/` for CI upload. Keep `.env.example`, `.nvmrc`, and browser dependencies versioned so local and CI runs stay aligned.

## Rationale

Environment-specific configuration prevents hardcoded URLs, timeouts, and credentials from leaking into tests. A central config map with fail-fast validation catches missing environments early. Standardized timeouts reduce flakiness while remaining long enough for real-world network conditions. Consistent artifact storage (`test-results/`, `playwright-report/`) enables CI pipelines to upload failure evidence automatically. Versioned dependencies (`.nvmrc`, `package.json` browser versions) eliminate "works on my machine" issues between local and CI environments.

## Pattern Examples

### Example 1: Environment-Based Configuration

**Context**: When testing against multiple environments (local, staging, production), use a central config map that loads environment-specific settings and fails fast if `TEST_ENV` is invalid.

**Implementation**:

```typescript
// playwright.config.ts - Central config loader
import { config as dotenvConfig } from "dotenv";
import path from "path";

// Load .env from project root
dotenvConfig({
  path: path.resolve(__dirname, "../../.env"),
});

// Central environment config map
const envConfigMap = {
  local: require("./playwright/config/local.config").default,
  staging: require("./playwright/config/staging.config").default,
  production: require("./playwright/config/production.config").default,
};

const environment = process.env.TEST_ENV || "local";

// Fail fast if environment not supported
if (!Object.keys(envConfigMap).includes(environment)) {
  console.error(`❌ No configuration found for environment: ${environment}`);
  console.error(`   Available environments: ${Object.keys(envConfigMap).join(", ")}`);
  process.exit(1);
}

console.log(`✅ Running tests against: ${environment.toUpperCase()}`);

export default envConfigMap[environment as keyof typeof envConfigMap];
```

```typescript
// playwright/config/base.config.ts - Shared base configuration
import { defineConfig } from "@playwright/test";
import path from "path";

export const baseConfig = defineConfig({
  testDir: path.resolve(__dirname, "../tests"),
  outputDir: path.resolve(__dirname, "../../test-results"),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["junit", { outputFile: "test-results/results.xml" }],
    ["list"],
  ],
  use: {
    actionTimeout: 15000,
    navigationTimeout: 30000,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  globalSetup: path.resolve(__dirname, "../support/global-setup.ts"),
  timeout: 60000,
  expect: { timeout: 10000 },
});
```

```typescript
// playwright/config/local.config.ts - Local environment
import { defineConfig } from "@playwright/test";
import { baseConfig } from "./base.config";

export default defineConfig({
  ...baseConfig,
  use: {
    ...baseConfig.use,
    baseURL: "http://localhost:3000",
    video: "off", // No video locally for speed
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
```

```typescript
// playwright/config/staging.config.ts - Staging environment
import { defineConfig } from "@playwright/test";
import { baseConfig } from "./base.config";

export default defineConfig({
  ...baseConfig,
  use: {
    ...baseConfig.use,
    baseURL: "https://staging.example.com",
    ignoreHTTPSErrors: true, // Allow self-signed certs in staging
  },
});
```

```typescript
// playwright/config/production.config.ts - Production environment
import { defineConfig } from "@playwright/test";
import { baseConfig } from "./base.config";

export default defineConfig({
  ...baseConfig,
  retries: 3, // More retries in production
  use: {
    ...baseConfig.use,
    baseURL: "https://example.com",
    video: "on", // Always record production failures
  },
});
```

```bash
# .env.example - Template for developers
TEST_ENV=local
API_KEY=your_api_key_here
DATABASE_URL=postgresql://localhost:5432/test_db
```

**Key Points**:

- Central `envConfigMap` prevents environment misconfiguration
- Fail-fast validation with clear error message (available envs listed)
- Base config defines shared settings, environment configs override
- `.env.example` provides template for required secrets
- `TEST_ENV=local` as default for local development
- Production config increases retries and enables video recording

### Example 2: Timeout Standards

**Context**: When tests fail due to inconsistent timeout settings, standardize timeouts across all tests: action 15s, navigation 30s, expect 10s, test 60s. Expose overrides through fixtures rather than inline literals.

**Implementation**:

```typescript
// playwright/config/base.config.ts - Standardized timeouts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  // Global test timeout: 60 seconds
  timeout: 60000,

  use: {
    // Action timeout: 15 seconds (click, fill, etc.)
    actionTimeout: 15000,

    // Navigation timeout: 30 seconds (page.goto, page.reload)
    navigationTimeout: 30000,
  },

  // Expect timeout: 10 seconds (all assertions)
  expect: {
    timeout: 10000,
  },
});
```

```typescript
// playwright/support/fixtures/timeout-fixture.ts - Timeout override fixture
import { test as base } from "@playwright/test";

type TimeoutOptions = {
  extendedTimeout: (timeoutMs: number) => Promise<void>;
};

export const test = base.extend<TimeoutOptions>({
  extendedTimeout: async ({}, use, testInfo) => {
    const originalTimeout = testInfo.timeout;

    await use(async (timeoutMs: number) => {
      testInfo.setTimeout(timeoutMs);
    });

    // Restore original timeout after test
    testInfo.setTimeout(originalTimeout);
  },
});

export { expect } from "@playwright/test";
```

```typescript
// Usage in tests - Standard timeouts (implicit)
import { test, expect } from "@playwright/test";

test("user can log in", async ({ page }) => {
  await page.goto("/login"); // Uses 30s navigation timeout
  await page.fill('[data-testid="email"]', "test@example.com"); // Uses 15s action timeout
  await page.click('[data-testid="login-button"]'); // Uses 15s action timeout

  await expect(page.getByText("Welcome")).toBeVisible(); // Uses 10s expect timeout
});
```

```typescript
// Usage in tests - Per-test timeout override
import { test, expect } from "../support/fixtures/timeout-fixture";

test("slow data processing operation", async ({ page, extendedTimeout }) => {
  // Override default 60s timeout for this slow test
  await extendedTimeout(180000); // 3 minutes

  await page.goto("/data-processing");
  await page.click('[data-testid="process-large-file"]');

  // Wait for long-running operation
  await expect(page.getByText("Processing complete")).toBeVisible({
    timeout: 120000, // 2 minutes for assertion
  });
});
```

```typescript
// Per-assertion timeout override (inline)
test("API returns quickly", async ({ page }) => {
  await page.goto("/dashboard");

  // Override expect timeout for fast API (reduce flakiness detection)
  await expect(page.getByTestId("user-name")).toBeVisible({ timeout: 5000 }); // 5s instead of 10s

  // Override expect timeout for slow external API
  await expect(page.getByTestId("weather-widget")).toBeVisible({ timeout: 20000 }); // 20s instead of 10s
});
```

**Key Points**:

- **Standardized timeouts**: action 15s, navigation 30s, expect 10s, test 60s (global defaults)
- Fixture-based override (`extendedTimeout`) for slow tests (preferred over inline)
- Per-assertion timeout override via `{ timeout: X }` option (use sparingly)
- Avoid hard waits (`page.waitForTimeout(3000)`) - use event-based waits instead
- CI environments may need longer timeouts (handle in environment-specific config)

### Example 3: Artifact Output Configuration

**Context**: When debugging failures in CI, configure artifacts (screenshots, videos, traces, HTML reports) to be captured on failure and stored in consistent locations for upload.

**Implementation**:

```typescript
// playwright.config.ts - Artifact configuration
import { defineConfig } from "@playwright/test";
import path from "path";

export default defineConfig({
  // Output directory for test artifacts
  outputDir: path.resolve(__dirname, "./test-results"),

  use: {
    // Screenshot on failure only (saves space)
    screenshot: "only-on-failure",

    // Video recording on failure + retry
    video: "retain-on-failure",

    // Trace recording on first retry (best debugging data)
    trace: "on-first-retry",
  },

  reporter: [
    // HTML report (visual, interactive)
    [
      "html",
      {
        outputFolder: "playwright-report",
        open: "never", // Don't auto-open in CI
      },
    ],

    // JUnit XML (CI integration)
    [
      "junit",
      {
        outputFile: "test-results/results.xml",
      },
    ],

    // List reporter (console output)
    ["list"],
  ],
});
```

```typescript
// playwright/support/fixtures/artifact-fixture.ts - Custom artifact capture
import { test as base } from "@playwright/test";
import fs from "fs";
import path from "path";

export const test = base.extend({
  // Auto-capture console logs on failure
  page: async ({ page }, use, testInfo) => {
    const logs: string[] = [];

    page.on("console", (msg) => {
      logs.push(`[${msg.type()}] ${msg.text()}`);
    });

    await use(page);

    // Save logs on failure
    if (testInfo.status !== testInfo.expectedStatus) {
      const logsPath = path.join(testInfo.outputDir, "console-logs.txt");
      fs.writeFileSync(logsPath, logs.join("\n"));
      testInfo.attachments.push({
        name: "console-logs",
        contentType: "text/plain",
        path: logsPath,
      });
    }
  },
});
```

```yaml
# .github/workflows/e2e.yml - CI artifact upload
name: E2E Tests
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

      - name: Install Playwright browsers
        run: npx playwright install --with-deps

      - name: Run tests
        run: npm run test
        env:
          TEST_ENV: staging

      # Upload test artifacts on failure
      - name: Upload test results
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: test-results
          path: test-results/
          retention-days: 30

      - name: Upload Playwright report
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 30
```

```typescript
// Example: Custom screenshot on specific condition
test("capture screenshot on specific error", async ({ page }) => {
  await page.goto("/checkout");

  try {
    await page.click('[data-testid="submit-payment"]');
    await expect(page.getByText("Order Confirmed")).toBeVisible();
  } catch (error) {
    // Capture custom screenshot with timestamp
    await page.screenshot({
      path: `test-results/payment-error-${Date.now()}.png`,
      fullPage: true,
    });
    throw error;
  }
});
```

**Key Points**:

- `screenshot: 'only-on-failure'` saves space (not every test)
- `video: 'retain-on-failure'` captures full flow on failures
- `trace: 'on-first-retry'` provides deep debugging data (network, DOM, console)
- HTML report at `playwright-report/` (visual debugging)
- JUnit XML at `test-results/results.xml` (CI integration)
- CI uploads artifacts on failure with 30-day retention
- Custom fixture can capture console logs, network logs, etc.

### Example 4: Parallelization Configuration

**Context**: When tests run slowly in CI, configure parallelization with worker count, sharding, and fully parallel execution to maximize speed while maintaining stability.

**Implementation**:

```typescript
// playwright.config.ts - Parallelization settings
import { defineConfig } from "@playwright/test";
import os from "os";

export default defineConfig({
  // Run tests in parallel within single file
  fullyParallel: true,

  // Worker configuration
  workers: process.env.CI
    ? 1 // Serial in CI for stability (or 2 for faster CI)
    : os.cpus().length - 1, // Parallel locally (leave 1 CPU for OS)

  // Prevent accidentally committed .only() from blocking CI
  forbidOnly: !!process.env.CI,

  // Retry failed tests in CI
  retries: process.env.CI ? 2 : 0,

  // Shard configuration (split tests across multiple machines)
  shard:
    process.env.SHARD_INDEX && process.env.SHARD_TOTAL
      ? {
          current: parseInt(process.env.SHARD_INDEX, 10),
          total: parseInt(process.env.SHARD_TOTAL, 10),
        }
      : undefined,
});
```

```yaml
# .github/workflows/e2e-parallel.yml - Sharded CI execution
name: E2E Tests (Parallel)
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4] # Split tests across 4 machines
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: ".nvmrc"

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps

      - name: Run tests (shard ${{ matrix.shard }})
        run: npm run test
        env:
          SHARD_INDEX: ${{ matrix.shard }}
          SHARD_TOTAL: 4
          TEST_ENV: staging

      - name: Upload test results
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: test-results-shard-${{ matrix.shard }}
          path: test-results/
```

```typescript
// playwright/config/serial.config.ts - Serial execution for flaky tests
import { defineConfig } from "@playwright/test";
import { baseConfig } from "./base.config";

export default defineConfig({
  ...baseConfig,

  // Disable parallel execution
  fullyParallel: false,
  workers: 1,

  // Used for: authentication flows, database-dependent tests, feature flag tests
});
```

```typescript
// Usage: Force serial execution for specific tests
import { test } from "@playwright/test";

// Serial execution for auth tests (shared session state)
test.describe.configure({ mode: "serial" });

test.describe("Authentication Flow", () => {
  test("user can log in", async ({ page }) => {
    // First test in serial block
  });

  test("user can access dashboard", async ({ page }) => {
    // Depends on previous test (serial)
  });
});
```

```typescript
// Usage: Parallel execution for independent tests (default)
import { test } from "@playwright/test";

test.describe("Product Catalog", () => {
  test("can view product 1", async ({ page }) => {
    // Runs in parallel with other tests
  });

  test("can view product 2", async ({ page }) => {
    // Runs in parallel with other tests
  });
});
```

**Key Points**:

- `fullyParallel: true` enables parallel execution within single test file
- Workers: 1 in CI (stability), N-1 CPUs locally (speed)
- Sharding splits tests across multiple CI machines (4x faster with 4 shards)
- `test.describe.configure({ mode: 'serial' })` for dependent tests
- `forbidOnly: true` in CI prevents `.only()` from blocking pipeline
- Matrix strategy in CI runs shards concurrently

### Example 5: Project Configuration

**Context**: When testing across multiple browsers, devices, or configurations, use Playwright projects to run the same tests against different environments (chromium, firefox, webkit, mobile).

**Implementation**:

```typescript
// playwright.config.ts - Multiple browser projects
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  projects: [
    // Desktop browsers
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },

    // Mobile browsers
    {
      name: "mobile-chrome",
      use: { ...devices["Pixel 5"] },
    },
    {
      name: "mobile-safari",
      use: { ...devices["iPhone 13"] },
    },

    // Tablet
    {
      name: "tablet",
      use: { ...devices["iPad Pro"] },
    },
  ],
});
```

```typescript
// playwright.config.ts - Authenticated vs. unauthenticated projects
import { defineConfig } from "@playwright/test";
import path from "path";

export default defineConfig({
  projects: [
    // Setup project (runs first, creates auth state)
    {
      name: "setup",
      testMatch: /global-setup\.ts/,
    },

    // Authenticated tests (reuse auth state)
    {
      name: "authenticated",
      dependencies: ["setup"],
      use: {
        storageState: path.resolve(__dirname, "./playwright/.auth/user.json"),
      },
      testMatch: /.*authenticated\.spec\.ts/,
    },

    // Unauthenticated tests (public pages)
    {
      name: "unauthenticated",
      testMatch: /.*unauthenticated\.spec\.ts/,
    },
  ],
});
```

```typescript
// playwright/support/global-setup.ts - Setup project for auth
import { chromium, FullConfig } from "@playwright/test";
import path from "path";

async function globalSetup(config: FullConfig) {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Perform authentication
  await page.goto("http://localhost:3000/login");
  await page.fill('[data-testid="email"]', "test@example.com");
  await page.fill('[data-testid="password"]', "password123");
  await page.click('[data-testid="login-button"]');

  // Wait for authentication to complete
  await page.waitForURL("**/dashboard");

  // Save authentication state
  await page.context().storageState({
    path: path.resolve(__dirname, "../.auth/user.json"),
  });

  await browser.close();
}

export default globalSetup;
```

```bash
# Run specific project
npx playwright test --project=chromium
npx playwright test --project=mobile-chrome
npx playwright test --project=authenticated

# Run multiple projects
npx playwright test --project=chromium --project=firefox

# Run all projects (default)
npx playwright test
```

```typescript
// Usage: Project-specific test
import { test, expect } from "@playwright/test";

test("mobile navigation works", async ({ page, isMobile }) => {
  await page.goto("/");

  if (isMobile) {
    // Open mobile menu
    await page.click('[data-testid="hamburger-menu"]');
  }

  await page.click('[data-testid="products-link"]');
  await expect(page).toHaveURL(/.*products/);
});
```

```yaml
# .github/workflows/e2e-cross-browser.yml - CI cross-browser testing
name: E2E Tests (Cross-Browser)
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        project: [chromium, firefox, webkit, mobile-chrome]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npx playwright install --with-deps

      - name: Run tests (${{ matrix.project }})
        run: npx playwright test --project=${{ matrix.project }}
```

**Key Points**:

- Projects enable testing across browsers, devices, and configurations
- `devices` from `@playwright/test` provide preset configurations (Pixel 5, iPhone 13, etc.)
- `dependencies` ensures setup project runs first (auth, data seeding)
- `storageState` shares authentication across tests (0 seconds auth per test)
- `testMatch` filters which tests run in which project
- CI matrix strategy runs projects in parallel (4x faster with 4 projects)
- `isMobile` context property for conditional logic in tests

## Integration Points

- **Used in workflows**: `*framework` (config setup), `*ci` (parallelization, artifact upload)
- **Related fragments**:
  - `fixture-architecture.md` - Fixture-based timeout overrides
  - `ci-burn-in.md` - CI pipeline artifact upload
  - `test-quality.md` - Timeout standards (no hard waits)
  - `data-factories.md` - Per-test isolation (no shared global state)

## Configuration Checklist

**Before deploying tests, verify**:

- [ ] Environment config map with fail-fast validation
- [ ] Standardized timeouts (action 15s, navigation 30s, expect 10s, test 60s)
- [ ] Artifact storage at `test-results/` and `playwright-report/`
- [ ] HTML + JUnit reporters configured
- [ ] `.env.example`, `.nvmrc`, browser versions committed
- [ ] Parallelization configured (workers, sharding)
- [ ] Projects defined for cross-browser/device testing (if needed)
- [ ] CI uploads artifacts on failure with 30-day retention

_Source: Playwright book repo, SEON configuration example, Murat testing philosophy (lines 216-271)._
