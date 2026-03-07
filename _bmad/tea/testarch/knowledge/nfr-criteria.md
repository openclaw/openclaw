# Non-Functional Requirements (NFR) Criteria

## Principle

Non-functional requirements (security, performance, reliability, maintainability) are **validated through automated tests**, not checklists. NFR assessment uses objective pass/fail criteria tied to measurable thresholds. Ambiguous requirements default to CONCERNS until clarified.

## Rationale

**The Problem**: Teams ship features that "work" functionally but fail under load, expose security vulnerabilities, or lack error recovery. NFRs are treated as optional "nice-to-haves" instead of release blockers.

**The Solution**: Define explicit NFR criteria with automated validation. Security tests verify auth/authz and secret handling. Performance tests enforce SLO/SLA thresholds with profiling evidence. Reliability tests validate error handling, retries, and health checks. Maintainability is measured by test coverage, code duplication, and observability.

**Why This Matters**:

- Prevents production incidents (security breaches, performance degradation, cascading failures)
- Provides objective release criteria (no subjective "feels fast enough")
- Automates compliance validation (audit trail for regulated environments)
- Forces clarity on ambiguous requirements (default to CONCERNS)

## Pattern Examples

### Example 1: Security NFR Validation (Auth, Secrets, OWASP)

**Context**: Automated security tests enforcing authentication, authorization, and secret handling

**Implementation**:

```typescript
// tests/nfr/security.spec.ts
import { test, expect } from "@playwright/test";

test.describe("Security NFR: Authentication & Authorization", () => {
  test("unauthenticated users cannot access protected routes", async ({ page }) => {
    // Attempt to access dashboard without auth
    await page.goto("/dashboard");

    // Should redirect to login (not expose data)
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText("Please sign in")).toBeVisible();

    // Verify no sensitive data leaked in response
    const pageContent = await page.content();
    expect(pageContent).not.toContain("user_id");
    expect(pageContent).not.toContain("api_key");
  });

  test("JWT tokens expire after 15 minutes", async ({ page, request }) => {
    // Login and capture token
    await page.goto("/login");
    await page.getByLabel("Email").fill("test@example.com");
    await page.getByLabel("Password").fill("ValidPass123!");
    await page.getByRole("button", { name: "Sign In" }).click();

    const token = await page.evaluate(() => localStorage.getItem("auth_token"));
    expect(token).toBeTruthy();

    // Wait 16 minutes (use mock clock in real tests)
    await page.clock.fastForward("00:16:00");

    // Token should be expired, API call should fail
    const response = await request.get("/api/user/profile", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body.error).toContain("expired");
  });

  test("passwords are never logged or exposed in errors", async ({ page }) => {
    // Trigger login error
    await page.goto("/login");
    await page.getByLabel("Email").fill("test@example.com");
    await page.getByLabel("Password").fill("WrongPassword123!");

    // Monitor console for password leaks
    const consoleLogs: string[] = [];
    page.on("console", (msg) => consoleLogs.push(msg.text()));

    await page.getByRole("button", { name: "Sign In" }).click();

    // Error shown to user (generic message)
    await expect(page.getByText("Invalid credentials")).toBeVisible();

    // Verify password NEVER appears in console, DOM, or network
    const pageContent = await page.content();
    expect(pageContent).not.toContain("WrongPassword123!");
    expect(consoleLogs.join("\n")).not.toContain("WrongPassword123!");
  });

  test("RBAC: users can only access resources they own", async ({ page, request }) => {
    // Login as User A
    const userAToken = await login(request, "userA@example.com", "password");

    // Try to access User B's order
    const response = await request.get("/api/orders/user-b-order-id", {
      headers: { Authorization: `Bearer ${userAToken}` },
    });

    expect(response.status()).toBe(403); // Forbidden
    const body = await response.json();
    expect(body.error).toContain("insufficient permissions");
  });

  test("SQL injection attempts are blocked", async ({ page }) => {
    await page.goto("/search");

    // Attempt SQL injection
    await page.getByPlaceholder("Search products").fill("'; DROP TABLE users; --");
    await page.getByRole("button", { name: "Search" }).click();

    // Should return empty results, NOT crash or expose error
    await expect(page.getByText("No results found")).toBeVisible();

    // Verify app still works (table not dropped)
    await page.goto("/dashboard");
    await expect(page.getByText("Welcome")).toBeVisible();
  });

  test("XSS attempts are sanitized", async ({ page }) => {
    await page.goto("/profile/edit");

    // Attempt XSS injection
    const xssPayload = '<script>alert("XSS")</script>';
    await page.getByLabel("Bio").fill(xssPayload);
    await page.getByRole("button", { name: "Save" }).click();

    // Reload and verify XSS is escaped (not executed)
    await page.reload();
    const bio = await page.getByTestId("user-bio").textContent();

    // Text should be escaped, script should NOT execute
    expect(bio).toContain("&lt;script&gt;");
    expect(bio).not.toContain("<script>");
  });
});

// Helper
async function login(request: any, email: string, password: string): Promise<string> {
  const response = await request.post("/api/auth/login", {
    data: { email, password },
  });
  const body = await response.json();
  return body.token;
}
```

