# Pact Consumer DI Pattern

## Principle

Inject the Pact mock server URL into consumer code via an optional `baseUrl` field on the API context type instead of using raw `fetch()` inside `executeTest()`. This ensures contract tests exercise the real consumer HTTP client — including retry logic, header assembly, timeout configuration, error handling, and metrics — rather than testing Pact itself.

The base URL is typically a module-level constant evaluated at import time (`export const API_BASE_URL = env.SEON_API_URL`), but `mockServer.url` is only available at runtime inside `executeTest()`. Dependency injection solves this timing mismatch cleanly: add one optional field to the context type, use nullish coalescing in the HTTP client factory, and inject the mock server URL in tests.

## Rationale

### The Problem

Raw `fetch()` in `executeTest()` only proves that Pact returns what you told it to return. The real consumer HTTP client has retry logic, header assembly, timeout configuration, error handling, and metrics collection — none of which are exercised when you hand-craft fetch calls. Contracts written with raw fetch are hand-maintained guesses about what the consumer actually sends.

### Why NOT vi.mock

`vi.mock` with ESM (`module: Node16`) has hoisting quirks that make it unreliable for overriding module-level constants. A getter-based mock is non-obvious and fragile — it works until the next bundler or TypeScript config change breaks it. DI is a standard pattern that requires zero mock magic and works across all module systems.

### Comparison

| Approach     | Production code change | Mock complexity            | Exercises real client | Contract accuracy           |
| ------------ | ---------------------- | -------------------------- | --------------------- | --------------------------- |
| Raw fetch    | None                   | None                       | No                    | Low — hand-crafted requests |
| vi.mock      | None                   | High — ESM hoisting issues | Yes                   | Medium — fragile setup      |
| DI (baseUrl) | 2 lines                | None                       | Yes                   | High — real requests        |

## Pattern Examples

### Example 1: Production Code Change (2 Lines Total)

**Context**: Add an optional `baseUrl` field to the API context type and use nullish coalescing in the HTTP client factory. This is the entire production code change required.

**Implementation**:

```typescript
// src/types.ts
export type ApiContext = {
  jwtToken: string;
  customerId: number;
  adminUserId?: number;
  correlationId?: string;
  baseUrl?: string; // Override for testing (Pact mock server)
};
```

```typescript
// src/http-client.ts
import axios from "axios";
import type { AxiosInstance } from "axios";
import type { ApiContext } from "./types.js";
import { API_BASE_URL, REQUEST_TIMEOUT } from "./constants.js";

function createAxiosInstanceWithContext(context: ApiContext): AxiosInstance {
  return axios.create({
    baseURL: context.baseUrl ?? API_BASE_URL,
    timeout: REQUEST_TIMEOUT,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${context.jwtToken}`,
      ...(context.correlationId && { "X-Request-Id": context.correlationId }),
    },
  });
}
```

**Key Points**:

- `baseUrl` is optional — existing production code never sets it
- `??` (nullish coalescing) falls back to `API_BASE_URL` when `baseUrl` is undefined
- Zero production behavior change — only test code provides the override
- Two lines added total: one type field, one `??` fallback

### Example 2: Shared Test Context Helper

**Context**: Create a reusable helper that builds an `ApiContext` with the mock server URL injected. One helper shared across all consumer test files.

**Implementation**:

```typescript
// pact/support/test-context.ts
import type { ApiContext } from "../../src/types.js";

export function createTestContext(mockServerUrl: string): ApiContext {
  return {
    jwtToken: "test-jwt-token",
    customerId: 1,
    baseUrl: `${mockServerUrl}/api/v2`,
  };
}
```

**Key Points**:

- `baseUrl` should include the API version prefix when consumer methods use versionless relative paths (e.g., `/transactions`) or endpoint paths are defined without the version segment
- Single helper shared across all consumer test files — no repetition
- Returns a plain object — follows pure-function-first pattern from `fixture-architecture.md`
- Add fields as needed (e.g., `adminUserId`, `correlationId`) for specific test scenarios

### Example 3: Before/After for a Simple Test

**Context**: Migrating an existing raw-fetch test to call real consumer code.

**Before** (raw fetch — tests Pact mock, not consumer code):

```typescript
.executeTest(async (mockServer: V3MockServer) => {
  const response = await fetch(
    `${mockServer.url}/api/v2/common/fields?ruleType=!&ignoreFeatureFlags=true`,
    {
      headers: {
        Authorization: "Bearer test-jwt-token",
        "Content-Type": "application/json",
      },
    },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, unknown>[];
  expect(body).toEqual(expect.arrayContaining([...]));
});
```

**After** (real consumer code):

```typescript
.executeTest(async (mockServer: V3MockServer) => {
  const api = createSeonApi(createTestContext(mockServer.url));
  const result = await api.getFilterFields();
  expect(result).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: expect.any(String),
        readable: expect.any(String),
        filterType: expect.any(String),
      }),
    ]),
  );
});
```

**Key Points**:

- No HTTP status assertion — the consumer method throws on non-2xx, so reaching the expect proves success
- Assertions validate the return value shape, not transport details
- The real client's headers, timeout, and retry logic are exercised transparently
- Less code, more coverage — the test is shorter and tests more

### Example 4: Contract Accuracy Fix

**Context**: Using real consumer code revealed a contract mismatch that raw fetch silently hid. This is the strongest argument for the pattern.

The real `getCustomerActivityCount(transactionId, dateRange)` sends:

```json
{ "transactionId": "txn-123", "filters": { "dateRange": "last_30_days" } }
```

The old test with raw fetch sent:

```json
{ "transactionId": "txn-123", "filters": {} }
```

This was wrong but passed because raw fetch let you hand-craft any body. When switched to real code, Pact immediately returned a 500 Request-Mismatch because the body shape did not match the interaction.

**Implementation** — fix the contract to match reality:

```typescript
// WRONG — old contract with empty filters
.withRequest({
  method: "POST",
  path: "/api/v2/customers/activity/count",
  body: { transactionId: "txn-123", filters: {} },
})

