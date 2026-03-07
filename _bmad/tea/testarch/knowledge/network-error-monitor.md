# Network Error Monitor

## Principle

Automatically detect and fail tests when HTTP 4xx/5xx errors occur during execution. Act like Sentry for tests - catch silent backend failures even when UI passes assertions.

## Rationale

Traditional Playwright tests focus on UI:

- Backend 500 errors ignored if UI looks correct
- Silent failures slip through
- No visibility into background API health
- Tests pass while features are broken

The `network-error-monitor` provides:

- **Automatic detection**: All HTTP 4xx/5xx responses tracked
- **Test failures**: Fail tests with backend errors (even if UI passes)
- **Structured artifacts**: JSON reports with error details
- **Smart opt-out**: Disable for validation tests expecting errors
- **Deduplication**: Group repeated errors by pattern
- **Domino effect prevention**: Limit test failures per error pattern
- **Respects test status**: Won't suppress actual test failures

## Quick Start

```typescript
import { test } from "@seontechnologies/playwright-utils/network-error-monitor/fixtures";

// That's it! Network monitoring is automatically enabled
test("my test", async ({ page }) => {
  await page.goto("/dashboard");
  // If any HTTP 4xx/5xx errors occur, the test will fail
});
```

## Pattern Examples

### Example 1: Basic Auto-Monitoring

**Context**: Automatically fail tests when backend errors occur.

**Implementation**:

```typescript
import { test } from "@seontechnologies/playwright-utils/network-error-monitor/fixtures";

// Monitoring automatically enabled
test("should load dashboard", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.locator("h1")).toContainText("Dashboard");

  // Passes if no HTTP errors
  // Fails if any 4xx/5xx errors detected with clear message:
  //    "Network errors detected: 2 request(s) failed"
  //    Failed requests:
  //      GET 500 https://api.example.com/users
  //      POST 503 https://api.example.com/metrics
});
```

**Key Points**:

- Zero setup - auto-enabled for all tests
- Fails on any 4xx/5xx response
- Structured error message with URLs and status codes
- JSON artifact attached to test report

### Example 2: Opt-Out for Validation Tests

**Context**: Some tests expect errors (validation, error handling, edge cases).

**Implementation**:

```typescript
import { test } from "@seontechnologies/playwright-utils/network-error-monitor/fixtures";

// Opt-out with annotation
test(
  "should show error on invalid input",
  { annotation: [{ type: "skipNetworkMonitoring" }] },
  async ({ page }) => {
    await page.goto("/form");
    await page.click("#submit"); // Triggers 400 error

    // Monitoring disabled - test won't fail on 400
    await expect(page.getByText("Invalid input")).toBeVisible();
  },
);

// Or opt-out entire describe block
test.describe("error handling", { annotation: [{ type: "skipNetworkMonitoring" }] }, () => {
  test("handles 404", async ({ page }) => {
    // All tests in this block skip monitoring
  });

  test("handles 500", async ({ page }) => {
    // Monitoring disabled
  });
});
```

**Key Points**:

- Use annotation `{ type: 'skipNetworkMonitoring' }`
- Can opt-out single test or entire describe block
- Monitoring still active for other tests
- Perfect for intentional error scenarios

### Example 3: Respects Test Status

**Context**: The monitor respects final test statuses to avoid suppressing important test outcomes.

**Behavior by test status:**

- **`failed`**: Network errors logged as additional context, not thrown
- **`timedOut`**: Network errors logged as additional context
- **`skipped`**: Network errors logged, skip status preserved
- **`interrupted`**: Network errors logged, interrupted status preserved
- **`passed`**: Network errors throw and fail the test

**Example with test.skip():**

```typescript
test("feature gated test", async ({ page }) => {
  const featureEnabled = await checkFeatureFlag();
  test.skip(!featureEnabled, "Feature not enabled");
  // If skipped, network errors won't turn this into a failure
  await page.goto("/new-feature");
});
```

### Example 4: Excluding Legitimate Errors

