# Test Quality Definition of Done

## Principle

Tests must be deterministic, isolated, explicit, focused, and fast. Every test should execute in under 1.5 minutes, contain fewer than 300 lines, avoid hard waits and conditionals, keep assertions visible in test bodies, and clean up after itself for parallel execution.

## Rationale

Quality tests provide reliable signal about application health. Flaky tests erode confidence and waste engineering time. Tests that use hard waits (`waitForTimeout(3000)`) are non-deterministic and slow. Tests with hidden assertions or conditional logic become unmaintainable. Large tests (>300 lines) are hard to understand and debug. Slow tests (>1.5 min) block CI pipelines. Self-cleaning tests prevent state pollution in parallel runs.

## Pattern Examples

### Example 1: Deterministic Test Pattern

**Context**: When writing tests, eliminate all sources of non-determinism: hard waits, conditionals controlling flow, try-catch for flow control, and random data without seeds.

**Implementation**:

```typescript
// ❌ BAD: Non-deterministic test with conditionals and hard waits
test("user can view dashboard - FLAKY", async ({ page }) => {
  await page.goto("/dashboard");
  await page.waitForTimeout(3000); // NEVER - arbitrary wait

  // Conditional flow control - test behavior varies
  if (await page.locator('[data-testid="welcome-banner"]').isVisible()) {
    await page.click('[data-testid="dismiss-banner"]');
    await page.waitForTimeout(500);
  }

  // Try-catch for flow control - hides real issues
  try {
    await page.click('[data-testid="load-more"]');
  } catch (e) {
    // Silently continue - test passes even if button missing
  }

  // Random data without control
  const randomEmail = `user${Math.random()}@example.com`;
  await expect(page.getByText(randomEmail)).toBeVisible(); // Will fail randomly
});

// ✅ GOOD: Deterministic test with explicit waits
test("user can view dashboard", async ({ page, apiRequest }) => {
  const user = createUser({ email: "test@example.com", hasSeenWelcome: true });

  // Setup via API (fast, controlled)
  await apiRequest.post("/api/users", { data: user });

  // Network-first: Intercept BEFORE navigate
  const dashboardPromise = page.waitForResponse(
    (resp) => resp.url().includes("/api/dashboard") && resp.status() === 200,
  );

  await page.goto("/dashboard");

  // Wait for actual response, not arbitrary time
  const dashboardResponse = await dashboardPromise;
  const dashboard = await dashboardResponse.json();

  // Explicit assertions with controlled data
  await expect(page.getByText(`Welcome, ${user.name}`)).toBeVisible();
  await expect(page.getByTestId("dashboard-items")).toHaveCount(dashboard.items.length);

  // No conditionals - test always executes same path
  // No try-catch - failures bubble up clearly
});

// Cypress equivalent
describe("Dashboard", () => {
  it("should display user dashboard", () => {
    const user = createUser({ email: "test@example.com", hasSeenWelcome: true });

    // Setup via task (fast, controlled)
    cy.task("db:seed", { users: [user] });

    // Network-first interception
    cy.intercept("GET", "**/api/dashboard").as("getDashboard");

    cy.visit("/dashboard");

    // Deterministic wait for response
    cy.wait("@getDashboard").then((interception) => {
      const dashboard = interception.response.body;

      // Explicit assertions
      cy.contains(`Welcome, ${user.name}`).should("be.visible");
      cy.get('[data-cy="dashboard-items"]').should("have.length", dashboard.items.length);
    });
  });
});
```

**Key Points**:

- Replace `waitForTimeout()` with `waitForResponse()` or element state checks
- Never use if/else to control test flow - tests should be deterministic
- Avoid try-catch for flow control - let failures bubble up clearly
- Use factory functions with controlled data, not `Math.random()`
- Network-first pattern prevents race conditions

### Example 2: Isolated Test with Cleanup

**Context**: When tests create data, they must clean up after themselves to prevent state pollution in parallel runs. Use fixture auto-cleanup or explicit teardown.

**Implementation**:

```typescript
// ❌ BAD: Test leaves data behind, pollutes other tests
test("admin can create user - POLLUTES STATE", async ({ page, apiRequest }) => {
  await page.goto("/admin/users");

  // Hardcoded email - collides in parallel runs
  await page.fill('[data-testid="email"]', "newuser@example.com");
  await page.fill('[data-testid="name"]', "New User");
  await page.click('[data-testid="create-user"]');

  await expect(page.getByText("User created")).toBeVisible();

  // NO CLEANUP - user remains in database
  // Next test run fails: "Email already exists"
});

// ✅ GOOD: Test cleans up with fixture auto-cleanup
// playwright/support/fixtures/database-fixture.ts
import { test as base } from "@playwright/test";
import { deleteRecord, seedDatabase } from "../helpers/db-helpers";

type DatabaseFixture = {
  seedUser: (userData: Partial<User>) => Promise<User>;
};

export const test = base.extend<DatabaseFixture>({
  seedUser: async ({}, use) => {
    const createdUsers: string[] = [];

    const seedUser = async (userData: Partial<User>) => {
      const user = await seedDatabase("users", userData);
      createdUsers.push(user.id); // Track for cleanup
      return user;
    };

    await use(seedUser);

    // Auto-cleanup: Delete all users created during test
    for (const userId of createdUsers) {
      await deleteRecord("users", userId);
    }
    createdUsers.length = 0;
  },
});

// Use the fixture
test("admin can create user", async ({ page, seedUser }) => {
  // Create admin with unique data
  const admin = await seedUser({
    email: faker.internet.email(), // Unique each run
    role: "admin",
  });

  await page.goto("/admin/users");

  const newUserEmail = faker.internet.email(); // Unique
  await page.fill('[data-testid="email"]', newUserEmail);
  await page.fill('[data-testid="name"]', "New User");
  await page.click('[data-testid="create-user"]');

  await expect(page.getByText("User created")).toBeVisible();

  // Verify in database
  const createdUser = await seedUser({ email: newUserEmail });
  expect(createdUser.email).toBe(newUserEmail);

  // Auto-cleanup happens via fixture teardown
});

// Cypress equivalent with explicit cleanup
describe("Admin User Management", () => {
  const createdUserIds: string[] = [];

  afterEach(() => {
    // Cleanup: Delete all users created during test
    createdUserIds.forEach((userId) => {
      cy.task("db:delete", { table: "users", id: userId });
    });
    createdUserIds.length = 0;
  });

  it("should create user", () => {
    const admin = createUser({ role: "admin" });
    const newUser = createUser(); // Unique data via faker

    cy.task("db:seed", { users: [admin] }).then((result: any) => {
      createdUserIds.push(result.users[0].id);
    });

    cy.visit("/admin/users");
    cy.get('[data-cy="email"]').type(newUser.email);
    cy.get('[data-cy="name"]').type(newUser.name);
    cy.get('[data-cy="create-user"]').click();

    cy.contains("User created").should("be.visible");

    // Track for cleanup
    cy.task("db:findByEmail", newUser.email).then((user: any) => {
      createdUserIds.push(user.id);
    });
  });
});
```

**Key Points**:

- Use fixtures with auto-cleanup via teardown (after `use()`)
- Track all created resources in array during test execution
- Use `faker` for unique data - prevents parallel collisions
- Cypress: Use `afterEach()` with explicit cleanup
- Never hardcode IDs or emails - always generate unique values

### Example 3: Explicit Assertions in Tests

**Context**: When validating test results, keep assertions visible in test bodies. Never hide assertions in helper functions - this obscures test intent and makes failures harder to diagnose.

**Implementation**:

```typescript
// ❌ BAD: Assertions hidden in helper functions
// helpers/api-validators.ts
export async function validateUserCreation(response: Response, expectedEmail: string) {
  const user = await response.json();
  expect(response.status()).toBe(201);
  expect(user.email).toBe(expectedEmail);
  expect(user.id).toBeTruthy();
  expect(user.createdAt).toBeTruthy();
  // Hidden assertions - not visible in test
}

test("create user via API - OPAQUE", async ({ request }) => {
  const userData = createUser({ email: "test@example.com" });

  const response = await request.post("/api/users", { data: userData });

  // What assertions are running? Have to check helper.
  await validateUserCreation(response, userData.email);
  // When this fails, error is: "validateUserCreation failed" - NOT helpful
});

// ✅ GOOD: Assertions explicit in test
test("create user via API", async ({ request }) => {
  const userData = createUser({ email: "test@example.com" });

  const response = await request.post("/api/users", { data: userData });

  // All assertions visible - clear test intent
  expect(response.status()).toBe(201);

  const createdUser = await response.json();
  expect(createdUser.id).toBeTruthy();
  expect(createdUser.email).toBe(userData.email);
  expect(createdUser.name).toBe(userData.name);
  expect(createdUser.role).toBe("user");
  expect(createdUser.createdAt).toBeTruthy();
  expect(createdUser.isActive).toBe(true);

  // When this fails, error is: "Expected role to be 'user', got 'admin'" - HELPFUL
});

// ✅ ACCEPTABLE: Helper for data extraction, NOT assertions
// helpers/api-extractors.ts
export async function extractUserFromResponse(response: Response): Promise<User> {
  const user = await response.json();
  return user; // Just extracts, no assertions
}

test("create user with extraction helper", async ({ request }) => {
  const userData = createUser({ email: "test@example.com" });

  const response = await request.post("/api/users", { data: userData });

  // Extract data with helper (OK)
  const createdUser = await extractUserFromResponse(response);

  // But keep assertions in test (REQUIRED)
  expect(response.status()).toBe(201);
  expect(createdUser.email).toBe(userData.email);
  expect(createdUser.role).toBe("user");
});

// Cypress equivalent
describe("User API", () => {
  it("should create user with explicit assertions", () => {
    const userData = createUser({ email: "test@example.com" });

    cy.request("POST", "/api/users", userData).then((response) => {
      // All assertions visible in test
      expect(response.status).to.equal(201);
      expect(response.body.id).to.exist;
      expect(response.body.email).to.equal(userData.email);
      expect(response.body.name).to.equal(userData.name);
      expect(response.body.role).to.equal("user");
      expect(response.body.createdAt).to.exist;
      expect(response.body.isActive).to.be.true;
    });
  });
});

// ✅ GOOD: Parametrized tests for soft assertions (bulk validation)
test.describe("User creation validation", () => {
  const testCases = [
    { field: "email", value: "test@example.com", expected: "test@example.com" },
    { field: "name", value: "Test User", expected: "Test User" },
    { field: "role", value: "admin", expected: "admin" },
    { field: "isActive", value: true, expected: true },
  ];

  for (const { field, value, expected } of testCases) {
    test(`should set ${field} correctly`, async ({ request }) => {
      const userData = createUser({ [field]: value });

      const response = await request.post("/api/users", { data: userData });
      const user = await response.json();

      // Parametrized assertion - still explicit
      expect(user[field]).toBe(expected);
    });
  }
});
```

**Key Points**:

- Never hide `expect()` calls in helper functions
- Helpers can extract/transform data, but assertions stay in tests
- Parametrized tests are acceptable for bulk validation (still explicit)
- Explicit assertions make failures actionable: "Expected X, got Y"
- Hidden assertions produce vague failures: "Helper function failed"

### Example 4: Test Length Limits

**Context**: When tests grow beyond 300 lines, they become hard to understand, debug, and maintain. Refactor long tests by extracting setup helpers, splitting scenarios, or using fixtures.

**Implementation**:

```typescript
// ❌ BAD: 400-line monolithic test (truncated for example)
test("complete user journey - TOO LONG", async ({ page, request }) => {
  // 50 lines of setup
  const admin = createUser({ role: "admin" });
  await request.post("/api/users", { data: admin });
  await page.goto("/login");
  await page.fill('[data-testid="email"]', admin.email);
  await page.fill('[data-testid="password"]', "password123");
  await page.click('[data-testid="login"]');
  await expect(page).toHaveURL("/dashboard");

  // 100 lines of user creation
  await page.goto("/admin/users");
  const newUser = createUser();
  await page.fill('[data-testid="email"]', newUser.email);
  // ... 95 more lines of form filling, validation, etc.

  // 100 lines of permissions assignment
  await page.click('[data-testid="assign-permissions"]');
  // ... 95 more lines

  // 100 lines of notification preferences
  await page.click('[data-testid="notification-settings"]');
  // ... 95 more lines

  // 50 lines of cleanup
  await request.delete(`/api/users/${newUser.id}`);
  // ... 45 more lines

  // TOTAL: 400 lines - impossible to understand or debug
});

// ✅ GOOD: Split into focused tests with shared fixture
// playwright/support/fixtures/admin-fixture.ts
export const test = base.extend({
  adminPage: async ({ page, request }, use) => {
    // Shared setup: Login as admin
    const admin = createUser({ role: "admin" });
    await request.post("/api/users", { data: admin });

    await page.goto("/login");
    await page.fill('[data-testid="email"]', admin.email);
    await page.fill('[data-testid="password"]', "password123");
    await page.click('[data-testid="login"]');
    await expect(page).toHaveURL("/dashboard");

    await use(page); // Provide logged-in page

    // Cleanup handled by fixture
  },
});

// Test 1: User creation (50 lines)
test("admin can create user", async ({ adminPage, seedUser }) => {
  await adminPage.goto("/admin/users");

  const newUser = createUser();
  await adminPage.fill('[data-testid="email"]', newUser.email);
  await adminPage.fill('[data-testid="name"]', newUser.name);
  await adminPage.click('[data-testid="role-dropdown"]');
  await adminPage.click('[data-testid="role-user"]');
  await adminPage.click('[data-testid="create-user"]');

  await expect(adminPage.getByText("User created")).toBeVisible();
  await expect(adminPage.getByText(newUser.email)).toBeVisible();

  // Verify in database
  const created = await seedUser({ email: newUser.email });
  expect(created.role).toBe("user");
});

// Test 2: Permission assignment (60 lines)
test("admin can assign permissions", async ({ adminPage, seedUser }) => {
  const user = await seedUser({ email: faker.internet.email() });

  await adminPage.goto(`/admin/users/${user.id}`);
  await adminPage.click('[data-testid="assign-permissions"]');
  await adminPage.check('[data-testid="permission-read"]');
  await adminPage.check('[data-testid="permission-write"]');
  await adminPage.click('[data-testid="save-permissions"]');

  await expect(adminPage.getByText("Permissions updated")).toBeVisible();

  // Verify permissions assigned
  const response = await adminPage.request.get(`/api/users/${user.id}`);
  const updated = await response.json();
  expect(updated.permissions).toContain("read");
  expect(updated.permissions).toContain("write");
});

// Test 3: Notification preferences (70 lines)
test("admin can update notification preferences", async ({ adminPage, seedUser }) => {
  const user = await seedUser({ email: faker.internet.email() });

  await adminPage.goto(`/admin/users/${user.id}/notifications`);
  await adminPage.check('[data-testid="email-notifications"]');
  await adminPage.uncheck('[data-testid="sms-notifications"]');
  await adminPage.selectOption('[data-testid="frequency"]', "daily");
  await adminPage.click('[data-testid="save-preferences"]');

  await expect(adminPage.getByText("Preferences saved")).toBeVisible();

  // Verify preferences
  const response = await adminPage.request.get(`/api/users/${user.id}/preferences`);
  const prefs = await response.json();
  expect(prefs.emailEnabled).toBe(true);
  expect(prefs.smsEnabled).toBe(false);
  expect(prefs.frequency).toBe("daily");
});

// TOTAL: 3 tests × 60 lines avg = 180 lines
// Each test is focused, debuggable, and under 300 lines
```

**Key Points**:

- Split monolithic tests into focused scenarios (<300 lines each)
- Extract common setup into fixtures (auto-runs for each test)
- Each test validates one concern (user creation, permissions, preferences)
- Failures are easier to diagnose: "Permission assignment failed" vs "Complete journey failed"
- Tests can run in parallel (isolated concerns)

### Example 5: Execution Time Optimization

**Context**: When tests take longer than 1.5 minutes, they slow CI pipelines and feedback loops. Optimize by using API setup instead of UI navigation, parallelizing independent operations, and avoiding unnecessary waits.

**Implementation**:

```typescript
// ❌ BAD: 4-minute test (slow setup, sequential operations)
test("user completes order - SLOW (4 min)", async ({ page }) => {
  // Step 1: Manual signup via UI (90 seconds)
  await page.goto("/signup");
  await page.fill('[data-testid="email"]', "buyer@example.com");
  await page.fill('[data-testid="password"]', "password123");
  await page.fill('[data-testid="confirm-password"]', "password123");
  await page.fill('[data-testid="name"]', "Buyer User");
  await page.click('[data-testid="signup"]');
  await page.waitForURL("/verify-email"); // Wait for email verification
  // ... manual email verification flow

  // Step 2: Manual product creation via UI (60 seconds)
  await page.goto("/admin/products");
  await page.fill('[data-testid="product-name"]', "Widget");
  // ... 20 more fields
  await page.click('[data-testid="create-product"]');

  // Step 3: Navigate to checkout (30 seconds)
  await page.goto("/products");
  await page.waitForTimeout(5000); // Unnecessary hard wait
  await page.click('[data-testid="product-widget"]');
  await page.waitForTimeout(3000); // Unnecessary
  await page.click('[data-testid="add-to-cart"]');
  await page.waitForTimeout(2000); // Unnecessary

  // Step 4: Complete checkout (40 seconds)
  await page.goto("/checkout");
  await page.waitForTimeout(5000); // Unnecessary
  await page.fill('[data-testid="credit-card"]', "4111111111111111");
  // ... more form filling
  await page.click('[data-testid="submit-order"]');
  await page.waitForTimeout(10000); // Unnecessary

  await expect(page.getByText("Order Confirmed")).toBeVisible();

  // TOTAL: ~240 seconds (4 minutes)
});

// ✅ GOOD: 45-second test (API setup, parallel ops, deterministic waits)
test("user completes order", async ({ page, apiRequest }) => {
  // Step 1: API setup (parallel, 5 seconds total)
  const [user, product] = await Promise.all([
    // Create user via API (fast)
    apiRequest
      .post("/api/users", {
        data: createUser({
          email: "buyer@example.com",
          emailVerified: true, // Skip verification
        }),
      })
      .then((r) => r.json()),

    // Create product via API (fast)
    apiRequest
      .post("/api/products", {
        data: createProduct({
          name: "Widget",
          price: 29.99,
          stock: 10,
        }),
      })
      .then((r) => r.json()),
  ]);

  // Step 2: Auth setup via storage state (instant, 0 seconds)
  await page.context().addCookies([
    {
      name: "auth_token",
      value: user.token,
      domain: "localhost",
      path: "/",
    },
  ]);

  // Step 3: Network-first interception BEFORE navigation (10 seconds)
  const cartPromise = page.waitForResponse("**/api/cart");
  const orderPromise = page.waitForResponse("**/api/orders");

  await page.goto(`/products/${product.id}`);
  await page.click('[data-testid="add-to-cart"]');
  await cartPromise; // Deterministic wait (no hard wait)

  // Step 4: Checkout with network waits (30 seconds)
  await page.goto("/checkout");
  await page.fill('[data-testid="credit-card"]', "4111111111111111");
  await page.fill('[data-testid="cvv"]', "123");
  await page.fill('[data-testid="expiry"]', "12/25");
  await page.click('[data-testid="submit-order"]');
  await orderPromise; // Deterministic wait (no hard wait)

  await expect(page.getByText("Order Confirmed")).toBeVisible();
  await expect(page.getByText(`Order #${product.id}`)).toBeVisible();

  // TOTAL: ~45 seconds (6x faster)
});

