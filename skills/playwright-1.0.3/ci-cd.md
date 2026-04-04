# CI Success Defaults

## GitHub Actions

```yaml
name: Playwright Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps

      - name: Run tests
        run: npx playwright test

      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 7
```

Use the official Playwright image or install browsers explicitly. Always keep traces and failure artifacts.

## GitLab CI

```yaml
playwright:
  image: mcr.microsoft.com/playwright:v1.40.0-jammy
  stage: test
  script:
    - npm ci
    - npx playwright test
  artifacts:
    when: on_failure
    paths:
      - playwright-report/
    expire_in: 7 days
```

## Docker Setup

```dockerfile
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

CMD ["npx", "playwright", "test"]
```

## When to Add Sharding

```yaml
# GitHub Actions matrix
jobs:
  test:
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - name: Run tests
        run: npx playwright test --shard=${{ matrix.shard }}/4
```

Do not shard a small or unstable suite just to look faster. Add sharding only after the suite is already deterministic.

## playwright.config.ts for CI

```typescript
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI ? [["html"], ["github"]] : [["html"]],

  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "on-first-retry",
  },

  projects: [
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
  ],
});
```

## Caching Browsers

```yaml
# GitHub Actions
- name: Cache Playwright browsers
  uses: actions/cache@v4
  with:
    path: ~/.cache/ms-playwright
    key: playwright-${{ runner.os }}-${{ hashFiles('package-lock.json') }}
```

## Environment Variables

```yaml
env:
  BASE_URL: https://staging.example.com
  CI: true
```

```typescript
// playwright.config.ts
use: {
  baseURL: process.env.BASE_URL || 'http://localhost:3000',
}
```

## Flaky Test Management

```typescript
// Mark known flaky test
test(
  "sometimes fails",
  {
    annotation: { type: "flaky", description: "Network timing issue" },
  },
  async ({ page }) => {
    // test code
  },
);

// Retry configuration
export default defineConfig({
  retries: 2,
  expect: {
    timeout: 10000,
  },
});
```

## Common CI Issues

| Issue                    | Fix                                            |
| ------------------------ | ---------------------------------------------- |
| Browsers not found       | Use official Playwright Docker image           |
| Display errors           | Headless mode or `xvfb-run`                    |
| Out of memory            | Reduce workers, close contexts                 |
| Timeouts                 | Increase `actionTimeout`, add retries          |
| Inconsistent screenshots | Set fixed viewport, disable animations         |
| Order-dependent failures | Remove shared auth or shared mutable test data |
