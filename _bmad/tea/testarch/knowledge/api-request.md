# API Request Utility

## Principle

Use typed HTTP client with built-in schema validation and automatic retry for server errors. The utility handles URL resolution, header management, response parsing, and single-line response validation with proper TypeScript support. **Works without a browser** - ideal for pure API/service testing.

## Rationale

Vanilla Playwright's request API requires boilerplate for common patterns:

- Manual JSON parsing (`await response.json()`)
- Repetitive status code checking
- No built-in retry logic for transient failures
- No schema validation
- Complex URL construction

The `apiRequest` utility provides:

- **Automatic JSON parsing**: Response body pre-parsed
- **Built-in retry**: 5xx errors retry with exponential backoff
- **Schema validation**: Single-line validation (JSON Schema, Zod, OpenAPI)
- **URL resolution**: Four-tier strategy (explicit > config > Playwright > direct)
- **TypeScript generics**: Type-safe response bodies
- **No browser required**: Pure API testing without browser overhead

## Pattern Examples

### Example 1: Basic API Request

**Context**: Making authenticated API requests with automatic retry and type safety.

**Implementation**:

```typescript
import { test } from "@seontechnologies/playwright-utils/api-request/fixtures";

test("should fetch user data", async ({ apiRequest }) => {
  const { status, body } = await apiRequest<User>({
    method: "GET",
    path: "/api/users/123",
    headers: { Authorization: "Bearer token" },
  });

  expect(status).toBe(200);
  expect(body.name).toBe("John Doe"); // TypeScript knows body is User
});
```

**Key Points**:

- Generic type `<User>` provides TypeScript autocomplete for `body`
- Status and body destructured from response
- Headers passed as object
- Automatic retry for 5xx errors (configurable)

### Example 2: Schema Validation (Single Line)

**Context**: Validate API responses match expected schema with single-line syntax.

**Implementation**:

```typescript
import { test } from "@seontechnologies/playwright-utils/api-request/fixtures";
import { z } from "zod";

// JSON Schema validation
test("should validate response schema (JSON Schema)", async ({ apiRequest }) => {
  const { status, body } = await apiRequest({
    method: "GET",
    path: "/api/users/123",
    validateSchema: {
      type: "object",
      required: ["id", "name", "email"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        email: { type: "string", format: "email" },
      },
    },
  });
  // Throws if schema validation fails
  expect(status).toBe(200);
});

// Zod schema validation
const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});

test("should validate response schema (Zod)", async ({ apiRequest }) => {
  const { status, body } = await apiRequest({
    method: "GET",
    path: "/api/users/123",
    validateSchema: UserSchema,
  });
  // Response body is type-safe AND validated
  expect(status).toBe(200);
  expect(body.email).toContain("@");
});
```

**Key Points**:

- Single `validateSchema` parameter
- Supports JSON Schema, Zod, YAML files, OpenAPI specs
- Throws on validation failure with detailed errors
- Zero boilerplate validation code

### Example 3: POST with Body and Retry Configuration

**Context**: Creating resources with custom retry behavior for error testing.

**Implementation**:

```typescript
test("should create user", async ({ apiRequest }) => {
  const newUser = {
    name: "Jane Doe",
    email: "jane@example.com",
  };

  const { status, body } = await apiRequest({
    method: "POST",
    path: "/api/users",
    body: newUser, // Automatically sent as JSON
    headers: { Authorization: "Bearer token" },
  });

  expect(status).toBe(201);
  expect(body.id).toBeDefined();
});

// Disable retry for error testing
test("should handle 500 errors", async ({ apiRequest }) => {
  await expect(
    apiRequest({
      method: "GET",
      path: "/api/error",
      retryConfig: { maxRetries: 0 }, // Disable retry
    }),
  ).rejects.toThrow("Request failed with status 500");
});
```

**Key Points**:

