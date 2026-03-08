# API Testing Patterns

## Principle

Test APIs and backend services directly without browser overhead. Use Playwright's `request` context for HTTP operations, `apiRequest` utility for enhanced features, and `recurse` for async operations. Pure API tests run faster, are more stable, and provide better coverage for service-layer logic.

## Rationale

Many teams over-rely on E2E/browser tests when API tests would be more appropriate:

- **Slower feedback**: Browser tests take seconds, API tests take milliseconds
- **More brittle**: UI changes break tests even when API works correctly
- **Wrong abstraction**: Testing business logic through UI layers adds noise
- **Resource heavy**: Browsers consume memory and CPU

API-first testing provides:

- **Fast execution**: No browser startup, no rendering, no JavaScript execution
- **Direct validation**: Test exactly what the service returns
- **Better isolation**: Test service logic independent of UI
- **Easier debugging**: Clear request/response without DOM noise
- **Contract validation**: Verify API contracts explicitly

## When to Use API Tests vs E2E Tests

| Scenario                  | API Test      | E2E Test      |
| ------------------------- | ------------- | ------------- |
| CRUD operations           | ✅ Primary    | ❌ Overkill   |
| Business logic validation | ✅ Primary    | ❌ Overkill   |
| Error handling (4xx, 5xx) | ✅ Primary    | ⚠️ Supplement |
| Authentication flows      | ✅ Primary    | ⚠️ Supplement |
| Data transformation       | ✅ Primary    | ❌ Overkill   |
| User journeys             | ❌ Can't test | ✅ Primary    |
| Visual regression         | ❌ Can't test | ✅ Primary    |
| Cross-browser issues      | ❌ Can't test | ✅ Primary    |

**Rule of thumb**: If you're testing what the server returns (not how it looks), use API tests.

## Pattern Examples

### Example 1: Pure API Test (No Browser)

**Context**: Test REST API endpoints directly without any browser context.

**Implementation**:

```typescript
// tests/api/users.spec.ts
import { test, expect } from "@playwright/test";

// No page, no browser - just API
test.describe("Users API", () => {
  test("should create user", async ({ request }) => {
    const response = await request.post("/api/users", {
      data: {
        name: "John Doe",
        email: "john@example.com",
        role: "user",
      },
    });

    expect(response.status()).toBe(201);

    const user = await response.json();
    expect(user.id).toBeDefined();
    expect(user.name).toBe("John Doe");
    expect(user.email).toBe("john@example.com");
  });

  test("should get user by ID", async ({ request }) => {
    // Create user first
    const createResponse = await request.post("/api/users", {
      data: { name: "Jane Doe", email: "jane@example.com" },
    });
    const { id } = await createResponse.json();

    // Get user
    const getResponse = await request.get(`/api/users/${id}`);
    expect(getResponse.status()).toBe(200);

    const user = await getResponse.json();
    expect(user.id).toBe(id);
    expect(user.name).toBe("Jane Doe");
  });

  test("should return 404 for non-existent user", async ({ request }) => {
    const response = await request.get("/api/users/non-existent-id");
    expect(response.status()).toBe(404);

    const error = await response.json();
    expect(error.code).toBe("USER_NOT_FOUND");
  });

  test("should validate required fields", async ({ request }) => {
    const response = await request.post("/api/users", {
      data: { name: "Missing Email" }, // email is required
    });

    expect(response.status()).toBe(400);

    const error = await response.json();
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.details).toContainEqual(
      expect.objectContaining({ field: "email", message: expect.any(String) }),
    );
  });
});
```

**Key Points**:

- No `page` fixture needed - only `request`
- Tests run without browser overhead
- Direct HTTP assertions
- Clear error handling tests

### Example 2: API Test with apiRequest Utility

**Context**: Use enhanced apiRequest for schema validation, retry, and type safety.

**Implementation**:

```typescript
// tests/api/orders.spec.ts
import { test, expect } from "@seontechnologies/playwright-utils/api-request/fixtures";
import { z } from "zod";

// Define schema for type safety and validation
const OrderSchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  items: z.array(
    z.object({
      productId: z.string(),
      quantity: z.number().positive(),
      price: z.number().positive(),
    }),
  ),
  total: z.number().positive(),
  status: z.enum(["pending", "processing", "shipped", "delivered"]),
  createdAt: z.string().datetime(),
});

type Order = z.infer<typeof OrderSchema>;

test.describe("Orders API", () => {
  test("should create order with schema validation", async ({ apiRequest }) => {
    const { status, body } = await apiRequest<Order>({
      method: "POST",
      path: "/api/orders",
      body: {
        userId: "user-123",
        items: [
          { productId: "prod-1", quantity: 2, price: 29.99 },
          { productId: "prod-2", quantity: 1, price: 49.99 },
        ],
      },
      validateSchema: OrderSchema, // Validates response matches schema
    });

    expect(status).toBe(201);
    expect(body.id).toBeDefined();
    expect(body.status).toBe("pending");
    expect(body.total).toBe(109.97); // 2*29.99 + 49.99
  });

  test("should handle server errors with retry", async ({ apiRequest }) => {
    // apiRequest retries 5xx errors by default
    const { status, body } = await apiRequest({
      method: "GET",
      path: "/api/orders/order-123",
      retryConfig: {
        maxRetries: 3,
        retryDelay: 1000,
      },
    });

    expect(status).toBe(200);
  });

  test("should list orders with pagination", async ({ apiRequest }) => {
    const { status, body } = await apiRequest<{ orders: Order[]; total: number; page: number }>({
      method: "GET",
      path: "/api/orders",
      params: { page: 1, limit: 10, status: "pending" },
    });

    expect(status).toBe(200);
    expect(body.orders).toHaveLength(10);
    expect(body.total).toBeGreaterThan(10);
    expect(body.page).toBe(1);
  });
});
```

**Key Points**:

- Zod schema for runtime validation AND TypeScript types
- `validateSchema` throws if response doesn't match
- Built-in retry for transient failures
- Type-safe `body` access
- **Note**: If your project uses code-generated operations from an OpenAPI spec, see [Example 8](#example-8-operation-based-api-testing-openapi--code-generators) for the preferred `operation`-based overload (v3.14.0+)

### Example 3: Microservice-to-Microservice Testing

**Context**: Test service interactions without browser - validate API contracts between services.

**Implementation**:

```typescript
// tests/api/service-integration.spec.ts
import { test, expect } from "@seontechnologies/playwright-utils/fixtures";

test.describe("Service Integration", () => {
  const USER_SERVICE_URL = process.env.USER_SERVICE_URL || "http://localhost:3001";
  const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || "http://localhost:3002";
  const INVENTORY_SERVICE_URL = process.env.INVENTORY_SERVICE_URL || "http://localhost:3003";

  test("order service should validate user exists", async ({ apiRequest }) => {
    // Create user in user-service
    const { body: user } = await apiRequest({
      method: "POST",
      path: "/api/users",
      baseUrl: USER_SERVICE_URL,
      body: { name: "Test User", email: "test@example.com" },
    });

    // Create order in order-service (should validate user via user-service)
    const { status, body: order } = await apiRequest({
      method: "POST",
      path: "/api/orders",
      baseUrl: ORDER_SERVICE_URL,
      body: {
        userId: user.id,
        items: [{ productId: "prod-1", quantity: 1 }],
      },
    });

    expect(status).toBe(201);
    expect(order.userId).toBe(user.id);
  });

  test("order service should reject invalid user", async ({ apiRequest }) => {
    const { status, body } = await apiRequest({
      method: "POST",
      path: "/api/orders",
      baseUrl: ORDER_SERVICE_URL,
      body: {
        userId: "non-existent-user",
        items: [{ productId: "prod-1", quantity: 1 }],
      },
    });

    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_USER");
  });

  test("order should decrease inventory", async ({ apiRequest, recurse }) => {
    // Get initial inventory
    const { body: initialInventory } = await apiRequest({
      method: "GET",
      path: "/api/inventory/prod-1",
      baseUrl: INVENTORY_SERVICE_URL,
    });

    // Create order
    await apiRequest({
      method: "POST",
      path: "/api/orders",
      baseUrl: ORDER_SERVICE_URL,
      body: {
        userId: "user-123",
        items: [{ productId: "prod-1", quantity: 2 }],
      },
    });

    // Poll for inventory update (eventual consistency)
    const { body: updatedInventory } = await recurse(
      () =>
        apiRequest({
          method: "GET",
          path: "/api/inventory/prod-1",
          baseUrl: INVENTORY_SERVICE_URL,
        }),
      (response) => response.body.quantity === initialInventory.quantity - 2,
      { timeout: 10000, interval: 500 },
    );

    expect(updatedInventory.quantity).toBe(initialInventory.quantity - 2);
  });
});
```

**Key Points**:

- Multiple service URLs for microservice testing
- Tests service-to-service communication
- Uses `recurse` for eventual consistency
- No browser needed for full integration testing

### Example 4: GraphQL API Testing

**Context**: Test GraphQL endpoints with queries and mutations.

**Implementation**:

```typescript
// tests/api/graphql.spec.ts
import { test, expect } from "@seontechnologies/playwright-utils/api-request/fixtures";

const GRAPHQL_ENDPOINT = "/graphql";

test.describe("GraphQL API", () => {
  test("should query users", async ({ apiRequest }) => {
    const query = `
      query GetUsers($limit: Int) {
        users(limit: $limit) {
          id
          name
          email
          role
        }
      }
    `;

    const { status, body } = await apiRequest({
      method: "POST",
      path: GRAPHQL_ENDPOINT,
      body: {
        query,
        variables: { limit: 10 },
      },
    });

    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data.users).toHaveLength(10);
    expect(body.data.users[0]).toHaveProperty("id");
    expect(body.data.users[0]).toHaveProperty("name");
  });

  test("should create user via mutation", async ({ apiRequest }) => {
    const mutation = `
      mutation CreateUser($input: CreateUserInput!) {
        createUser(input: $input) {
          id
          name
          email
        }
      }
    `;

    const { status, body } = await apiRequest({
      method: "POST",
      path: GRAPHQL_ENDPOINT,
      body: {
        query: mutation,
        variables: {
          input: {
            name: "GraphQL User",
            email: "graphql@example.com",
          },
        },
      },
    });

    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data.createUser.id).toBeDefined();
    expect(body.data.createUser.name).toBe("GraphQL User");
  });

  test("should handle GraphQL errors", async ({ apiRequest }) => {
    const query = `
      query GetUser($id: ID!) {
        user(id: $id) {
          id
          name
        }
      }
    `;

    const { status, body } = await apiRequest({
      method: "POST",
      path: GRAPHQL_ENDPOINT,
      body: {
        query,
        variables: { id: "non-existent" },
      },
    });

    expect(status).toBe(200); // GraphQL returns 200 even for errors
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toContain("not found");
    expect(body.data.user).toBeNull();
  });

  test("should handle validation errors", async ({ apiRequest }) => {
    const mutation = `
      mutation CreateUser($input: CreateUserInput!) {
        createUser(input: $input) {
          id
        }
      }
    `;

    const { status, body } = await apiRequest({
      method: "POST",
      path: GRAPHQL_ENDPOINT,
      body: {
        query: mutation,
        variables: {
          input: {
            name: "", // Invalid: empty name
            email: "invalid-email", // Invalid: bad format
          },
        },
      },
    });

    expect(status).toBe(200);
    expect(body.errors).toBeDefined();
    expect(body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
  });
});
```

**Key Points**:

- GraphQL queries and mutations via POST
- Variables passed in request body
- GraphQL returns 200 even for errors (check `body.errors`)
- Test validation and business logic errors

### Example 5: Database Seeding and Cleanup via API

**Context**: Use API calls to set up and tear down test data without direct database access.

**Implementation**:

```typescript
// tests/api/with-data-setup.spec.ts
import { test, expect } from "@seontechnologies/playwright-utils/fixtures";

test.describe("Orders with Data Setup", () => {
  let testUser: { id: string; email: string };
  let testProducts: Array<{ id: string; name: string; price: number }>;

  test.beforeAll(async ({ request }) => {
    // Seed user via API
    const userResponse = await request.post("/api/users", {
      data: {
        name: "Test User",
        email: `test-${Date.now()}@example.com`,
      },
    });
    testUser = await userResponse.json();

    // Seed products via API
    testProducts = [];
    for (const product of [
      { name: "Widget A", price: 29.99 },
      { name: "Widget B", price: 49.99 },
      { name: "Widget C", price: 99.99 },
    ]) {
      const productResponse = await request.post("/api/products", {
        data: product,
      });
      testProducts.push(await productResponse.json());
    }
  });

  test.afterAll(async ({ request }) => {
    // Cleanup via API
    if (testUser?.id) {
      await request.delete(`/api/users/${testUser.id}`);
    }
    for (const product of testProducts) {
      await request.delete(`/api/products/${product.id}`);
    }
  });

  test("should create order with seeded data", async ({ apiRequest }) => {
    const { status, body } = await apiRequest({
      method: "POST",
      path: "/api/orders",
      body: {
        userId: testUser.id,
        items: [
          { productId: testProducts[0].id, quantity: 2 },
          { productId: testProducts[1].id, quantity: 1 },
        ],
      },
    });

    expect(status).toBe(201);
    expect(body.userId).toBe(testUser.id);
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(2 * 29.99 + 49.99);
  });

  test("should list user orders", async ({ apiRequest }) => {
    // Create an order first
    await apiRequest({
      method: "POST",
      path: "/api/orders",
      body: {
        userId: testUser.id,
        items: [{ productId: testProducts[2].id, quantity: 1 }],
      },
    });

    // List orders for user
    const { status, body } = await apiRequest({
      method: "GET",
      path: "/api/orders",
      params: { userId: testUser.id },
    });

    expect(status).toBe(200);
    expect(body.orders.length).toBeGreaterThanOrEqual(1);
    expect(body.orders.every((o: any) => o.userId === testUser.id)).toBe(true);
  });
});
```

**Key Points**:

- `beforeAll`/`afterAll` for test data setup/cleanup
- API-based seeding (no direct DB access needed)
- Unique emails to prevent conflicts in parallel runs
- Cleanup after all tests complete

### Example 6: Background Job Testing with Recurse

**Context**: Test async operations like background jobs, webhooks, and eventual consistency.

**Implementation**:

```typescript
// tests/api/background-jobs.spec.ts
import { test, expect } from "@seontechnologies/playwright-utils/fixtures";

test.describe("Background Jobs", () => {
  test("should process export job", async ({ apiRequest, recurse }) => {
    // Trigger export job
    const { body: job } = await apiRequest({
      method: "POST",
      path: "/api/exports",
      body: {
        type: "users",
        format: "csv",
        filters: { createdAfter: "2024-01-01" },
      },
    });

    expect(job.id).toBeDefined();
    expect(job.status).toBe("pending");

    // Poll until job completes
    const { body: completedJob } = await recurse(
      () => apiRequest({ method: "GET", path: `/api/exports/${job.id}` }),
      (response) => response.body.status === "completed",
      {
        timeout: 60000,
        interval: 2000,
        log: `Waiting for export job ${job.id} to complete`,
      },
    );

    expect(completedJob.status).toBe("completed");
    expect(completedJob.downloadUrl).toBeDefined();
    expect(completedJob.recordCount).toBeGreaterThan(0);
  });

  test("should handle job failure gracefully", async ({ apiRequest, recurse }) => {
    // Trigger job that will fail
    const { body: job } = await apiRequest({
      method: "POST",
      path: "/api/exports",
      body: {
        type: "invalid-type", // This will cause failure
        format: "csv",
      },
    });

    // Poll until job fails
    const { body: failedJob } = await recurse(
      () => apiRequest({ method: "GET", path: `/api/exports/${job.id}` }),
      (response) => ["completed", "failed"].includes(response.body.status),
      { timeout: 30000 },
    );

    expect(failedJob.status).toBe("failed");
    expect(failedJob.error).toBeDefined();
    expect(failedJob.error.code).toBe("INVALID_EXPORT_TYPE");
  });

  test("should process webhook delivery", async ({ apiRequest, recurse }) => {
    // Trigger action that sends webhook
    const { body: order } = await apiRequest({
      method: "POST",
      path: "/api/orders",
      body: {
        userId: "user-123",
        items: [{ productId: "prod-1", quantity: 1 }],
        webhookUrl: "https://webhook.site/test-endpoint",
      },
    });

    // Poll for webhook delivery status
    const { body: webhookStatus } = await recurse(
      () => apiRequest({ method: "GET", path: `/api/webhooks/order/${order.id}` }),
      (response) => response.body.delivered === true,
      { timeout: 30000, interval: 1000 },
    );

    expect(webhookStatus.delivered).toBe(true);
    expect(webhookStatus.deliveredAt).toBeDefined();
    expect(webhookStatus.responseStatus).toBe(200);
  });
});
```

**Key Points**:

- `recurse` for polling async operations
- Test both success and failure scenarios
- Configurable timeout and interval
- Log messages for debugging

### Example 7: Service Authentication (No Browser)

**Context**: Test authenticated API endpoints using tokens directly - no browser login needed.

**Implementation**:

```typescript
// tests/api/authenticated.spec.ts
import { test, expect } from "@seontechnologies/playwright-utils/fixtures";

test.describe("Authenticated API Tests", () => {
  let authToken: string;

  test.beforeAll(async ({ request }) => {
    // Get token via API (no browser!)
    const response = await request.post("/api/auth/login", {
      data: {
        email: process.env.TEST_USER_EMAIL,
        password: process.env.TEST_USER_PASSWORD,
      },
    });

    const { token } = await response.json();
    authToken = token;
  });

  test("should access protected endpoint with token", async ({ apiRequest }) => {
    const { status, body } = await apiRequest({
      method: "GET",
      path: "/api/me",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });

    expect(status).toBe(200);
    expect(body.email).toBe(process.env.TEST_USER_EMAIL);
  });

  test("should reject request without token", async ({ apiRequest }) => {
    const { status, body } = await apiRequest({
      method: "GET",
      path: "/api/me",
      // No Authorization header
    });

    expect(status).toBe(401);
    expect(body.code).toBe("UNAUTHORIZED");
  });

  test("should reject expired token", async ({ apiRequest }) => {
    const expiredToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."; // Expired token

    const { status, body } = await apiRequest({
      method: "GET",
      path: "/api/me",
      headers: {
        Authorization: `Bearer ${expiredToken}`,
      },
    });

    expect(status).toBe(401);
    expect(body.code).toBe("TOKEN_EXPIRED");
  });

  test("should handle role-based access", async ({ apiRequest }) => {
    // User token (non-admin)
    const { status } = await apiRequest({
      method: "GET",
      path: "/api/admin/users",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });

    expect(status).toBe(403); // Forbidden for non-admin
  });
});
```

**Key Points**:

- Token obtained via API login (no browser)
- Token reused across all tests in describe block
- Test auth, expired tokens, and RBAC
- Pure API testing without UI

### Example 8: Operation-Based API Testing (OpenAPI / Code Generators)

**Context**: When your project uses code-generated operation definitions from an OpenAPI spec, leverage the operation-based overload of `apiRequest` (v3.14.0+) instead of manual `method`/`path` extraction. This eliminates `typeof` assertions and provides full type inference for request body, response, and query parameters.

**Implementation**:

```typescript
// tests/api/operations.spec.ts
import { test, expect } from "@seontechnologies/playwright-utils/api-request/fixtures";

test.describe("API Tests with Generated Operations", () => {
  test("should create entity with full type safety", async ({ apiRequest }) => {
    // Operation object from code generator — contains path, method, and type info
    const { status, body } = await apiRequest({
      operation: createEntityOp({ workspaceId }),
      headers: getHeaders(workspaceId),
      body: entityInput, // Compile-time typed from operation.request
    });

    expect(status).toBe(201);
    expect(body.id).toBeDefined(); // body typed from operation.response
  });

  test("should list with typed query parameters", async ({ apiRequest }) => {
    // query field replaces manual string concatenation
    const { body } = await apiRequest({
      operation: listEntitiesOp({ workspaceId }),
      headers: getHeaders(workspaceId),
      query: { page: 0, page_size: 10, status: "active" },
    });

    expect(body.items).toHaveLength(10);
    expect(body.total).toBeGreaterThan(10);
  });

  test("should poll async operation until complete", async ({ apiRequest, recurse }) => {
    const { body: job } = await apiRequest({
      operation: startJobOp({ workspaceId }),
      headers: getHeaders(workspaceId),
      body: { type: "export" },
    });

    await recurse(
      async () =>
        apiRequest({
          operation: getJobOp({ workspaceId, jobId: job.id }),
          headers: getHeaders(workspaceId),
        }),
      (res) => res.body.status === "completed",
      { timeout: 60000, interval: 2000 },
    );
  });
});
```

**Key Points**:

- `operation` replaces `method` + `path` — mutually exclusive at compile time
- Types for body, response, and query all inferred from the operation definition
- Works with any code generator using structural typing (no imports from playwright-utils needed in generator)
- Composable with `recurse`, `validateSchema`, and all existing `apiRequest` features
- Preferred approach over `typeof operation.response` for generated operations

## API Test Configuration

### Playwright Config for API-Only Tests

```typescript
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/api",

  // No browser needed for API tests
  use: {
    baseURL: process.env.API_URL || "http://localhost:3000",
    extraHTTPHeaders: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  },

  // Faster without browser overhead
  timeout: 30000,

  // Run API tests in parallel
  workers: 4,
  fullyParallel: true,

  // No screenshots/traces needed for API tests
  reporter: [["html"], ["json", { outputFile: "api-test-results.json" }]],
});
```

### Separate API Test Project

```typescript
// playwright.config.ts
export default defineConfig({
  projects: [
    {
      name: "api",
      testDir: "./tests/api",
      use: {
        baseURL: process.env.API_URL,
      },
    },
    {
      name: "e2e",
      testDir: "./tests/e2e",
      use: {
        baseURL: process.env.APP_URL,
        ...devices["Desktop Chrome"],
      },
    },
  ],
});
```

## Comparison: API Tests vs E2E Tests

| Aspect              | API Test               | E2E Test                    |
| ------------------- | ---------------------- | --------------------------- |
| **Speed**           | ~50-100ms per test     | ~2-10s per test             |
| **Stability**       | Very stable            | More flaky (UI timing)      |
| **Setup**           | Minimal                | Browser, context, page      |
| **Debugging**       | Clear request/response | DOM, screenshots, traces    |
| **Coverage**        | Service logic          | User experience             |
| **Parallelization** | Easy (stateless)       | Complex (browser resources) |
| **CI Cost**         | Low (no browser)       | High (browser containers)   |

## Related Fragments

- `api-request.md` - apiRequest utility details
- `recurse.md` - Polling patterns for async operations
- `auth-session.md` - Token management
- `contract-testing.md` - Pact contract testing
- `test-levels-framework.md` - When to use which test level
- `data-factories.md` - Test data setup patterns

## Anti-Patterns

**DON'T use E2E for API validation:**

```typescript
// Bad: Testing API through UI
test("validate user creation", async ({ page }) => {
  await page.goto("/admin/users");
  await page.fill("#name", "John");
  await page.click("#submit");
  await expect(page.getByText("User created")).toBeVisible();
});
```

**DO test APIs directly:**

```typescript
// Good: Direct API test
test("validate user creation", async ({ apiRequest }) => {
  const { status, body } = await apiRequest({
    method: "POST",
    path: "/api/users",
    body: { name: "John" },
  });
  expect(status).toBe(201);
  expect(body.id).toBeDefined();
});
```

**DON'T ignore API tests because "E2E covers it":**

```typescript
// Bad thinking: "Our E2E tests create users, so API is tested"
// Reality: E2E tests one happy path; API tests cover edge cases
```

**DO have dedicated API test coverage:**

```typescript
// Good: Explicit API test suite
test.describe("Users API", () => {
  test("creates user", async ({ apiRequest }) => {
    /* ... */
  });
  test("handles duplicate email", async ({ apiRequest }) => {
    /* ... */
  });
  test("validates required fields", async ({ apiRequest }) => {
    /* ... */
  });
  test("handles malformed JSON", async ({ apiRequest }) => {
    /* ... */
  });
  test("rate limits requests", async ({ apiRequest }) => {
    /* ... */
  });
});
```
