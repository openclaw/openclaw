# Data Factories and API-First Setup

## Principle

Prefer factory functions that accept overrides and return complete objects (`createUser(overrides)`). Seed test state through APIs, tasks, or direct DB helpers before visiting the UI—never via slow UI interactions. UI is for validation only, not setup.

## Rationale

Static fixtures (JSON files, hardcoded objects) create brittle tests that:

- Fail when schemas evolve (missing new required fields)
- Cause collisions in parallel execution (same user IDs)
- Hide test intent (what matters for _this_ test?)

Dynamic factories with overrides provide:

- **Parallel safety**: UUIDs and timestamps prevent collisions
- **Schema evolution**: Defaults adapt to schema changes automatically
- **Explicit intent**: Overrides show what matters for each test
- **Speed**: API setup is 10-50x faster than UI

## Pattern Examples

### Example 1: Factory Function with Overrides

**Context**: When creating test data, build factory functions with sensible defaults and explicit overrides. Use `faker` for dynamic values that prevent collisions.

**Implementation**:

```typescript
// test-utils/factories/user-factory.ts
import { faker } from "@faker-js/faker";

type User = {
  id: string;
  email: string;
  name: string;
  role: "user" | "admin" | "moderator";
  createdAt: Date;
  isActive: boolean;
};

export const createUser = (overrides: Partial<User> = {}): User => ({
  id: faker.string.uuid(),
  email: faker.internet.email(),
  name: faker.person.fullName(),
  role: "user",
  createdAt: new Date(),
  isActive: true,
  ...overrides,
});

// test-utils/factories/product-factory.ts
type Product = {
  id: string;
  name: string;
  price: number;
  stock: number;
  category: string;
};

export const createProduct = (overrides: Partial<Product> = {}): Product => ({
  id: faker.string.uuid(),
  name: faker.commerce.productName(),
  price: parseFloat(faker.commerce.price()),
  stock: faker.number.int({ min: 0, max: 100 }),
  category: faker.commerce.department(),
  ...overrides,
});

// Usage in tests:
test("admin can delete users", async ({ page, apiRequest }) => {
  // Default user
  const user = createUser();

  // Admin user (explicit override shows intent)
  const admin = createUser({ role: "admin" });

  // Seed via API (fast!)
  await apiRequest({ method: "POST", url: "/api/users", data: user });
  await apiRequest({ method: "POST", url: "/api/users", data: admin });

  // Now test UI behavior
  await page.goto("/admin/users");
  await page.click(`[data-testid="delete-user-${user.id}"]`);
  await expect(page.getByText(`User ${user.name} deleted`)).toBeVisible();
});
```

**Key Points**:

- `Partial<User>` allows overriding any field without breaking type safety
- Faker generates unique values—no collisions in parallel tests
- Override shows test intent: `createUser({ role: 'admin' })` is explicit
- Factory lives in `test-utils/factories/` for easy reuse

### Example 2: Nested Factory Pattern

**Context**: When testing relationships (orders with users and products), nest factories to create complete object graphs. Control relationship data explicitly.

**Implementation**:

```typescript
// test-utils/factories/order-factory.ts
import { createUser } from "./user-factory";
import { createProduct } from "./product-factory";

type OrderItem = {
  product: Product;
  quantity: number;
  price: number;
};

type Order = {
  id: string;
  user: User;
  items: OrderItem[];
  total: number;
  status: "pending" | "paid" | "shipped" | "delivered";
  createdAt: Date;
};

export const createOrderItem = (overrides: Partial<OrderItem> = {}): OrderItem => {
  const product = overrides.product || createProduct();
  const quantity = overrides.quantity || faker.number.int({ min: 1, max: 5 });

  return {
    product,
    quantity,
    price: product.price * quantity,
    ...overrides,
  };
};

export const createOrder = (overrides: Partial<Order> = {}): Order => {
  const items = overrides.items || [createOrderItem(), createOrderItem()];
  const total = items.reduce((sum, item) => sum + item.price, 0);

  return {
    id: faker.string.uuid(),
    user: overrides.user || createUser(),
    items,
    total,
    status: "pending",
    createdAt: new Date(),
    ...overrides,
  };
};

// Usage in tests:
test("user can view order details", async ({ page, apiRequest }) => {
  const user = createUser({ email: "test@example.com" });
  const product1 = createProduct({ name: "Widget A", price: 10.0 });
  const product2 = createProduct({ name: "Widget B", price: 15.0 });

  // Explicit relationships
  const order = createOrder({
    user,
    items: [
      createOrderItem({ product: product1, quantity: 2 }), // $20
      createOrderItem({ product: product2, quantity: 1 }), // $15
    ],
  });

  // Seed via API
  await apiRequest({ method: "POST", url: "/api/users", data: user });
  await apiRequest({ method: "POST", url: "/api/products", data: product1 });
  await apiRequest({ method: "POST", url: "/api/products", data: product2 });
  await apiRequest({ method: "POST", url: "/api/orders", data: order });

  // Test UI
  await page.goto(`/orders/${order.id}`);
  await expect(page.getByText("Widget A x 2")).toBeVisible();
  await expect(page.getByText("Widget B x 1")).toBeVisible();
  await expect(page.getByText("Total: $35.00")).toBeVisible();
});
```