- `body` parameter auto-serializes to JSON
- Default retry: 5xx errors, 3 retries, exponential backoff
- Disable retry with `retryConfig: { maxRetries: 0 }`
- Only 5xx errors retry (4xx errors fail immediately)

### Example 4: URL Resolution Strategy

**Context**: Flexible URL handling for different environments and test contexts.

**Implementation**:

```typescript
// Strategy 1: Explicit baseUrl (highest priority)
await apiRequest({
  method: "GET",
  path: "/users",
  baseUrl: "https://api.example.com", // Uses https://api.example.com/users
});

// Strategy 2: Config baseURL (from fixture)
import { test } from "@seontechnologies/playwright-utils/api-request/fixtures";

test.use({ configBaseUrl: "https://staging-api.example.com" });

test("uses config baseURL", async ({ apiRequest }) => {
  await apiRequest({
    method: "GET",
    path: "/users", // Uses https://staging-api.example.com/users
  });
});

// Strategy 3: Playwright baseURL (from playwright.config.ts)
// playwright.config.ts
export default defineConfig({
  use: {
    baseURL: "https://api.example.com",
  },
});

test("uses Playwright baseURL", async ({ apiRequest }) => {
  await apiRequest({
    method: "GET",
    path: "/users", // Uses https://api.example.com/users
  });
});

// Strategy 4: Direct path (full URL)
await apiRequest({
  method: "GET",
  path: "https://api.example.com/users", // Full URL works too
});
```

**Key Points**:

- Four-tier resolution: explicit > config > Playwright > direct
- Trailing slashes normalized automatically
- Environment-specific baseUrl easy to configure

### Example 5: Integration with Recurse (Polling)

**Context**: Waiting for async operations to complete (background jobs, eventual consistency).

**Implementation**:

```typescript
import { test } from "@seontechnologies/playwright-utils/fixtures";

test("should poll until job completes", async ({ apiRequest, recurse }) => {
  // Create job
  const { body } = await apiRequest({
    method: "POST",
    path: "/api/jobs",
    body: { type: "export" },
  });

  const jobId = body.id;

  // Poll until ready
  const completedJob = await recurse(
    () => apiRequest({ method: "GET", path: `/api/jobs/${jobId}` }),
    (response) => response.body.status === "completed",
    { timeout: 60000, interval: 2000 },
  );

  expect(completedJob.body.result).toBeDefined();
});
```

**Key Points**:

- `apiRequest` returns full response object
- `recurse` polls until predicate returns true
- Composable utilities work together seamlessly

### Example 6: Microservice Testing (Multiple Services)

**Context**: Test interactions between microservices without a browser.

**Implementation**:

```typescript
import { test, expect } from "@seontechnologies/playwright-utils/fixtures";

const USER_SERVICE = process.env.USER_SERVICE_URL || "http://localhost:3001";
const ORDER_SERVICE = process.env.ORDER_SERVICE_URL || "http://localhost:3002";

test.describe("Microservice Integration", () => {
  test("should validate cross-service user lookup", async ({ apiRequest }) => {
    // Create user in user-service
    const { body: user } = await apiRequest({
      method: "POST",
      path: "/api/users",
      baseUrl: USER_SERVICE,
      body: { name: "Test User", email: "test@example.com" },
    });

    // Create order in order-service (validates user via user-service)
    const { status, body: order } = await apiRequest({
      method: "POST",
      path: "/api/orders",
      baseUrl: ORDER_SERVICE,
      body: {
        userId: user.id,
        items: [{ productId: "prod-1", quantity: 2 }],
      },
    });

    expect(status).toBe(201);
    expect(order.userId).toBe(user.id);
  });

  test("should reject order for invalid user", async ({ apiRequest }) => {
    const { status, body } = await apiRequest({
      method: "POST",
      path: "/api/orders",
      baseUrl: ORDER_SERVICE,
      body: {
        userId: "non-existent-user",
        items: [{ productId: "prod-1", quantity: 1 }],
      },
    });

    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_USER");
  });
});
```

