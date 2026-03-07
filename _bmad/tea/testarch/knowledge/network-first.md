# Network-First Safeguards

## Principle

Register network interceptions **before** any navigation or user action. Store the interception promise and await it immediately after the triggering step. Replace implicit waits with deterministic signals based on network responses, spinner disappearance, or event hooks.

## Rationale

The most common source of flaky E2E tests is **race conditions** between navigation and network interception:

- Navigate then intercept = missed requests (too late)
- No explicit wait = assertion runs before response arrives
- Hard waits (`waitForTimeout(3000)`) = slow, unreliable, brittle

Network-first patterns provide:

- **Zero race conditions**: Intercept is active before triggering action
- **Deterministic waits**: Wait for actual response, not arbitrary timeouts
- **Actionable failures**: Assert on response status/body, not generic "element not found"
- **Speed**: No padding with extra wait time

## Pattern Examples

### Example 1: Intercept Before Navigate Pattern

**Context**: The foundational pattern for all E2E tests. Always register route interception **before** the action that triggers the request (navigation, click, form submit).

**Implementation**:

```typescript
// ✅ CORRECT: Intercept BEFORE navigate
test("user can view dashboard data", async ({ page }) => {
  // Step 1: Register interception FIRST
  const usersPromise = page.waitForResponse(
    (resp) => resp.url().includes("/api/users") && resp.status() === 200,
  );

  // Step 2: THEN trigger the request
  await page.goto("/dashboard");

  // Step 3: THEN await the response
  const usersResponse = await usersPromise;
  const users = await usersResponse.json();

  // Step 4: Assert on structured data
  expect(users).toHaveLength(10);
  await expect(page.getByText(users[0].name)).toBeVisible();
});

// Cypress equivalent
describe("Dashboard", () => {
  it("should display users", () => {
    // Step 1: Register interception FIRST
    cy.intercept("GET", "**/api/users").as("getUsers");

    // Step 2: THEN trigger
    cy.visit("/dashboard");

    // Step 3: THEN await
    cy.wait("@getUsers").then((interception) => {
      // Step 4: Assert on structured data
      expect(interception.response.statusCode).to.equal(200);
      expect(interception.response.body).to.have.length(10);
      cy.contains(interception.response.body[0].name).should("be.visible");
    });
  });
});

// ❌ WRONG: Navigate BEFORE intercept (race condition!)
test("flaky test example", async ({ page }) => {
  await page.goto("/dashboard"); // Request fires immediately

  const usersPromise = page.waitForResponse("/api/users"); // TOO LATE - might miss it
  const response = await usersPromise; // May timeout randomly
});
```

**Key Points**:

- Playwright: Use `page.waitForResponse()` with URL pattern or predicate **before** `page.goto()` or `page.click()`
- Cypress: Use `cy.intercept().as()` **before** `cy.visit()` or `cy.click()`
- Store promise/alias, trigger action, **then** await response
- This prevents 95% of race-condition flakiness in E2E tests

### Example 2: HAR Capture for Debugging

**Context**: When debugging flaky tests or building deterministic mocks, capture real network traffic with HAR files. Replay them in tests for consistent, offline-capable test runs.

**Implementation**:

```typescript
// playwright.config.ts - Enable HAR recording
export default defineConfig({
  use: {
    // Record HAR on first run
    recordHar: { path: "./hars/", mode: "minimal" },
    // Or replay HAR in tests
    // serviceWorkers: 'block',
  },
});

// Capture HAR for specific test
test("capture network for order flow", async ({ page, context }) => {
  // Start recording
  await context.routeFromHAR("./hars/order-flow.har", {
    url: "**/api/**",
    update: true, // Update HAR with new requests
  });

  await page.goto("/checkout");
  await page.fill('[data-testid="credit-card"]', "4111111111111111");
  await page.click('[data-testid="submit-order"]');
  await expect(page.getByText("Order Confirmed")).toBeVisible();

  // HAR saved to ./hars/order-flow.har
});

// Replay HAR for deterministic tests (no real API needed)
test("replay order flow from HAR", async ({ page, context }) => {
  // Replay captured HAR
  await context.routeFromHAR("./hars/order-flow.har", {
    url: "**/api/**",
    update: false, // Read-only mode
  });

  // Test runs with exact recorded responses - fully deterministic
  await page.goto("/checkout");
  await page.fill('[data-testid="credit-card"]', "4111111111111111");
  await page.click('[data-testid="submit-order"]');
  await expect(page.getByText("Order Confirmed")).toBeVisible();
});

// Custom mock based on HAR insights
test("mock order response based on HAR", async ({ page }) => {
  // After analyzing HAR, create focused mock
  await page.route("**/api/orders", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        orderId: "12345",
        status: "confirmed",
        total: 99.99,
      }),
    }),
  );

  await page.goto("/checkout");
  await page.click('[data-testid="submit-order"]');
  await expect(page.getByText("Order #12345")).toBeVisible();
});
```

**Key Points**:

- HAR files capture real request/response pairs for analysis
- `update: true` records new traffic; `update: false` replays existing
- Replay mode makes tests fully deterministic (no upstream API needed)
- Use HAR to understand API contracts, then create focused mocks

### Example 3: Network Stub with Edge Cases

**Context**: When testing error handling, timeouts, and edge cases, stub network responses to simulate failures. Test both happy path and error scenarios.

**Implementation**:

```typescript
// Test happy path
test("order succeeds with valid data", async ({ page }) => {
  await page.route("**/api/orders", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ orderId: "123", status: "confirmed" }),
    }),
  );

  await page.goto("/checkout");
  await page.click('[data-testid="submit-order"]');
  await expect(page.getByText("Order Confirmed")).toBeVisible();
});

// Test 500 error
test("order fails with server error", async ({ page }) => {
  // Listen for console errors (app should log gracefully)
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  // Stub 500 error
  await page.route("**/api/orders", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Internal Server Error" }),
    }),
  );

  await page.goto("/checkout");
  await page.click('[data-testid="submit-order"]');

  // Assert UI shows error gracefully
  await expect(page.getByText("Something went wrong")).toBeVisible();
  await expect(page.getByText("Please try again")).toBeVisible();

  // Verify error logged (not thrown)
  expect(consoleErrors.some((e) => e.includes("Order failed"))).toBeTruthy();
});

// Test network timeout
test("order times out after 10 seconds", async ({ page }) => {
  // Stub delayed response (never resolves within timeout)
  await page.route(
    "**/api/orders",
    (route) => new Promise(() => {}), // Never resolves - simulates timeout
  );

  await page.goto("/checkout");
  await page.click('[data-testid="submit-order"]');

  // App should show timeout message after configured timeout
  await expect(page.getByText("Request timed out")).toBeVisible({ timeout: 15000 });
});

// Test partial data response
test("order handles missing optional fields", async ({ page }) => {
  await page.route("**/api/orders", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      // Missing optional fields like 'trackingNumber', 'estimatedDelivery'
      body: JSON.stringify({ orderId: "123", status: "confirmed" }),
    }),
  );

  await page.goto("/checkout");
  await page.click('[data-testid="submit-order"]');

  // App should handle gracefully - no crash, shows what's available
  await expect(page.getByText("Order Confirmed")).toBeVisible();
  await expect(page.getByText("Tracking information pending")).toBeVisible();
});

// Cypress equivalents
describe("Order Edge Cases", () => {
  it("should handle 500 error", () => {
    cy.intercept("POST", "**/api/orders", {
      statusCode: 500,
      body: { error: "Internal Server Error" },
    }).as("orderFailed");

    cy.visit("/checkout");
    cy.get('[data-testid="submit-order"]').click();
    cy.wait("@orderFailed");
    cy.contains("Something went wrong").should("be.visible");
  });

  it("should handle timeout", () => {
    cy.intercept("POST", "**/api/orders", (req) => {
      req.reply({ delay: 20000 }); // Delay beyond app timeout
    }).as("orderTimeout");

    cy.visit("/checkout");
    cy.get('[data-testid="submit-order"]').click();
    cy.contains("Request timed out", { timeout: 15000 }).should("be.visible");
  });
});
```

