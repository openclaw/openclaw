# Fixture Architecture Playbook

## Principle

Build test helpers as pure functions first, then wrap them in framework-specific fixtures. Compose capabilities using `mergeTests` (Playwright) or layered commands (Cypress) instead of inheritance. Each fixture should solve one isolated concern (auth, API, logs, network).

## Rationale

Traditional Page Object Models create tight coupling through inheritance chains (`BasePage → LoginPage → AdminPage`). When base classes change, all descendants break. Pure functions with fixture wrappers provide:

- **Testability**: Pure functions run in unit tests without framework overhead
- **Composability**: Mix capabilities freely via `mergeTests`, no inheritance constraints
- **Reusability**: Export fixtures via package subpaths for cross-project sharing
- **Maintainability**: One concern per fixture = clear responsibility boundaries

## Pattern Examples

### Example 1: Pure Function → Fixture Pattern

**Context**: When building any test helper, always start with a pure function that accepts all dependencies explicitly. Then wrap it in a Playwright fixture or Cypress command.

**Implementation**:

```typescript
// playwright/support/helpers/api-request.ts
// Step 1: Pure function (ALWAYS FIRST!)
type ApiRequestParams = {
  request: APIRequestContext;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  data?: unknown;
  headers?: Record<string, string>;
};

export async function apiRequest({
  request,
  method,
  url,
  data,
  headers = {}
}: ApiRequestParams) {
  const response = await request.fetch(url, {
    method,
    data,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  });

  if (!response.ok()) {
    throw new Error(`API request failed: ${response.status()} ${await response.text()}`);
  }

  return response.json();
}

// Step 2: Fixture wrapper
// playwright/support/fixtures/api-request-fixture.ts
import { test as base } from '@playwright/test';
import { apiRequest } from '../helpers/api-request';

export const test = base.extend<{ apiRequest: typeof apiRequest }>({
  apiRequest: async ({ request }, use) => {
    // Inject framework dependency, expose pure function
    await use((params) => apiRequest({ request, ...params }));
  }
});

// Step 3: Package exports for reusability
// package.json
{
  "exports": {
    "./api-request": "./playwright/support/helpers/api-request.ts",
    "./api-request/fixtures": "./playwright/support/fixtures/api-request-fixture.ts"
  }
}
```

**Key Points**:

- Pure function is unit-testable without Playwright running
- Framework dependency (`request`) injected at fixture boundary
- Fixture exposes the pure function to test context
- Package subpath exports enable `import { apiRequest } from 'my-fixtures/api-request'`

### Example 2: Composable Fixture System with mergeTests

**Context**: When building comprehensive test capabilities, compose multiple focused fixtures instead of creating monolithic helper classes. Each fixture provides one capability.

**Implementation**:

```typescript
// playwright/support/fixtures/merged-fixtures.ts
import { test as base, mergeTests } from "@playwright/test";
import { test as apiRequestFixture } from "./api-request-fixture";
import { test as networkFixture } from "./network-fixture";
import { test as authFixture } from "./auth-fixture";
import { test as logFixture } from "./log-fixture";

// Compose all fixtures for comprehensive capabilities
export const test = mergeTests(base, apiRequestFixture, networkFixture, authFixture, logFixture);

export { expect } from "@playwright/test";

// Example usage in tests:
// import { test, expect } from './support/fixtures/merged-fixtures';
//
// test('user can create order', async ({ page, apiRequest, auth, network }) => {
//   await auth.loginAs('customer@example.com');
//   await network.interceptRoute('POST', '**/api/orders', { id: 123 });
//   await page.goto('/checkout');
//   await page.click('[data-testid="submit-order"]');
//   await expect(page.getByText('Order #123')).toBeVisible();
// });
```

**Individual Fixture Examples**:

```typescript
// network-fixture.ts
export const test = base.extend({
  network: async ({ page }, use) => {
    const interceptedRoutes = new Map();

    const interceptRoute = async (method: string, url: string, response: unknown) => {
      await page.route(url, (route) => {
        if (route.request().method() === method) {
          route.fulfill({ body: JSON.stringify(response) });
        }
      });
      interceptedRoutes.set(`${method}:${url}`, response);
    };

    await use({ interceptRoute });

    // Cleanup
    interceptedRoutes.clear();
  },
});

// auth-fixture.ts
export const test = base.extend({
  auth: async ({ page, context }, use) => {
    const loginAs = async (email: string) => {
      // Use API to setup auth (fast!)
      const token = await getAuthToken(email);
      await context.addCookies([
        {
          name: "auth_token",
          value: token,
          domain: "localhost",
          path: "/",
        },
      ]);
    };

    await use({ loginAs });
  },
});
```

**Key Points**:

- `mergeTests` combines fixtures without inheritance
- Each fixture has single responsibility (network, auth, logs)
- Tests import merged fixture and access all capabilities
- No coupling between fixtures—add/remove freely

### Example 3: Framework-Agnostic HTTP Helper

**Context**: When building HTTP helpers, keep them framework-agnostic. Accept all params explicitly so they work in unit tests, Playwright, Cypress, or any context.

**Implementation**:

