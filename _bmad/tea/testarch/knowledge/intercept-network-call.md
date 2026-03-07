# Intercept Network Call Utility

## Principle

Intercept network requests with a single declarative call that returns a Promise. Automatically parse JSON responses, support both spy (observe) and stub (mock) patterns, and use powerful glob pattern matching for URL filtering.

## Rationale

Vanilla Playwright's network interception requires multiple steps:

- `page.route()` to setup, `page.waitForResponse()` to capture
- Manual JSON parsing
- Verbose syntax for conditional handling
- Complex filter predicates

The `interceptNetworkCall` utility provides:

- **Single declarative call**: Setup and wait in one statement
- **Automatic JSON parsing**: Response pre-parsed, strongly typed
- **Flexible URL patterns**: Glob matching with picomatch
- **Spy or stub modes**: Observe real traffic or mock responses
- **Concise API**: Reduces boilerplate by 60-70%

## Pattern Examples

### Example 1: Spy on Network (Observe Real Traffic)

**Context**: Capture and inspect real API responses for validation.

**Implementation**:

```typescript
import { test } from "@seontechnologies/playwright-utils/intercept-network-call/fixtures";

test("should spy on users API", async ({ page, interceptNetworkCall }) => {
  // Setup interception BEFORE navigation
  const usersCall = interceptNetworkCall({
    url: "**/api/users", // Glob pattern
  });

  await page.goto("/dashboard");

  // Wait for response and access parsed data
  const { responseJson, status } = await usersCall;

  expect(status).toBe(200);
  expect(responseJson).toHaveLength(10);
  expect(responseJson[0]).toHaveProperty("name");
});
```

**Key Points**:

- Intercept before navigation (critical for race-free tests)
- Returns Promise with `{ responseJson, status, requestBody }`
- Glob patterns (`**` matches any path segment)
- JSON automatically parsed

### Example 2: Stub Network (Mock Response)

**Context**: Mock API responses for testing UI behavior without backend.

**Implementation**:

```typescript
test("should stub users API", async ({ page, interceptNetworkCall }) => {
  const mockUsers = [
    { id: 1, name: "Test User 1" },
    { id: 2, name: "Test User 2" },
  ];

  const usersCall = interceptNetworkCall({
    url: "**/api/users",
    fulfillResponse: {
      status: 200,
      body: mockUsers,
    },
  });

  await page.goto("/dashboard");
  await usersCall;

  // UI shows mocked data
  await expect(page.getByText("Test User 1")).toBeVisible();
  await expect(page.getByText("Test User 2")).toBeVisible();
});
```

**Key Points**:

- `fulfillResponse` mocks the API
- No backend needed
- Test UI logic in isolation
- Status code and body fully controllable

### Example 3: Conditional Response Handling

**Context**: Different responses based on request method or parameters.

**Implementation**:

```typescript
test("conditional mocking", async ({ page, interceptNetworkCall }) => {
  await interceptNetworkCall({
    url: "**/api/data",
    handler: async (route, request) => {
      if (request.method() === "POST") {
        // Mock POST success
        await route.fulfill({
          status: 201,
          body: JSON.stringify({ id: "new-id", success: true }),
        });
      } else if (request.method() === "GET") {
        // Mock GET with data
        await route.fulfill({
          status: 200,
          body: JSON.stringify([{ id: 1, name: "Item" }]),
        });
      } else {
        // Let other methods through
        await route.continue();
      }
    },
  });

  await page.goto("/data-page");
});
```

**Key Points**:

- `handler` function for complex logic
- Access full `route` and `request` objects
- Can mock, continue, or abort
- Flexible for advanced scenarios

### Example 4: Error Simulation

**Context**: Testing error handling in UI when API fails.

**Implementation**:

```typescript
test("should handle API errors gracefully", async ({ page, interceptNetworkCall }) => {
  // Simulate 500 error
  const errorCall = interceptNetworkCall({
    url: "**/api/users",
    fulfillResponse: {
      status: 500,
      body: { error: "Internal Server Error" },
    },
  });

  await page.goto("/dashboard");
  await errorCall;

  // Verify UI shows error state
  await expect(page.getByText("Failed to load users")).toBeVisible();
  await expect(page.getByTestId("retry-button")).toBeVisible();
});

// Simulate network timeout
test("should handle timeout", async ({ page, interceptNetworkCall }) => {
  await interceptNetworkCall({
    url: "**/api/slow",
    handler: async (route) => {
      // Never respond - simulates timeout
      await new Promise(() => {});
    },
  });

  await page.goto("/slow-page");

  // UI should show timeout error
  await expect(page.getByText("Request timed out")).toBeVisible({ timeout: 10000 });
});
```

**Key Points**:

- Mock error statuses (4xx, 5xx)
- Test timeout scenarios
- Validate error UI states
- No real failures needed

### Example 5: Order Matters - Intercept Before Navigate

**Context**: The interceptor must be set up before the network request occurs.

**Implementation**:

```typescript
// INCORRECT - interceptor set up too late
await page.goto("https://example.com"); // Request already happened
const networkCall = interceptNetworkCall({ url: "**/api/data" });
await networkCall; // Will hang indefinitely!

// CORRECT - Set up interception first
const networkCall = interceptNetworkCall({ url: "**/api/data" });
await page.goto("https://example.com");
const result = await networkCall;
```

This pattern follows the classic test spy/stub pattern:

1. Define the spy/stub (set up interception)
2. Perform the action (trigger the network request)
3. Assert on the spy/stub (await and verify the response)

### Example 6: Multiple Intercepts

**Context**: Intercepting different endpoints in same test - setup order is critical.

**Implementation**:

```typescript
test("multiple intercepts", async ({ page, interceptNetworkCall }) => {
  // Setup all intercepts BEFORE navigation
  const usersCall = interceptNetworkCall({ url: "**/api/users" });
  const productsCall = interceptNetworkCall({ url: "**/api/products" });
  const ordersCall = interceptNetworkCall({ url: "**/api/orders" });

  // THEN navigate
  await page.goto("/dashboard");

  // Wait for all (or specific ones)
  const [users, products] = await Promise.all([usersCall, productsCall]);

  expect(users.responseJson).toHaveLength(10);
  expect(products.responseJson).toHaveLength(50);
});
```

**Key Points**:

- Setup all intercepts before triggering actions
- Use `Promise.all()` to wait for multiple calls
- Order: intercept -> navigate -> await
- Prevents race conditions

### Example 7: Capturing Multiple Requests to the Same Endpoint

**Context**: Each `interceptNetworkCall` captures only the first matching request.

**Implementation**:

```typescript
// Capturing a known number of requests
const firstRequest = interceptNetworkCall({ url: "/api/data" });
const secondRequest = interceptNetworkCall({ url: "/api/data" });

await page.click("#load-data-button");

const firstResponse = await firstRequest;
const secondResponse = await secondRequest;

expect(firstResponse.status).toBe(200);
expect(secondResponse.status).toBe(200);

// Handling an unknown number of requests
const getDataRequestInterceptor = () =>
  interceptNetworkCall({
    url: "/api/data",
    timeout: 1000, // Short timeout to detect when no more requests are coming
  });

let currentInterceptor = getDataRequestInterceptor();
const allResponses = [];

await page.click("#load-multiple-data-button");

while (true) {
  try {
    const response = await currentInterceptor;
    allResponses.push(response);
    currentInterceptor = getDataRequestInterceptor();
  } catch (error) {
    // No more requests (timeout)
    break;
  }
}

console.log(`Captured ${allResponses.length} requests to /api/data`);
```

### Example 8: Using Timeout

**Context**: Set a timeout for waiting on a network request.

**Implementation**:

```typescript
const dataCall = interceptNetworkCall({
  method: "GET",
  url: "/api/data-that-might-be-slow",
  timeout: 5000, // 5 seconds timeout
});

await page.goto("/data-page");

try {
  const { responseJson } = await dataCall;
  console.log("Data loaded successfully:", responseJson);
} catch (error) {
  if (error.message.includes("timeout")) {
    console.log("Request timed out as expected");
  } else {
    throw error;
  }
}
```

## URL Pattern Matching