**Key Points**:

- Authentication: Unauthenticated access redirected (not exposed)
- Authorization: RBAC enforced (403 for insufficient permissions)
- Token expiry: JWT expires after 15 minutes (automated validation)
- Secret handling: Passwords never logged or exposed in errors
- OWASP Top 10: SQL injection and XSS blocked (input sanitization)

**Security NFR Criteria**:

- ✅ PASS: All 6 tests green (auth, authz, token expiry, secret handling, SQL injection, XSS)
- ⚠️ CONCERNS: 1-2 tests failing with mitigation plan and owner assigned
- ❌ FAIL: Critical exposure (unauthenticated access, password leak, SQL injection succeeds)

---

### Example 2: Performance NFR Validation (k6 Load Testing for SLO/SLA)

**Context**: Use k6 for load testing, stress testing, and SLO/SLA enforcement (NOT Playwright)

**Implementation**:

```javascript
// tests/nfr/performance.k6.js
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

// Custom metrics
const errorRate = new Rate("errors");
const apiDuration = new Trend("api_duration");

// Performance thresholds (SLO/SLA)
export const options = {
  stages: [
    { duration: "1m", target: 50 }, // Ramp up to 50 users
    { duration: "3m", target: 50 }, // Stay at 50 users for 3 minutes
    { duration: "1m", target: 100 }, // Spike to 100 users
    { duration: "3m", target: 100 }, // Stay at 100 users
    { duration: "1m", target: 0 }, // Ramp down
  ],
  thresholds: {
    // SLO: 95% of requests must complete in <500ms
    http_req_duration: ["p(95)<500"],
    // SLO: Error rate must be <1%
    errors: ["rate<0.01"],
    // SLA: API endpoints must respond in <1s (99th percentile)
    api_duration: ["p(99)<1000"],
  },
};

export default function () {
  // Test 1: Homepage load performance
  const homepageResponse = http.get(`${__ENV.BASE_URL}/`);
  check(homepageResponse, {
    "homepage status is 200": (r) => r.status === 200,
    "homepage loads in <2s": (r) => r.timings.duration < 2000,
  });
  errorRate.add(homepageResponse.status !== 200);

  // Test 2: API endpoint performance
  const apiResponse = http.get(`${__ENV.BASE_URL}/api/products?limit=10`, {
    headers: { Authorization: `Bearer ${__ENV.API_TOKEN}` },
  });
  check(apiResponse, {
    "API status is 200": (r) => r.status === 200,
    "API responds in <500ms": (r) => r.timings.duration < 500,
  });
  apiDuration.add(apiResponse.timings.duration);
  errorRate.add(apiResponse.status !== 200);

  // Test 3: Search endpoint under load
  const searchResponse = http.get(`${__ENV.BASE_URL}/api/search?q=laptop&limit=100`);
  check(searchResponse, {
    "search status is 200": (r) => r.status === 200,
    "search responds in <1s": (r) => r.timings.duration < 1000,
    "search returns results": (r) => JSON.parse(r.body).results.length > 0,
  });
  errorRate.add(searchResponse.status !== 200);

  sleep(1); // Realistic user think time
}

// Threshold validation (run after test)
export function handleSummary(data) {
  const p95Duration = data.metrics.http_req_duration.values["p(95)"];
  const p99ApiDuration = data.metrics.api_duration.values["p(99)"];
  const errorRateValue = data.metrics.errors.values.rate;

  console.log(`P95 request duration: ${p95Duration.toFixed(2)}ms`);
  console.log(`P99 API duration: ${p99ApiDuration.toFixed(2)}ms`);
  console.log(`Error rate: ${(errorRateValue * 100).toFixed(2)}%`);

  return {
    "summary.json": JSON.stringify(data),
    stdout: `