**Context**: Some endpoints legitimately return 4xx/5xx responses.

**Implementation**:

```typescript
import { test as base } from "@playwright/test";
import { createNetworkErrorMonitorFixture } from "@seontechnologies/playwright-utils/network-error-monitor/fixtures";

export const test = base.extend(
  createNetworkErrorMonitorFixture({
    excludePatterns: [
      /email-cluster\/ml-app\/has-active-run/, // ML service returns 404 when no active run
      /idv\/session-templates\/list/, // IDV service returns 404 when not configured
      /sentry\.io\/api/, // External Sentry errors should not fail tests
    ],
  }),
);
```

**For merged fixtures:**

```typescript
import { test as base, mergeTests } from "@playwright/test";
import { createNetworkErrorMonitorFixture } from "@seontechnologies/playwright-utils/network-error-monitor/fixtures";

const networkErrorMonitor = base.extend(
  createNetworkErrorMonitorFixture({
    excludePatterns: [/analytics\.google\.com/, /cdn\.example\.com/],
  }),
);

export const test = mergeTests(authFixture, networkErrorMonitor);
```

### Example 5: Preventing Domino Effect

**Context**: One failing endpoint shouldn't fail all tests.

**Implementation**:

```typescript
import { test as base } from "@playwright/test";
import { createNetworkErrorMonitorFixture } from "@seontechnologies/playwright-utils/network-error-monitor/fixtures";

const networkErrorMonitor = base.extend(
  createNetworkErrorMonitorFixture({
    excludePatterns: [], // Required when using maxTestsPerError
    maxTestsPerError: 1, // Only first test fails per error pattern, rest just log
  }),
);
```

**How it works:**

When `/api/v2/case-management/cases` returns 500:

- **First test** encountering this error: **FAILS** with clear error message
- **Subsequent tests** encountering same error: **PASSES** but logs warning

Error patterns are grouped by `method + status + base path`:

- `GET /api/v2/case-management/cases/123` -> Pattern: `GET:500:/api/v2/case-management`
- `GET /api/v2/case-management/quota` -> Pattern: `GET:500:/api/v2/case-management` (same group!)
- `POST /api/v2/case-management/cases` -> Pattern: `POST:500:/api/v2/case-management` (different group!)

**Why include HTTP method?** A GET 404 vs POST 404 might represent different issues:

- `GET 404 /api/users/123` -> User not found (expected in some tests)
- `POST 404 /api/users` -> Endpoint doesn't exist (critical error)

**Output for subsequent tests:**

```
Warning: Network errors detected but not failing test (maxTestsPerError limit reached):
  GET 500 https://api.example.com/api/v2/case-management/cases
```

**Recommended configuration:**

```typescript
createNetworkErrorMonitorFixture({
  excludePatterns: [...], // Required - known broken endpoints (can be empty [])
  maxTestsPerError: 1     // Stop domino effect (requires excludePatterns)
})
```

**Understanding worker-level state:**

Error pattern counts are stored in worker-level global state:

```typescript
// test-file-1.spec.ts (runs in Worker 1)
test("test A", () => {
  /* triggers GET:500:/api/v2/cases */
}); // FAILS

// test-file-2.spec.ts (runs later in Worker 1)
test("test B", () => {
  /* triggers GET:500:/api/v2/cases */
}); // PASSES (limit reached)

// test-file-3.spec.ts (runs in Worker 2 - different worker)
test("test C", () => {
  /* triggers GET:500:/api/v2/cases */
}); // FAILS (fresh worker)
```

### Example 6: Integration with Merged Fixtures

**Context**: Combine network-error-monitor with other utilities.

**Implementation**:

```typescript
// playwright/support/merged-fixtures.ts
import { mergeTests } from "@playwright/test";
import { test as authFixture } from "@seontechnologies/playwright-utils/auth-session/fixtures";
import { test as networkErrorMonitorFixture } from "@seontechnologies/playwright-utils/network-error-monitor/fixtures";

export const test = mergeTests(
  authFixture,
  networkErrorMonitorFixture,
  // Add other fixtures
);

// In tests
import { test, expect } from "../support/merged-fixtures";

test("authenticated with monitoring", async ({ page, authToken }) => {
  // Both auth and network monitoring active
  await page.goto("/protected");

  // Fails if backend returns errors during auth flow
});
```