**Key Points**:

- Test multiple services without browser
- Use `baseUrl` to target different services
- Validate cross-service communication
- Pure API testing - fast and reliable

### Example 7: GraphQL API Testing

**Context**: Test GraphQL endpoints with queries and mutations.

**Implementation**:

```typescript
test.describe("GraphQL API", () => {
  const GRAPHQL_ENDPOINT = "/graphql";

  test("should query users via GraphQL", async ({ apiRequest }) => {
    const query = `
      query GetUsers($limit: Int) {
        users(limit: $limit) {
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
        query,
        variables: { limit: 10 },
      },
    });

    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data.users).toHaveLength(10);
  });

  test("should create user via mutation", async ({ apiRequest }) => {
    const mutation = `
      mutation CreateUser($input: CreateUserInput!) {
        createUser(input: $input) {
          id
          name
        }
      }
    `;

    const { status, body } = await apiRequest({
      method: "POST",
      path: GRAPHQL_ENDPOINT,
      body: {
        query: mutation,
        variables: {
          input: { name: "GraphQL User", email: "gql@example.com" },
        },
      },
    });

    expect(status).toBe(200);
    expect(body.data.createUser.id).toBeDefined();
  });
});
```

**Key Points**:

- GraphQL via POST request
- Variables in request body
- Check `body.errors` for GraphQL errors (not status code)
- Works for queries and mutations

### Example 8: Operation-Based Overload (OpenAPI / Code Generators)

**Context**: When using a code generator (orval, openapi-generator, custom scripts) that produces typed operation definitions from an OpenAPI spec, pass the operation object directly to `apiRequest`. This eliminates manual `method`/`path` extraction and `typeof` assertions while preserving full type inference for request body, response, and query parameters. Available since v3.14.0.

**Implementation**:

```typescript
// Generated operation definition — structural typing, no import from playwright-utils needed
// type OperationShape = { path: string; method: 'POST'|'GET'|'PUT'|'DELETE'|'PATCH'|'HEAD'; response: unknown; request: unknown; query?: unknown }

import { test, expect } from "@seontechnologies/playwright-utils/api-request/fixtures";

// --- Basic usage: operation replaces method + path ---
test("should upsert person via operation overload", async ({ apiRequest }) => {
  const { status, body } = await apiRequest({
    operation: upsertPersonv2({ customerId }),
    headers: getHeaders(customerId),
    body: personInput, // compile-time typed as Schemas.PersonInput
  });

  expect(status).toBe(200);
  expect(body.id).toBeDefined(); // body typed as Schemas.Person
});

// --- Typed query parameters (replaces string concatenation) ---
test("should list people with typed query", async ({ apiRequest }) => {
  const { body } = await apiRequest({
    operation: getPeoplev2({ customerId }),
    headers: getHeaders(customerId),
    query: { page: 0, page_size: 5 }, // typed from operation's query definition
  });

  expect(body.items).toHaveLength(5);
});

// --- Params escape hatch (pre-formatted query strings) ---
test("should fetch billing history with raw params", async ({ apiRequest }) => {
  const { body } = await apiRequest({
    operation: getBillingHistoryv2({ customerId }),
    headers: getHeaders(customerId),
    params: {
      "filters[start_date]": getThisMonthTimestamp(),
      "filters[date_type]": "MONTH",
    },
  });

  expect(body.entries.length).toBeGreaterThan(0);
});

// --- Works with recurse (polling) ---
test("should poll until person is reviewed", async ({ apiRequest, recurse }) => {
  await recurse(
    async () =>
      apiRequest({
        operation: getPersonv2({ customerId, hash }),
        headers: getHeaders(customerId),
      }),
    (res) => {
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("REVIEWED");
    },
    { timeout: 30000, interval: 1000 },
  );
});