**Key Points**:

- Stub different HTTP status codes (200, 400, 500, 503)
- Simulate timeouts with `delay` or non-resolving promises
- Test partial/incomplete data responses
- Verify app handles errors gracefully (no crashes, user-friendly messages)

### Example 4: Deterministic Waiting

**Context**: Never use hard waits (`waitForTimeout(3000)`). Always wait for explicit signals: network responses, element state changes, or custom events.

**Implementation**:

```typescript
// ✅ GOOD: Wait for response with predicate
test("wait for specific response", async ({ page }) => {
  const responsePromise = page.waitForResponse(
    (resp) => resp.url().includes("/api/users") && resp.status() === 200,
  );

  await page.goto("/dashboard");
  const response = await responsePromise;

  expect(response.status()).toBe(200);
  await expect(page.getByText("Dashboard")).toBeVisible();
});

// ✅ GOOD: Wait for multiple responses
test("wait for all required data", async ({ page }) => {
  const usersPromise = page.waitForResponse("**/api/users");
  const productsPromise = page.waitForResponse("**/api/products");
  const ordersPromise = page.waitForResponse("**/api/orders");

  await page.goto("/dashboard");

  // Wait for all in parallel
  const [users, products, orders] = await Promise.all([
    usersPromise,
    productsPromise,
    ordersPromise,
  ]);

  expect(users.status()).toBe(200);
  expect(products.status()).toBe(200);
  expect(orders.status()).toBe(200);
});

// ✅ GOOD: Wait for spinner to disappear
test("wait for loading indicator", async ({ page }) => {
  await page.goto("/dashboard");

  // Wait for spinner to disappear (signals data loaded)
  await expect(page.getByTestId("loading-spinner")).not.toBeVisible();
  await expect(page.getByText("Dashboard")).toBeVisible();
});

// ✅ GOOD: Wait for custom event (advanced)
test("wait for custom ready event", async ({ page }) => {
  let appReady = false;
  page.on("console", (msg) => {
    if (msg.text() === "App ready") appReady = true;
  });

  await page.goto("/dashboard");

  // Poll until custom condition met
  await page.waitForFunction(() => appReady, { timeout: 10000 });

  await expect(page.getByText("Dashboard")).toBeVisible();
});

// ❌ BAD: Hard wait (arbitrary timeout)
test("flaky hard wait example", async ({ page }) => {
  await page.goto("/dashboard");
  await page.waitForTimeout(3000); // WHY 3 seconds? What if slower? What if faster?
  await expect(page.getByText("Dashboard")).toBeVisible(); // May fail if >3s
});

// Cypress equivalents
describe("Deterministic Waiting", () => {
  it("should wait for response", () => {
    cy.intercept("GET", "**/api/users").as("getUsers");
    cy.visit("/dashboard");
    cy.wait("@getUsers").its("response.statusCode").should("eq", 200);
    cy.contains("Dashboard").should("be.visible");
  });

  it("should wait for spinner to disappear", () => {
    cy.visit("/dashboard");
    cy.get('[data-testid="loading-spinner"]').should("not.exist");
    cy.contains("Dashboard").should("be.visible");
  });

  // ❌ BAD: Hard wait
  it("flaky hard wait", () => {
    cy.visit("/dashboard");
    cy.wait(3000); // NEVER DO THIS
    cy.contains("Dashboard").should("be.visible");
  });
});
```

**Key Points**:

- `waitForResponse()` with URL pattern or predicate = deterministic
- `waitForLoadState('networkidle')` = wait for all network activity to finish
- Wait for element state changes (spinner disappears, button enabled)
- **NEVER** use `waitForTimeout()` or `cy.wait(ms)` - always non-deterministic

### Example 5: Anti-Pattern - Navigate Then Mock

**Problem**:

```typescript
// ❌ BAD: Race condition - mock registered AFTER navigation starts
test("flaky test - navigate then mock", async ({ page }) => {
  // Navigation starts immediately
  await page.goto("/dashboard"); // Request to /api/users fires NOW

  // Mock registered too late - request already sent
  await page.route("**/api/users", (route) =>
    route.fulfill({
      status: 200,
      body: JSON.stringify([{ id: 1, name: "Test User" }]),
    }),
  );

  // Test randomly passes/fails depending on timing
  await expect(page.getByText("Test User")).toBeVisible(); // Flaky!
});

// ❌ BAD: No wait for response
test("flaky test - no explicit wait", async ({ page }) => {
  await page.route("**/api/users", (route) =>
    route.fulfill({ status: 200, body: JSON.stringify([]) }),
  );

  await page.goto("/dashboard");

  // Assertion runs immediately - may fail if response slow
  await expect(page.getByText("No users found")).toBeVisible(); // Flaky!
});

// ❌ BAD: Generic timeout
test("flaky test - hard wait", async ({ page }) => {
  await page.goto("/dashboard");
  await page.waitForTimeout(2000); // Arbitrary wait - brittle

  await expect(page.getByText("Dashboard")).toBeVisible();
});
```

**Why It Fails**:

- **Mock after navigate**: Request fires during navigation, mock isn't active yet (race condition)
- **No explicit wait**: Assertion runs before response arrives (timing-dependent)
- **Hard waits**: Slow tests, brittle (fails if < timeout, wastes time if > timeout)
- **Non-deterministic**: Passes locally, fails in CI (different speeds)

**Better Approach**: Always intercept → trigger → await

```typescript
// ✅ GOOD: Intercept BEFORE navigate
test("deterministic test", async ({ page }) => {
  // Step 1: Register mock FIRST
  await page.route("**/api/users", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: 1, name: "Test User" }]),
    }),
  );

  // Step 2: Store response promise BEFORE trigger
  const responsePromise = page.waitForResponse("**/api/users");

  // Step 3: THEN trigger
  await page.goto("/dashboard");

  // Step 4: THEN await response
  await responsePromise;

  // Step 5: THEN assert (data is guaranteed loaded)
  await expect(page.getByText("Test User")).toBeVisible();
});
```

**Key Points**:

- Order matters: Mock → Promise → Trigger → Await → Assert
- No race conditions: Mock is active before request fires
- Explicit wait: Response promise ensures data loaded
- Deterministic: Always passes if app works correctly

## Integration Points

- **Used in workflows**: `*atdd` (test generation), `*automate` (test expansion), `*framework` (network setup)
- **Related fragments**:
  - `fixture-architecture.md` - Network fixture patterns
  - `data-factories.md` - API-first setup with network
  - `test-quality.md` - Deterministic test principles

## Debugging Network Issues

When network tests fail, check:

1. **Timing**: Is interception registered **before** action?
2. **URL pattern**: Does pattern match actual request URL?
3. **Response format**: Is mocked response valid JSON/format?
4. **Status code**: Is app checking for 200 vs 201 vs 204?
5. **HAR file**: Capture real traffic to understand actual API contract

```typescript
// Debug network issues with logging
test("debug network", async ({ page }) => {
  // Log all requests
  page.on("request", (req) => console.log("→", req.method(), req.url()));

  // Log all responses
  page.on("response", (resp) => console.log("←", resp.status(), resp.url()));

  await page.goto("/dashboard");
});
```

_Source: Murat Testing Philosophy (lines 94-137), Playwright network patterns, Cypress intercept best practices._