```typescript
// shared/helpers/http-helper.ts
// Pure, framework-agnostic function
type HttpHelperParams = {
  baseUrl: string;
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  token?: string;
};

export async function makeHttpRequest({
  baseUrl,
  endpoint,
  method,
  body,
  headers = {},
  token,
}: HttpHelperParams): Promise<unknown> {
  const url = `${baseUrl}${endpoint}`;
  const requestHeaders = {
    "Content-Type": "application/json",
    ...(token && { Authorization: `Bearer ${token}` }),
    ...headers,
  };

  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${method} ${url} failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

// Playwright fixture wrapper
// playwright/support/fixtures/http-fixture.ts
import { test as base } from "@playwright/test";
import { makeHttpRequest } from "../../shared/helpers/http-helper";

export const test = base.extend({
  httpHelper: async ({}, use) => {
    const baseUrl = process.env.API_BASE_URL || "http://localhost:3000";

    await use((params) => makeHttpRequest({ baseUrl, ...params }));
  },
});

// Cypress command wrapper
// cypress/support/commands.ts
import { makeHttpRequest } from "../../shared/helpers/http-helper";

Cypress.Commands.add("apiRequest", (params) => {
  const baseUrl = Cypress.env("API_BASE_URL") || "http://localhost:3000";
  return cy.wrap(makeHttpRequest({ baseUrl, ...params }));
});
```

**Key Points**:

- Pure function uses only standard `fetch`, no framework dependencies
- Unit tests call `makeHttpRequest` directly with all params
- Playwright and Cypress wrappers inject framework-specific config
- Same logic runs everywhere—zero duplication

### Example 4: Fixture Cleanup Pattern

**Context**: When fixtures create resources (data, files, connections), ensure automatic cleanup in fixture teardown. Tests must not leak state.

**Implementation**:

```typescript
// playwright/support/fixtures/database-fixture.ts
import { test as base } from "@playwright/test";
import { seedDatabase, deleteRecord } from "../helpers/db-helpers";

type DatabaseFixture = {
  seedUser: (userData: Partial<User>) => Promise<User>;
  seedOrder: (orderData: Partial<Order>) => Promise<Order>;
};

export const test = base.extend<DatabaseFixture>({
  seedUser: async ({}, use) => {
    const createdUsers: string[] = [];

    const seedUser = async (userData: Partial<User>) => {
      const user = await seedDatabase("users", userData);
      createdUsers.push(user.id);
      return user;
    };

    await use(seedUser);

    // Auto-cleanup: Delete all users created during test
    for (const userId of createdUsers) {
      await deleteRecord("users", userId);
    }
    createdUsers.length = 0;
  },

  seedOrder: async ({}, use) => {
    const createdOrders: string[] = [];

    const seedOrder = async (orderData: Partial<Order>) => {
      const order = await seedDatabase("orders", orderData);
      createdOrders.push(order.id);
      return order;
    };

    await use(seedOrder);

    // Auto-cleanup: Delete all orders
    for (const orderId of createdOrders) {
      await deleteRecord("orders", orderId);
    }
    createdOrders.length = 0;
  },
});

// Example usage:
// test('user can place order', async ({ seedUser, seedOrder, page }) => {
//   const user = await seedUser({ email: 'test@example.com' });
//   const order = await seedOrder({ userId: user.id, total: 100 });
//
//   await page.goto(`/orders/${order.id}`);
//   await expect(page.getByText('Order Total: $100')).toBeVisible();
//
//   // No manual cleanup needed—fixture handles it automatically
// });
```

**Key Points**:

- Track all created resources in array during test execution
- Teardown (after `use()`) deletes all tracked resources
- Tests don't manually clean up—happens automatically
- Prevents test pollution and flakiness from shared state

### Anti-Pattern: Inheritance-Based Page Objects

**Problem**:

```typescript
// ❌ BAD: Page Object Model with inheritance
class BasePage {
  constructor(public page: Page) {}

  async navigate(url: string) {
    await this.page.goto(url);
  }

  async clickButton(selector: string) {
    await this.page.click(selector);
  }
}

class LoginPage extends BasePage {
  async login(email: string, password: string) {
    await this.navigate("/login");
    await this.page.fill("#email", email);
    await this.page.fill("#password", password);
    await this.clickButton("#submit");
  }
}

class AdminPage extends LoginPage {
  async accessAdminPanel() {
    await this.login("admin@example.com", "admin123");
    await this.navigate("/admin");
  }
}
```

**Why It Fails**:

- Changes to `BasePage` break all descendants (`LoginPage`, `AdminPage`)
- `AdminPage` inherits unnecessary `login` details—tight coupling
- Cannot compose capabilities (e.g., admin + reporting features require multiple inheritance)
- Hard to test `BasePage` methods in isolation
- Hidden state in class instances leads to unpredictable behavior

**Better Approach**: Use pure functions + fixtures

```typescript
// ✅ GOOD: Pure functions with fixture composition
// helpers/navigation.ts
export async function navigate(page: Page, url: string) {
  await page.goto(url);
}

// helpers/auth.ts
export async function login(page: Page, email: string, password: string) {
  await page.fill('[data-testid="email"]', email);
  await page.fill('[data-testid="password"]', password);
  await page.click('[data-testid="submit"]');
}

// fixtures/admin-fixture.ts
export const test = base.extend({
  adminPage: async ({ page }, use) => {
    await login(page, "admin@example.com", "admin123");
    await navigate(page, "/admin");
    await use(page);
  },
});

// Tests import exactly what they need—no inheritance
```

## Integration Points

- **Used in workflows**: `*atdd` (test generation), `*automate` (test expansion), `*framework` (initial setup)
- **Related fragments**:
  - `data-factories.md` - Factory functions for test data
  - `network-first.md` - Network interception patterns
  - `test-quality.md` - Deterministic test design principles

## Helper Function Reuse Guidelines

When deciding whether to create a fixture, follow these rules:

- **3+ uses** → Create fixture with subpath export (shared across tests/projects)
- **2-3 uses** → Create utility module (shared within project)
- **1 use** → Keep inline (avoid premature abstraction)
- **Complex logic** → Factory function pattern (dynamic data generation)

_Source: Murat Testing Philosophy (lines 74-122), SEON production patterns, Playwright fixture docs._