// Cypress equivalent
describe("Order Flow", () => {
  it("should complete purchase quickly", () => {
    // Step 1: API setup (parallel, fast)
    const user = createUser({ emailVerified: true });
    const product = createProduct({ name: "Widget", price: 29.99 });

    cy.task("db:seed", { users: [user], products: [product] });

    // Step 2: Auth setup via session (instant)
    cy.setCookie("auth_token", user.token);

    // Step 3: Network-first interception
    cy.intercept("POST", "**/api/cart").as("addToCart");
    cy.intercept("POST", "**/api/orders").as("createOrder");

    cy.visit(`/products/${product.id}`);
    cy.get('[data-cy="add-to-cart"]').click();
    cy.wait("@addToCart"); // Deterministic wait

    // Step 4: Checkout
    cy.visit("/checkout");
    cy.get('[data-cy="credit-card"]').type("4111111111111111");
    cy.get('[data-cy="cvv"]').type("123");
    cy.get('[data-cy="expiry"]').type("12/25");
    cy.get('[data-cy="submit-order"]').click();
    cy.wait("@createOrder"); // Deterministic wait

    cy.contains("Order Confirmed").should("be.visible");
    cy.contains(`Order #${product.id}`).should("be.visible");
  });
});

// Additional optimization: Shared auth state (0 seconds per test)
// playwright/support/global-setup.ts
export default async function globalSetup() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Create admin user once for all tests
  const admin = createUser({ role: "admin", emailVerified: true });
  await page.request.post("/api/users", { data: admin });

  // Login once, save session
  await page.goto("/login");
  await page.fill('[data-testid="email"]', admin.email);
  await page.fill('[data-testid="password"]', "password123");
  await page.click('[data-testid="login"]');

  // Save auth state for reuse
  await page.context().storageState({ path: "playwright/.auth/admin.json" });

  await browser.close();
}

// Use shared auth in tests (instant)
test.use({ storageState: "playwright/.auth/admin.json" });

test("admin action", async ({ page }) => {
  // Already logged in - no auth overhead (0 seconds)
  await page.goto("/admin");
  // ... test logic
});
```

**Key Points**:

- Use API for data setup (10-50x faster than UI)
- Run independent operations in parallel (`Promise.all`)
- Replace hard waits with deterministic waits (`waitForResponse`)
- Reuse auth sessions via `storageState` (Playwright) or `setCookie` (Cypress)
- Skip unnecessary flows (email verification, multi-step signups)

## Integration Points

- **Used in workflows**: `*atdd` (test generation quality), `*automate` (test expansion quality), `*test-review` (quality validation)
- **Related fragments**:
  - `network-first.md` - Deterministic waiting strategies
  - `data-factories.md` - Isolated, parallel-safe data patterns
  - `fixture-architecture.md` - Setup extraction and cleanup
  - `test-levels-framework.md` - Choosing appropriate test granularity for speed

## Core Quality Checklist

Every test must pass these criteria:

- [ ] **No Hard Waits** - Use `waitForResponse`, `waitForLoadState`, or element state (not `waitForTimeout`)
- [ ] **No Conditionals** - Tests execute the same path every time (no if/else, try/catch for flow control)
- [ ] **< 300 Lines** - Keep tests focused; split large tests or extract setup to fixtures
- [ ] **< 1.5 Minutes** - Optimize with API setup, parallel operations, and shared auth
- [ ] **Self-Cleaning** - Use fixtures with auto-cleanup or explicit `afterEach()` teardown
- [ ] **Explicit Assertions** - Keep `expect()` calls in test bodies, not hidden in helpers
- [ ] **Unique Data** - Use `faker` for dynamic data; never hardcode IDs or emails
- [ ] **Parallel-Safe** - Tests don't share state; run successfully with `--workers=4`

_Source: Murat quality checklist, Definition of Done requirements (lines 370-381, 406-422)._