// --- Schema validation chains work identically ---
test("should create movie with schema validation", async ({ apiRequest }) => {
  const { body } = await apiRequest({
    operation: createMovieOp,
    headers: commonHeaders(authToken),
    body: movie,
  }).validateSchema(CreateMovieResponseSchema, {
    shape: { status: 200, data: { name: movie.name } },
  });

  expect(body.data.id).toBeDefined();
});
```

**Key Points**:

- Pass `operation` instead of `method` + `path` — mutually exclusive at compile time
- Response body, request body, and query types inferred from operation definition
- Uses structural typing (duck typing) — works with any code generator producing `{ path, method, response, request, query? }`
- `query` field auto-serializes to bracket notation (`filters[type]=pep`, `ids[0]=10`)
- `params` escape hatch for pre-formatted strings — wins over `query` on conflict
- Fully composable with `recurse`, `validateSchema`, and all existing features
- `response`/`request`/`query` on the operation are type-level only — runtime never reads their values

## Comparison with Vanilla Playwright

| Vanilla Playwright                             | playwright-utils apiRequest                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `const resp = await request.get('/api/users')` | `const { status, body } = await apiRequest({ method: 'GET', path: '/api/users' })` |
| `const body = await resp.json()`               | Response already parsed                                                            |
| `expect(resp.ok()).toBeTruthy()`               | Status code directly accessible                                                    |
| No retry logic                                 | Auto-retry 5xx errors with backoff                                                 |
| No schema validation                           | Built-in multi-format validation                                                   |
| Manual error handling                          | Descriptive error messages                                                         |

## When to Use

**Use apiRequest for:**

- ✅ Pure API/service testing (no browser needed)
- ✅ Microservice integration testing
- ✅ GraphQL API testing
- ✅ Schema validation needs
- ✅ Tests requiring retry logic
- ✅ Background API calls in UI tests
- ✅ Contract testing support
- ✅ Type-safe API testing with OpenAPI-generated operations (v3.14.0+)

**Stick with vanilla Playwright for:**

- Simple one-off requests where utility overhead isn't worth it
- Testing Playwright's native features specifically
- Legacy tests where migration isn't justified

## Related Fragments

- `api-testing-patterns.md` - Comprehensive pure API testing patterns
- `overview.md` - Installation and design principles
- `auth-session.md` - Authentication token management
- `recurse.md` - Polling for async operations
- `fixtures-composition.md` - Combining utilities with mergeTests
- `log.md` - Logging API requests
- `contract-testing.md` - Pact contract testing

## Anti-Patterns

**❌ Ignoring retry failures:**

```typescript
try {
  await apiRequest({ method: "GET", path: "/api/unstable" });
} catch {
  // Silent failure - loses retry information
}
```

**✅ Let retries happen, handle final failure:**

```typescript
await expect(apiRequest({ method: "GET", path: "/api/unstable" })).rejects.toThrow(); // Retries happen automatically, then final error caught
```

**❌ Disabling TypeScript benefits:**

```typescript
const response: any = await apiRequest({ method: "GET", path: "/users" });
```

**✅ Use generic types:**

```typescript
const { body } = await apiRequest<User[]>({ method: "GET", path: "/users" });
// body is typed as User[]
```

**❌ Mixing operation overload with explicit generics:**

```typescript
// Don't pass a generic when using operation — types are inferred from the operation
const { body } = await apiRequest<MyType>({
  operation: getPersonv2({ customerId }),
  headers: getHeaders(customerId),
});
```

**✅ Let the operation infer the types:**

```typescript
const { body } = await apiRequest({
  operation: getPersonv2({ customerId }),
  headers: getHeaders(customerId),
});
// body type inferred from operation.response
```

**❌ Mixing operation with method/path:**

```typescript
// Compile error — operation and method/path are mutually exclusive
await apiRequest({
  operation: getPersonv2({ customerId }),
  method: "GET", // Error: method?: never
  path: "/api/person", // Error: path?: never
});
```