**Key Points**:

- Combine with `mergeTests`
- Works alongside all other utilities
- Monitoring active automatically
- No extra setup needed

### Example 7: Artifact Structure

**Context**: Debugging failed tests with network error artifacts.

When test fails due to network errors, artifact attached:

```json
[
  {
    "url": "https://api.example.com/users",
    "status": 500,
    "method": "GET",
    "timestamp": "2025-11-10T12:34:56.789Z"
  },
  {
    "url": "https://api.example.com/metrics",
    "status": 503,
    "method": "POST",
    "timestamp": "2025-11-10T12:34:57.123Z"
  }
]
```

## Implementation Details

### How It Works

1. **Fixture Extension**: Uses Playwright's `base.extend()` with `auto: true`
2. **Response Listener**: Attaches `page.on('response')` listener at test start
3. **Multi-Page Monitoring**: Automatically monitors popups and new tabs via `context.on('page')`
4. **Error Collection**: Captures 4xx/5xx responses, checking exclusion patterns
5. **Try/Finally**: Ensures error processing runs even if test fails early
6. **Status Check**: Only throws errors if test hasn't already reached final status
7. **Artifact**: Attaches JSON file to test report for debugging

### Performance

The monitor has minimal performance impact:

- Event listener overhead: ~0.1ms per response
- Memory: ~200 bytes per unique error
- No network delay (observes responses, doesn't intercept them)

## Comparison with Alternatives

| Approach                    | Network Error Monitor | Manual afterEach      |
| --------------------------- | --------------------- | --------------------- |
| **Setup Required**          | Zero (auto-enabled)   | Every test file       |
| **Catches Silent Failures** | Yes                   | Yes (if configured)   |
| **Structured Artifacts**    | JSON attached         | Custom impl           |
| **Test Failure Safety**     | Try/finally           | afterEach may not run |
| **Opt-Out Mechanism**       | Annotation            | Custom logic          |
| **Status Aware**            | Respects skip/failed  | No                    |

## When to Use

**Auto-enabled for:**

- All E2E tests
- Integration tests
- Any test hitting real APIs

**Opt-out for:**

- Validation tests (expecting 4xx)
- Error handling tests (expecting 5xx)
- Offline tests (network-recorder playback)

## Troubleshooting

### Test fails with network errors but I don't see them in my app

The errors might be happening during page load or in background polling. Check the `network-errors.json` artifact in your test report for full details including timestamps.

### False positives from external services

Configure exclusion patterns as shown in the "Excluding Legitimate Errors" section above.

### Network errors not being caught

Ensure you're importing the test from the correct fixture:

```typescript
// Correct
import { test } from "@seontechnologies/playwright-utils/network-error-monitor/fixtures";

// Wrong - this won't have network monitoring
import { test } from "@playwright/test";
```

## Related Fragments

- `overview.md` - Installation and fixtures
- `fixtures-composition.md` - Merging with other utilities
- `error-handling.md` - Traditional error handling patterns

## Anti-Patterns

**DON'T opt out of monitoring globally:**

```typescript
// Every test skips monitoring
test.use({ annotation: [{ type: "skipNetworkMonitoring" }] });
```

**DO opt-out only for specific error tests:**

```typescript
test.describe("error scenarios", { annotation: [{ type: "skipNetworkMonitoring" }] }, () => {
  // Only these tests skip monitoring
});
```

**DON'T ignore network error artifacts:**

```typescript
// Test fails, artifact shows 500 errors
// Developer: "Works on my machine" ¯\_(ツ)_/¯
```

**DO check artifacts for root cause:**

```typescript
// Read network-errors.json artifact
// Identify failing endpoint: GET /api/users -> 500
// Fix backend issue before merging
```