Performance NFR Results:
- P95 request duration: ${p95Duration < 500 ? "✅ PASS" : "❌ FAIL"} (${p95Duration.toFixed(2)}ms / 500ms threshold)
- P99 API duration: ${p99ApiDuration < 1000 ? "✅ PASS" : "❌ FAIL"} (${p99ApiDuration.toFixed(2)}ms / 1000ms threshold)
- Error rate: ${errorRateValue < 0.01 ? "✅ PASS" : "❌ FAIL"} (${(errorRateValue * 100).toFixed(2)}% / 1% threshold)
    `,
  };
}
```

**Run k6 tests:**

```bash
# Local smoke test (10 VUs, 30s)
k6 run --vus 10 --duration 30s tests/nfr/performance.k6.js

# Full load test (stages defined in script)
k6 run tests/nfr/performance.k6.js

# CI integration with thresholds
k6 run --out json=performance-results.json tests/nfr/performance.k6.js
```

**Key Points**:

- **k6 is the right tool** for load testing (NOT Playwright)
- SLO/SLA thresholds enforced automatically (`p(95)<500`, `rate<0.01`)
- Realistic load simulation (ramp up, sustained load, spike testing)
- Comprehensive metrics (p50, p95, p99, error rate, throughput)
- CI-friendly (JSON output, exit codes based on thresholds)

**Performance NFR Criteria**:

- ✅ PASS: All SLO/SLA targets met with k6 profiling evidence (p95 < 500ms, error rate < 1%)
- ⚠️ CONCERNS: Trending toward limits (e.g., p95 = 480ms approaching 500ms) or missing baselines
- ❌ FAIL: SLO/SLA breached (e.g., p95 > 500ms) or error rate > 1%

**Performance Testing Levels (from Test Architect course):**

- **Load testing**: System behavior under expected load
- **Stress testing**: System behavior under extreme load (breaking point)
- **Spike testing**: Sudden load increases (traffic spikes)
- **Endurance/Soak testing**: System behavior under sustained load (memory leaks, resource exhaustion)
- **Benchmarking**: Baseline measurements for comparison

**Note**: Playwright can validate **perceived performance** (Core Web Vitals via Lighthouse), but k6 validates **system performance** (throughput, latency, resource limits under load)

---

### Example 3: Reliability NFR Validation (Playwright for UI Resilience)

**Context**: Automated reliability tests validating graceful degradation and recovery paths

**Implementation**:

```typescript
// tests/nfr/reliability.spec.ts
import { test, expect } from "@playwright/test";

test.describe("Reliability NFR: Error Handling & Recovery", () => {
  test("app remains functional when API returns 500 error", async ({ page, context }) => {
    // Mock API failure
    await context.route("**/api/products", (route) => {
      route.fulfill({ status: 500, body: JSON.stringify({ error: "Internal Server Error" }) });
    });

    await page.goto("/products");

    // User sees error message (not blank page or crash)
    await expect(page.getByText("Unable to load products. Please try again.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

    // App navigation still works (graceful degradation)
    await page.getByRole("link", { name: "Home" }).click();
    await expect(page).toHaveURL("/");
  });

  test("API client retries on transient failures (3 attempts)", async ({ page, context }) => {
    let attemptCount = 0;

    await context.route("**/api/checkout", (route) => {
      attemptCount++;

      // Fail first 2 attempts, succeed on 3rd
      if (attemptCount < 3) {
        route.fulfill({ status: 503, body: JSON.stringify({ error: "Service Unavailable" }) });
      } else {
        route.fulfill({ status: 200, body: JSON.stringify({ orderId: "12345" }) });
      }
    });

    await page.goto("/checkout");
    await page.getByRole("button", { name: "Place Order" }).click();

    // Should succeed after 3 attempts
    await expect(page.getByText("Order placed successfully")).toBeVisible();
    expect(attemptCount).toBe(3);
  });

  test("app handles network disconnection gracefully", async ({ page, context }) => {
    await page.goto("/dashboard");

    // Simulate offline mode
    await context.setOffline(true);

    // Trigger action requiring network
    await page.getByRole("button", { name: "Refresh Data" }).click();

    // User sees offline indicator (not crash)
    await expect(
      page.getByText("You are offline. Changes will sync when reconnected."),
    ).toBeVisible();

    // Reconnect
    await context.setOffline(false);
    await page.getByRole("button", { name: "Refresh Data" }).click();

    // Data loads successfully
    await expect(page.getByText("Data updated")).toBeVisible();
  });

  test("health check endpoint returns service status", async ({ request }) => {
    const response = await request.get("/api/health");

    expect(response.status()).toBe(200);

    const health = await response.json();
    expect(health).toHaveProperty("status", "healthy");
    expect(health).toHaveProperty("timestamp");
    expect(health).toHaveProperty("services");

    // Verify critical services are monitored
    expect(health.services).toHaveProperty("database");
    expect(health.services).toHaveProperty("cache");
    expect(health.services).toHaveProperty("queue");

    // All services should be UP
    expect(health.services.database.status).toBe("UP");
    expect(health.services.cache.status).toBe("UP");
    expect(health.services.queue.status).toBe("UP");
  });

  test("circuit breaker opens after 5 consecutive failures", async ({ page, context }) => {
    let failureCount = 0;

    await context.route("**/api/recommendations", (route) => {
      failureCount++;
      route.fulfill({ status: 500, body: JSON.stringify({ error: "Service Error" }) });
    });

    await page.goto("/product/123");

    // Wait for circuit breaker to open (fallback UI appears)
    await expect(page.getByText("Recommendations temporarily unavailable")).toBeVisible({
      timeout: 10000,
    });

    // Verify circuit breaker stopped making requests after threshold (should be ≤5)
    expect(failureCount).toBeLessThanOrEqual(5);
  });

  test("rate limiting gracefully handles 429 responses", async ({ page, context }) => {
    let requestCount = 0;

    await context.route("**/api/search", (route) => {
      requestCount++;

      if (requestCount > 10) {
        // Rate limit exceeded
        route.fulfill({
          status: 429,
          headers: { "Retry-After": "5" },
          body: JSON.stringify({ error: "Rate limit exceeded" }),
        });
      } else {
        route.fulfill({ status: 200, body: JSON.stringify({ results: [] }) });
      }
    });

    await page.goto("/search");

    // Make 15 search requests rapidly
    for (let i = 0; i < 15; i++) {
      await page.getByPlaceholder("Search").fill(`query-${i}`);
      await page.getByRole("button", { name: "Search" }).click();
    }

    // User sees rate limit message (not crash)
    await expect(page.getByText("Too many requests. Please wait a moment.")).toBeVisible();
  });
});
```

**Key Points**:

- Error handling: Graceful degradation (500 error → user-friendly message + retry button)
- Retries: 3 attempts on transient failures (503 → eventual success)
- Offline handling: Network disconnection detected (sync when reconnected)
- Health checks: `/api/health` monitors database, cache, queue
- Circuit breaker: Opens after 5 failures (fallback UI, stop retries)
- Rate limiting: 429 response handled (Retry-After header respected)

**Reliability NFR Criteria**:

- ✅ PASS: Error handling, retries, health checks verified (all 6 tests green)
- ⚠️ CONCERNS: Partial coverage (e.g., missing circuit breaker) or no telemetry
- ❌ FAIL: No recovery path (500 error crashes app) or unresolved crash scenarios

---

### Example 4: Maintainability NFR Validation (CI Tools, Not Playwright)

**Context**: Use proper CI tools for code quality validation (coverage, duplication, vulnerabilities)

**Implementation**:

```yaml
# .github/workflows/nfr-maintainability.yml
name: NFR - Maintainability

on: [push, pull_request]

jobs:
  test-coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4

      - name: Install dependencies
        run: npm ci

      - name: Run tests with coverage
        run: npm run test:coverage

      - name: Check coverage threshold (80% minimum)
        run: |
          COVERAGE=$(jq '.total.lines.pct' coverage/coverage-summary.json)
          echo "Coverage: $COVERAGE%"
          if (( $(echo "$COVERAGE < 80" | bc -l) )); then
            echo "❌ FAIL: Coverage $COVERAGE% below 80% threshold"
            exit 1
          else
            echo "✅ PASS: Coverage $COVERAGE% meets 80% threshold"
          fi

  code-duplication:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4

      - name: Check code duplication (<5% allowed)
        run: |
          npx jscpd src/ --threshold 5 --format json --output duplication.json
          DUPLICATION=$(jq '.statistics.total.percentage' duplication.json)
          echo "Duplication: $DUPLICATION%"
          if (( $(echo "$DUPLICATION >= 5" | bc -l) )); then
            echo "❌ FAIL: Duplication $DUPLICATION% exceeds 5% threshold"
            exit 1
          else
            echo "✅ PASS: Duplication $DUPLICATION% below 5% threshold"
          fi

  vulnerability-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4

      - name: Install dependencies
        run: npm ci

      - name: Run npm audit (no critical/high vulnerabilities)
        run: |
          npm audit --json > audit.json || true
          CRITICAL=$(jq '.metadata.vulnerabilities.critical' audit.json)
          HIGH=$(jq '.metadata.vulnerabilities.high' audit.json)
          echo "Critical: $CRITICAL, High: $HIGH"
          if [ "$CRITICAL" -gt 0 ] || [ "$HIGH" -gt 0 ]; then
            echo "❌ FAIL: Found $CRITICAL critical and $HIGH high vulnerabilities"
            npm audit
            exit 1
          else
            echo "✅ PASS: No critical/high vulnerabilities"
          fi
```

**Playwright Tests for Observability (E2E Validation):**

```typescript
// tests/nfr/observability.spec.ts
import { test, expect } from "@playwright/test";

test.describe("Maintainability NFR: Observability Validation", () => {
  test("critical errors are reported to monitoring service", async ({ page, context }) => {
    const sentryEvents: any[] = [];

    // Mock Sentry SDK to verify error tracking
    await context.addInitScript(() => {
      (window as any).Sentry = {
        captureException: (error: Error) => {
          console.log(
            "SENTRY_CAPTURE:",
            JSON.stringify({ message: error.message, stack: error.stack }),
          );
        },
      };
    });

    page.on("console", (msg) => {
      if (msg.text().includes("SENTRY_CAPTURE:")) {
        sentryEvents.push(JSON.parse(msg.text().replace("SENTRY_CAPTURE:", "")));
      }
    });

    // Trigger error by mocking API failure
    await context.route("**/api/products", (route) => {
      route.fulfill({ status: 500, body: JSON.stringify({ error: "Database Error" }) });
    });

    await page.goto("/products");

    // Wait for error UI and Sentry capture
    await expect(page.getByText("Unable to load products")).toBeVisible();

    // Verify error was captured by monitoring
    expect(sentryEvents.length).toBeGreaterThan(0);
    expect(sentryEvents[0]).toHaveProperty("message");
    expect(sentryEvents[0]).toHaveProperty("stack");
  });

  test("API response times are tracked in telemetry", async ({ request }) => {
    const response = await request.get("/api/products?limit=10");

    expect(response.ok()).toBeTruthy();

    // Verify Server-Timing header for APM (Application Performance Monitoring)
    const serverTiming = response.headers()["server-timing"];

    expect(serverTiming).toBeTruthy();
    expect(serverTiming).toContain("db"); // Database query time
    expect(serverTiming).toContain("total"); // Total processing time
  });

  test("structured logging present in application", async ({ request }) => {
    // Make API call that generates logs
    const response = await request.post("/api/orders", {
      data: { productId: "123", quantity: 2 },
    });

    expect(response.ok()).toBeTruthy();

    // Note: In real scenarios, validate logs in monitoring system (Datadog, CloudWatch)
    // This test validates the logging contract exists (Server-Timing, trace IDs in headers)
    const traceId = response.headers()["x-trace-id"];
    expect(traceId).toBeTruthy(); // Confirms structured logging with correlation IDs
  });
});
```

**Key Points**:

- **Coverage/duplication**: CI jobs (GitHub Actions), not Playwright tests
- **Vulnerability scanning**: npm audit in CI, not Playwright tests
- **Observability**: Playwright validates error tracking (Sentry) and telemetry headers
- **Structured logging**: Validate logging contract (trace IDs, Server-Timing headers)
- **Separation of concerns**: Build-time checks (coverage, audit) vs runtime checks (error tracking, telemetry)

**Maintainability NFR Criteria**:

- ✅ PASS: Clean code (80%+ coverage from CI, <5% duplication from CI), observability validated in E2E, no critical vulnerabilities from npm audit
- ⚠️ CONCERNS: Duplication >5%, coverage 60-79%, or unclear ownership
- ❌ FAIL: Absent tests (<60%), tangled implementations (>10% duplication), or no observability

---

## NFR Assessment Checklist

Before release gate:

- [ ] **Security** (Playwright E2E + Security Tools):
  - [ ] Auth/authz tests green (unauthenticated redirect, RBAC enforced)
  - [ ] Secrets never logged or exposed in errors
  - [ ] OWASP Top 10 validated (SQL injection blocked, XSS sanitized)
  - [ ] Security audit completed (vulnerability scan, penetration test if applicable)

- [ ] **Performance** (k6 Load Testing):
  - [ ] SLO/SLA targets met with k6 evidence (p95 <500ms, error rate <1%)
  - [ ] Load testing completed (expected load)
  - [ ] Stress testing completed (breaking point identified)
  - [ ] Spike testing completed (handles traffic spikes)
  - [ ] Endurance testing completed (no memory leaks under sustained load)

- [ ] **Reliability** (Playwright E2E + API Tests):
  - [ ] Error handling graceful (500 → user-friendly message + retry)
  - [ ] Retries implemented (3 attempts on transient failures)
  - [ ] Health checks monitored (/api/health endpoint)
  - [ ] Circuit breaker tested (opens after failure threshold)
  - [ ] Offline handling validated (network disconnection graceful)

- [ ] **Maintainability** (CI Tools):
  - [ ] Test coverage ≥80% (from CI coverage report)
  - [ ] Code duplication <5% (from jscpd CI job)
  - [ ] No critical/high vulnerabilities (from npm audit CI job)
  - [ ] Structured logging validated (Playwright validates telemetry headers)
  - [ ] Error tracking configured (Sentry/monitoring integration validated)

- [ ] **Ambiguous requirements**: Default to CONCERNS (force team to clarify thresholds and evidence)
- [ ] **NFR criteria documented**: Measurable thresholds defined (not subjective "fast enough")
- [ ] **Automated validation**: NFR tests run in CI pipeline (not manual checklists)
- [ ] **Tool selection**: Right tool for each NFR (k6 for performance, Playwright for security/reliability E2E, CI tools for maintainability)

## NFR Gate Decision Matrix

| Category            | PASS Criteria                                | CONCERNS Criteria                            | FAIL Criteria                                  |
| ------------------- | -------------------------------------------- | -------------------------------------------- | ---------------------------------------------- |
| **Security**        | Auth/authz, secret handling, OWASP verified  | Minor gaps with clear owners                 | Critical exposure or missing controls          |
| **Performance**     | Metrics meet SLO/SLA with profiling evidence | Trending toward limits or missing baselines  | SLO/SLA breached or resource leaks detected    |
| **Reliability**     | Error handling, retries, health checks OK    | Partial coverage or missing telemetry        | No recovery path or unresolved crash scenarios |
| **Maintainability** | Clean code, tests, docs shipped together     | Duplication, low coverage, unclear ownership | Absent tests, tangled code, no observability   |

**Default**: If targets or evidence are undefined → **CONCERNS** (force team to clarify before sign-off)

## Integration Points

- **Used in workflows**: `*nfr-assess` (automated NFR validation), `*trace` (gate decision Phase 2), `*test-design` (NFR risk assessment via Utility Tree)
- **Related fragments**: `risk-governance.md` (NFR risk scoring), `probability-impact.md` (NFR impact assessment), `test-quality.md` (maintainability standards), `test-levels-framework.md` (system-level testing for NFRs)
- **Tools by NFR Category**:
  - **Security**: Playwright (E2E auth/authz), OWASP ZAP, Burp Suite, npm audit, Snyk
  - **Performance**: k6 (load/stress/spike/endurance), Lighthouse (Core Web Vitals), Artillery
  - **Reliability**: Playwright (E2E error handling), API tests (retries, health checks), Chaos Engineering tools
  - **Maintainability**: GitHub Actions (coverage, duplication, audit), jscpd, Playwright (observability validation)

_Source: Test Architect course (NFR testing approaches, Utility Tree, Quality Scenarios), ISO/IEC 25010 Software Quality Characteristics, OWASP Top 10, k6 documentation, SRE practices_