The utility uses [picomatch](https://github.com/micromatch/picomatch) for powerful glob pattern matching, dramatically simplifying URL targeting:

**Supported glob patterns:**

```typescript
"**/api/users"; // Any path ending with /api/users
"/api/users"; // Exact match
"**/users/*"; // Any users sub-path
"**/api/{users,products}"; // Either users or products
"**/api/users?id=*"; // With query params
```

**Comparison with vanilla Playwright:**

```typescript
// Vanilla Playwright - complex predicate
const predicate = (response) => {
  const url = response.url();
  return (
    url.endsWith("/api/users") ||
    url.match(/\/api\/users\/\d+/) ||
    (url.includes("/api/users/") && url.includes("/profile"))
  );
};
page.waitForResponse(predicate);

// With interceptNetworkCall - simple glob patterns
interceptNetworkCall({ url: "/api/users" }); // Exact endpoint
interceptNetworkCall({ url: "/api/users/*" }); // User by ID pattern
interceptNetworkCall({ url: "/api/users/*/profile" }); // Specific sub-paths
interceptNetworkCall({ url: "/api/users/**" }); // Match all
```

## API Reference

### `interceptNetworkCall(options)`

| Parameter         | Type       | Description                                                           |
| ----------------- | ---------- | --------------------------------------------------------------------- |
| `page`            | `Page`     | Required when using direct import (not needed with fixture)           |
| `method`          | `string`   | Optional: HTTP method to match (e.g., 'GET', 'POST')                  |
| `url`             | `string`   | Optional: URL pattern to match (supports glob patterns via picomatch) |
| `fulfillResponse` | `object`   | Optional: Response to use when mocking                                |
| `handler`         | `function` | Optional: Custom handler function for the route                       |
| `timeout`         | `number`   | Optional: Timeout in milliseconds for the network request             |

### `fulfillResponse` Object

| Property  | Type                     | Description                                           |
| --------- | ------------------------ | ----------------------------------------------------- |
| `status`  | `number`                 | HTTP status code (default: 200)                       |
| `headers` | `Record<string, string>` | Response headers                                      |
| `body`    | `any`                    | Response body (will be JSON.stringified if an object) |

### Return Value

Returns a `Promise<NetworkCallResult>` with:

| Property       | Type       | Description                             |
| -------------- | ---------- | --------------------------------------- |
| `request`      | `Request`  | The intercepted request                 |
| `response`     | `Response` | The response (null if mocked)           |
| `responseJson` | `any`      | Parsed JSON response (if available)     |
| `status`       | `number`   | HTTP status code                        |
| `requestJson`  | `any`      | Parsed JSON request body (if available) |

## Comparison with Vanilla Playwright

| Vanilla Playwright                                          | intercept-network-call                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------ |
| `await page.route('/api/users', route => route.continue())` | `const call = interceptNetworkCall({ url: '**/api/users' })` |
| `const resp = await page.waitForResponse('/api/users')`     | (Combined in single statement)                               |
| `const json = await resp.json()`                            | `const { responseJson } = await call`                        |
| `const status = resp.status()`                              | `const { status } = await call`                              |
| Complex filter predicates                                   | Simple glob patterns                                         |

**Reduction:** ~5-7 lines -> ~2-3 lines per interception

## Related Fragments

- `network-first.md` - Core pattern: intercept before navigate
- `network-recorder.md` - HAR-based offline testing
- `overview.md` - Fixture composition basics

## Anti-Patterns

**DON'T intercept after navigation:**

```typescript
await page.goto("/dashboard"); // Navigation starts
const usersCall = interceptNetworkCall({ url: "**/api/users" }); // Too late!
```

**DO intercept before navigate:**

```typescript
const usersCall = interceptNetworkCall({ url: "**/api/users" }); // First
await page.goto("/dashboard"); // Then navigate
const { responseJson } = await usersCall; // Then await
```

**DON'T ignore the returned Promise:**

```typescript
interceptNetworkCall({ url: "**/api/users" }); // Not awaited!
await page.goto("/dashboard");
// No deterministic wait - race condition
```

**DO always await the intercept:**

```typescript
const usersCall = interceptNetworkCall({ url: "**/api/users" });
await page.goto("/dashboard");
await usersCall; // Deterministic wait
```