// CORRECT — matches what real code actually sends
.withRequest({
  method: "POST",
  path: "/api/v2/customers/activity/count",
  body: {
    transactionId: "txn-123",
    filters: { dateRange: "last_30_days" },
  },
})
```

**Key Points**:

- Contracts become discoverable truth, not hand-maintained guesses
- Raw fetch silently hid the mismatch — the mock accepted whatever you sent
- The 500 Request-Mismatch from Pact was immediate and clear
- Fix the contract when real code reveals a mismatch — that mismatch is a bug the old tests were hiding

### Example 5: Parallel-Endpoint Methods

**Context**: Facade methods that call multiple endpoints via `Promise.all` (e.g., `getTransactionStats` calls count + score + amount in parallel). Keep separate `it` blocks per endpoint and use the lower-level request function directly.

**Implementation**:

```typescript
import { describe, it, expect } from "vitest";
import type { V3MockServer } from "@pact-foundation/pact";
import { makeApiRequestWithContext } from "../../src/http-client.js";
import type { CountStatistics } from "../../src/types.js";
import { createTestContext } from "../support/test-context.js";

describe("Transaction Statistics - Count Endpoint", () => {
  // ... provider setup ...

  it("should return count statistics", async () => {
    const statsRequest = { transactionId: "txn-123", period: "daily" };

    await provider
      .given("transaction statistics exist")
      .uponReceiving("a request for transaction count statistics")
      .withRequest({
        method: "POST",
        path: "/api/v2/transactions/statistics/count",
        body: statsRequest,
      })
      .willRespondWith({
        status: 200,
        body: { count: 42, period: "daily" },
      })
      .executeTest(async (mockServer: V3MockServer) => {
        const context = createTestContext(mockServer.url);
        const result = await makeApiRequestWithContext<CountStatistics>(
          context,
          "/transactions/statistics/count",
          "POST",
          statsRequest,
        );
        expect(result.count).toBeDefined();
      });
  });
});
```

**Key Points**:

- Each Pact interaction verifies one endpoint contract
- The `Promise.all` orchestration is internal logic, not a contract concern
- Use `makeApiRequestWithContext` (lower-level) when the facade method bundles multiple calls
- Separate `it` blocks keep contracts independent and debuggable

## Anti-Patterns

### Wrong: Raw fetch — tests Pact mock, not consumer code

```typescript
// BAD: Raw fetch duplicates headers and URL assembly
const response = await fetch(`${mockServer.url}/api/v2/transactions`, {
  method: "GET",
  headers: {
    Authorization: "Bearer test-jwt-token",
    "Content-Type": "application/json",
  },
});
expect(response.status).toBe(200);
```

### Wrong: vi.mock with getter — fragile ESM hoisting

```typescript
// BAD: ESM hoisting makes this non-obvious and brittle
vi.mock("../../src/constants.js", async (importOriginal) => ({
  ...(await importOriginal()),
  get API_BASE_URL() {
    return mockBaseUrl;
  },
}));
```

### Wrong: Asserting HTTP status instead of return value

```typescript
// BAD: Status 200 tells you nothing about the consumer's parsing logic
expect(response.status).toBe(200);
```

### Right: Call real consumer code, assert return values

```typescript
// GOOD: Exercises real client, validates parsed return value
const api = createSeonApi(createTestContext(mockServer.url));
const result = await api.searchTransactions(request);
expect(result.transactions).toBeDefined();
```

## Rules

1. `baseUrl` field MUST be optional with fallback via `??` (nullish coalescing)
2. Zero production behavior change — existing code never sets `baseUrl`
3. Assertions validate return values from consumer methods, not HTTP status codes
4. For parallel-endpoint facade methods, keep separate `it` blocks per endpoint
5. Include the API version prefix in `baseUrl` when endpoint paths/consumer methods are versionless (for example, methods call `/transactions` instead of `/api/v2/transactions`)
6. Create a single shared test context helper — no repetition across test files
7. If real code reveals a contract mismatch, fix the contract — that mismatch is a bug the old tests were hiding

## Integration Points

- `contract-testing.md` — Foundational Pact.js patterns and provider verification
- `pactjs-utils-consumer-helpers.md` — `createProviderState()`, `setJsonContent()`, and `setJsonBody()` helpers used alongside this pattern
- `pactjs-utils-provider-verifier.md` — Provider-side verification configuration
- `fixture-architecture.md` — Composable fixture patterns (`createTestContext` follows pure-function-first)
- `api-testing-foundations.md` — API testing best practices

Used in workflows:

- `automate` — Consumer contract test generation
- `test-review` — Contract test quality checks

## Source

Pattern derived from seon-mcp-server Pact consumer test refactor (March 2026). Implements dependency injection for testability as described in Pact.js best practices.