**Key Points**:

- Nested factories handle relationships (order → user, order → products)
- Overrides cascade: provide custom user/products or use defaults
- Calculated fields (total) derived automatically from nested data
- Explicit relationships make test data clear and maintainable

### Example 3: Factory with API Seeding

**Context**: When tests need data setup, always use API calls or database tasks—never UI navigation. Wrap factory usage with seeding utilities for clean test setup.

**Implementation**:

```typescript
// playwright/support/helpers/seed-helpers.ts
import { APIRequestContext } from "@playwright/test";
import { User, createUser } from "../../test-utils/factories/user-factory";
import { Product, createProduct } from "../../test-utils/factories/product-factory";

export async function seedUser(
  request: APIRequestContext,
  overrides: Partial<User> = {},
): Promise<User> {
  const user = createUser(overrides);

  const response = await request.post("/api/users", {
    data: user,
  });

  if (!response.ok()) {
    throw new Error(`Failed to seed user: ${response.status()}`);
  }

  return user;
}

export async function seedProduct(
  request: APIRequestContext,
  overrides: Partial<Product> = {},
): Promise<Product> {
  const product = createProduct(overrides);

  const response = await request.post("/api/products", {
    data: product,
  });

  if (!response.ok()) {
    throw new Error(`Failed to seed product: ${response.status()}`);
  }

  return product;
}

// Playwright globalSetup for shared data
// playwright/support/global-setup.ts
import { chromium, FullConfig } from "@playwright/test";
import { seedUser } from "./helpers/seed-helpers";

async function globalSetup(config: FullConfig) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const context = page.context();

  // Seed admin user for all tests
  const admin = await seedUser(context.request, {
    email: "admin@example.com",
    role: "admin",
  });

  // Save auth state for reuse
  await context.storageState({ path: "playwright/.auth/admin.json" });

  await browser.close();
}

export default globalSetup;

// Cypress equivalent with cy.task
// cypress/support/tasks.ts
export const seedDatabase = async (entity: string, data: unknown) => {
  // Direct database insert or API call
  if (entity === "users") {
    await db.users.create(data);
  }
  return null;
};

// Usage in Cypress tests:
beforeEach(() => {
  const user = createUser({ email: "test@example.com" });
  cy.task("db:seed", { entity: "users", data: user });
});
```

**Key Points**:

- API seeding is 10-50x faster than UI-based setup
- `globalSetup` seeds shared data once (e.g., admin user)
- Per-test seeding uses `seedUser()` helpers for isolation
- Cypress `cy.task` allows direct database access for speed

### Example 4: Anti-Pattern - Hardcoded Test Data

**Problem**:

```typescript
// ❌ BAD: Hardcoded test data
test('user can login', async ({ page }) => {
  await page.goto('/login');
  await page.fill('[data-testid="email"]', 'test@test.com'); // Hardcoded
  await page.fill('[data-testid="password"]', 'password123'); // Hardcoded
  await page.click('[data-testid="submit"]');

  // What if this user already exists? Test fails in parallel runs.
  // What if schema adds required fields? Test breaks.
});

// ❌ BAD: Static JSON fixtures
// fixtures/users.json
{
  "users": [
    { "id": 1, "email": "user1@test.com", "name": "User 1" },
    { "id": 2, "email": "user2@test.com", "name": "User 2" }
  ]
}

test('admin can delete user', async ({ page }) => {
  const users = require('../fixtures/users.json');
  // Brittle: IDs collide in parallel, schema drift breaks tests
});
```

**Why It Fails**:

- **Parallel collisions**: Hardcoded IDs (`id: 1`, `email: 'test@test.com'`) cause failures when tests run concurrently
- **Schema drift**: Adding required fields (`phoneNumber`, `address`) breaks all tests using fixtures
- **Hidden intent**: Does this test need `email: 'test@test.com'` specifically, or any email?
- **Slow setup**: UI-based data creation is 10-50x slower than API

**Better Approach**: Use factories

```typescript
// ✅ GOOD: Factory-based data
test("user can login", async ({ page, apiRequest }) => {
  const user = createUser({ email: "unique@example.com", password: "secure123" });

  // Seed via API (fast, parallel-safe)
  await apiRequest({ method: "POST", url: "/api/users", data: user });

  // Test UI
  await page.goto("/login");
  await page.fill('[data-testid="email"]', user.email);
  await page.fill('[data-testid="password"]', user.password);
  await page.click('[data-testid="submit"]');

  await expect(page).toHaveURL("/dashboard");
});

// ✅ GOOD: Factories adapt to schema changes automatically
// When `phoneNumber` becomes required, update factory once:
export const createUser = (overrides: Partial<User> = {}): User => ({
  id: faker.string.uuid(),
  email: faker.internet.email(),
  name: faker.person.fullName(),
  phoneNumber: faker.phone.number(), // NEW field, all tests get it automatically
  role: "user",
  ...overrides,
});
```

**Key Points**:

- Factories generate unique, parallel-safe data
- Schema evolution handled in one place (factory), not every test
- Test intent explicit via overrides
- API seeding is fast and reliable

### Example 5: Factory Composition

**Context**: When building specialized factories, compose simpler factories instead of duplicating logic. Layer overrides for specific test scenarios.

**Implementation**:

```typescript
// test-utils/factories/user-factory.ts (base)
export const createUser = (overrides: Partial<User> = {}): User => ({
  id: faker.string.uuid(),
  email: faker.internet.email(),
  name: faker.person.fullName(),
  role: "user",
  createdAt: new Date(),
  isActive: true,
  ...overrides,
});

// Compose specialized factories
export const createAdminUser = (overrides: Partial<User> = {}): User =>
  createUser({ role: "admin", ...overrides });

export const createModeratorUser = (overrides: Partial<User> = {}): User =>
  createUser({ role: "moderator", ...overrides });

export const createInactiveUser = (overrides: Partial<User> = {}): User =>
  createUser({ isActive: false, ...overrides });

// Account-level factories with feature flags
type Account = {
  id: string;
  owner: User;
  plan: "free" | "pro" | "enterprise";
  features: string[];
  maxUsers: number;
};

export const createAccount = (overrides: Partial<Account> = {}): Account => ({
  id: faker.string.uuid(),
  owner: overrides.owner || createUser(),
  plan: "free",
  features: [],
  maxUsers: 1,
  ...overrides,
});

export const createProAccount = (overrides: Partial<Account> = {}): Account =>
  createAccount({
    plan: "pro",
    features: ["advanced-analytics", "priority-support"],
    maxUsers: 10,
    ...overrides,
  });

export const createEnterpriseAccount = (overrides: Partial<Account> = {}): Account =>
  createAccount({
    plan: "enterprise",
    features: ["advanced-analytics", "priority-support", "sso", "audit-logs"],
    maxUsers: 100,
    ...overrides,
  });

// Usage in tests:
test("pro accounts can access analytics", async ({ page, apiRequest }) => {
  const admin = createAdminUser({ email: "admin@company.com" });
  const account = createProAccount({ owner: admin });

  await apiRequest({ method: "POST", url: "/api/users", data: admin });
  await apiRequest({ method: "POST", url: "/api/accounts", data: account });

  await page.goto("/analytics");
  await expect(page.getByText("Advanced Analytics")).toBeVisible();
});

test("free accounts cannot access analytics", async ({ page, apiRequest }) => {
  const user = createUser({ email: "user@company.com" });
  const account = createAccount({ owner: user }); // Defaults to free plan

  await apiRequest({ method: "POST", url: "/api/users", data: user });
  await apiRequest({ method: "POST", url: "/api/accounts", data: account });

  await page.goto("/analytics");
  await expect(page.getByText("Upgrade to Pro")).toBeVisible();
});
```

**Key Points**:

- Compose specialized factories from base factories (`createAdminUser` → `createUser`)
- Defaults cascade: `createProAccount` sets plan + features automatically
- Still allow overrides: `createProAccount({ maxUsers: 50 })` works
- Test intent clear: `createProAccount()` vs `createAccount({ plan: 'pro', features: [...] })`

## Integration Points

- **Used in workflows**: `*atdd` (test generation), `*automate` (test expansion), `*framework` (factory setup)
- **Related fragments**:
  - `fixture-architecture.md` - Pure functions and fixtures for factory integration
  - `network-first.md` - API-first setup patterns
  - `test-quality.md` - Parallel-safe, deterministic test design

## Cleanup Strategy

Ensure factories work with cleanup patterns:

```typescript
// Track created IDs for cleanup
const createdUsers: string[] = [];

afterEach(async ({ apiRequest }) => {
  // Clean up all users created during test
  for (const userId of createdUsers) {
    await apiRequest({ method: "DELETE", url: `/api/users/${userId}` });
  }
  createdUsers.length = 0;
});

test("user registration flow", async ({ page, apiRequest }) => {
  const user = createUser();
  createdUsers.push(user.id);

  await apiRequest({ method: "POST", url: "/api/users", data: user });
  // ... test logic
});
```

## Feature Flag Integration

When working with feature flags, layer them into factories:

```typescript
export const createUserWithFlags = (
  overrides: Partial<User> = {},
  flags: Record<string, boolean> = {},
): User & { flags: Record<string, boolean> } => ({
  ...createUser(overrides),
  flags: {
    "new-dashboard": false,
    "beta-features": false,
    ...flags,
  },
});

// Usage:
const user = createUserWithFlags(
  { email: "test@example.com" },
  {
    "new-dashboard": true,
    "beta-features": true,
  },
);
```

_Source: Murat Testing Philosophy (lines 94-120), API-first testing patterns, faker.js documentation._
