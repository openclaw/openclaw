# Recurse (Polling) Utility

## Principle

Use Cypress-style polling with Playwright's `expect.poll` to wait for asynchronous conditions. Provides configurable timeout, interval, logging, and post-polling callbacks with enhanced error categorization. **Ideal for backend testing**: polling API endpoints for job completion, database eventual consistency, message queue processing, and cache propagation.

## Rationale

Testing async operations (background jobs, eventual consistency, webhook processing) requires polling:

- Vanilla `expect.poll` is verbose
- No built-in logging for debugging
- Generic timeout errors
- No post-poll hooks

The `recurse` utility provides:

- **Clean syntax**: Inspired by cypress-recurse
- **Enhanced errors**: Timeout vs command failure vs predicate errors
- **Built-in logging**: Track polling progress
- **Post-poll callbacks**: Process results after success
- **Type-safe**: Full TypeScript generic support

## Quick Start

```typescript
import { test } from "@seontechnologies/playwright-utils/recurse/fixtures";

test("wait for job completion", async ({ recurse, apiRequest }) => {
  const { body } = await apiRequest({
    method: "POST",
    path: "/api/jobs",
    body: { type: "export" },
  });

  // Poll until job completes
  const result = await recurse(
    () => apiRequest({ method: "GET", path: `/api/jobs/${body.id}` }),
    (response) => response.body.status === "completed",
    { timeout: 60000 },
  );

  expect(result.body.downloadUrl).toBeDefined();
});
```

## Pattern Examples

### Example 1: Basic Polling

**Context**: Wait for async operation to complete with custom timeout and interval.

**Implementation**:

```typescript
import { test } from "@seontechnologies/playwright-utils/recurse/fixtures";

test("should wait for job completion", async ({ recurse, apiRequest }) => {
  // Start job
  const { body } = await apiRequest({
    method: "POST",
    path: "/api/jobs",
    body: { type: "export" },
  });

  // Poll until ready
  const result = await recurse(
    () => apiRequest({ method: "GET", path: `/api/jobs/${body.id}` }),
    (response) => response.body.status === "completed",
    {
      timeout: 60000, // 60 seconds max
      interval: 2000, // Check every 2 seconds
      log: "Waiting for export job to complete",
    },
  );

  expect(result.body.downloadUrl).toBeDefined();
});
```

**Key Points**:

- First arg: command function (what to execute)
- Second arg: predicate function (when to stop)
- Options: timeout, interval, log message
- Returns the value when predicate returns true

### Example 2: Working with Assertions

**Context**: Use assertions directly in predicate for more expressive tests.

**Implementation**:

```typescript
test("should poll with assertions", async ({ recurse, apiRequest }) => {
  await apiRequest({
    method: "POST",
    path: "/api/events",
    body: { type: "user-created", userId: "123" },
  });

  // Poll with assertions in predicate - no return true needed!
  await recurse(
    async () => {
      const { body } = await apiRequest({ method: "GET", path: "/api/events/123" });
      return body;
    },
    (event) => {
      // If all assertions pass, predicate succeeds
      expect(event.processed).toBe(true);
      expect(event.timestamp).toBeDefined();
      // No need to return true - just let assertions pass
    },
    { timeout: 30000 },
  );
});
```

**Why no `return true` needed?**

The predicate checks for "truthiness" of the return value. But there's a catch - in JavaScript, an empty `return` (or no return) returns `undefined`, which is falsy!

The utility handles this by checking if:

1. The predicate didn't throw (assertions passed)
2. The return value was either `undefined` (implicit return) or truthy

So you can:

```typescript
// Option 1: Use assertions only (recommended)
(event) => {
  expect(event.processed).toBe(true);
};

// Option 2: Return boolean (also works)
(event) => event.processed === true;

// Option 3: Mixed (assertions + explicit return)
(event) => {
  expect(event.processed).toBe(true);
  return true;
};
```

### Example 3: Error Handling

**Context**: Understanding the different error types.

**Error Types:**

```typescript
// RecurseTimeoutError - Predicate never returned true within timeout
// Contains last command value and predicate error
try {
  await recurse(/* ... */);
} catch (error) {
  if (error instanceof RecurseTimeoutError) {
    console.log("Timed out. Last value:", error.lastCommandValue);
    console.log("Last predicate error:", error.lastPredicateError);
  }
}

// RecurseCommandError - Command function threw an error
// The command itself failed (e.g., network error, API error)

// RecursePredicateError - Predicate function threw (not from assertions failing)
// Logic error in your predicate code
```

**Custom Error Messages:**

```typescript
test("custom error on timeout", async ({ recurse, apiRequest }) => {
  try {
    await recurse(
      () => apiRequest({ method: "GET", path: "/api/status" }),
      (res) => res.body.ready === true,
      {
        timeout: 10000,
        error: "System failed to become ready within 10 seconds - check background workers",
      },
    );
  } catch (error) {
    // Error message includes custom context
    expect(error.message).toContain("check background workers");
    throw error;
  }
});
```

### Example 4: Post-Polling Callback

**Context**: Process or log results after successful polling.

**Implementation**:

```typescript
test("post-poll processing", async ({ recurse, apiRequest }) => {
  const finalResult = await recurse(
    () => apiRequest({ method: "GET", path: "/api/batch-job/123" }),
    (res) => res.body.status === "completed",
    {
      timeout: 60000,
      post: (result) => {
        // Runs after successful polling
        console.log(`Job completed in ${result.body.duration}ms`);
        console.log(`Processed ${result.body.itemsProcessed} items`);
        return result.body;
      },
    },
  );

  expect(finalResult.itemsProcessed).toBeGreaterThan(0);
});
```

**Key Points**:

- `post` callback runs after predicate succeeds
- Receives the final result
- Can transform or log results
- Return value becomes final `recurse` result

### Example 5: UI Testing Scenarios

**Context**: Wait for UI elements to reach a specific state through polling.

**Implementation**:

```typescript
test("table data loads", async ({ page, recurse }) => {
  await page.goto("/reports");

  // Poll for table rows to appear
  await recurse(
    async () => page.locator("table tbody tr").count(),
    (count) => count >= 10, // Wait for at least 10 rows
    {
      timeout: 15000,
      interval: 500,
      log: "Waiting for table data to load",
    },
  );

  // Now safe to interact with table
  await page.locator("table tbody tr").first().click();
});
```

### Example 6: Event-Based Systems (Kafka/Message Queues)

**Context**: Testing eventual consistency with message queue processing.

**Implementation**:

```typescript
test("kafka event processed", async ({ recurse, apiRequest }) => {
  // Trigger action that publishes Kafka event
  await apiRequest({
    method: "POST",
    path: "/api/orders",
    body: { productId: "ABC123", quantity: 2 },
  });

  // Poll for downstream effect of Kafka consumer processing
  const inventoryResult = await recurse(
    () => apiRequest({ method: "GET", path: "/api/inventory/ABC123" }),
    (res) => {
      // Assumes test fixture seeds inventory at 100; in production tests,
      // fetch baseline first and assert: expect(res.body.available).toBe(baseline - 2)
      expect(res.body.available).toBeLessThanOrEqual(98);
    },
    {
      timeout: 30000, // Kafka processing may take time
      interval: 1000,
      log: "Waiting for Kafka event to be processed",
    },
  );

  expect(inventoryResult.body.lastOrderId).toBeDefined();
});
```

### Example 7: Integration with API Request (Common Pattern)

**Context**: Most common use case - polling API endpoints for state changes.

**Implementation**:

```typescript
import { test } from "@seontechnologies/playwright-utils/fixtures";

test("end-to-end polling", async ({ apiRequest, recurse }) => {
  // Trigger async operation
  const { body: createResp } = await apiRequest({
    method: "POST",
    path: "/api/data-import",
    body: { source: "s3://bucket/data.csv" },
  });

  // Poll until import completes
  const importResult = await recurse(
    () => apiRequest({ method: "GET", path: `/api/data-import/${createResp.importId}` }),
    (response) => {
      const { status, rowsImported } = response.body;
      return status === "completed" && rowsImported > 0;
    },
    {
      timeout: 120000, // 2 minutes for large imports
      interval: 5000, // Check every 5 seconds
      log: `Polling import ${createResp.importId}`,
    },
  );

  expect(importResult.body.rowsImported).toBeGreaterThan(1000);
  expect(importResult.body.errors).toHaveLength(0);
});
```

**Key Points**:

- Combine `apiRequest` + `recurse` for API polling
- Both from `@seontechnologies/playwright-utils/fixtures`
- Complex predicates with multiple conditions
- Logging shows polling progress in test reports

## API Reference

### RecurseOptions

| Option     | Type               | Default     | Description                          |
| ---------- | ------------------ | ----------- | ------------------------------------ |
| `timeout`  | `number`           | `30000`     | Maximum time to wait (ms)            |
| `interval` | `number`           | `1000`      | Time between polls (ms)              |
| `log`      | `string`           | `undefined` | Message logged on each poll          |
| `error`    | `string`           | `undefined` | Custom error message for timeout     |
| `post`     | `(result: T) => R` | `undefined` | Callback after successful poll       |
| `delay`    | `number`           | `0`         | Initial delay before first poll (ms) |

### Error Types

| Error Type              | When Thrown                             | Properties                               |
| ----------------------- | --------------------------------------- | ---------------------------------------- |
| `RecurseTimeoutError`   | Predicate never passed within timeout   | `lastCommandValue`, `lastPredicateError` |
| `RecurseCommandError`   | Command function threw an error         | `cause` (original error)                 |
| `RecursePredicateError` | Predicate threw (not assertion failure) | `cause` (original error)                 |

## Comparison with Vanilla Playwright

| Vanilla Playwright                                                | recurse Utility                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `await expect.poll(() => { ... }, { timeout: 30000 }).toBe(true)` | `await recurse(() => { ... }, (val) => val === true, { timeout: 30000 })` |
| No logging                                                        | Built-in log option                                                       |
| Generic timeout errors                                            | Categorized errors (timeout/command/predicate)                            |
| No post-poll hooks                                                | `post` callback support                                                   |

## When to Use

**Use recurse for:**

- Background job completion
- Webhook/event processing
- Database eventual consistency
- Cache propagation
- State machine transitions

**Stick with vanilla expect.poll for:**

- Simple UI element visibility (use `expect(locator).toBeVisible()`)
- Single-property checks
- Cases where logging isn't needed

## Related Fragments

- `api-testing-patterns.md` - Comprehensive pure API testing patterns
- `api-request.md` - Combine for API endpoint polling
- `overview.md` - Fixture composition patterns
- `fixtures-composition.md` - Using with mergeTests
- `contract-testing.md` - Contract testing with async verification

## Anti-Patterns

**DON'T use hard waits instead of polling:**

```typescript
await page.click("#export");
await page.waitForTimeout(5000); // Arbitrary wait
expect(await page.textContent("#status")).toBe("Ready");
```

**DO poll for actual condition:**

```typescript
await page.click("#export");
await recurse(
  () => page.textContent("#status"),
  (status) => status === "Ready",
  { timeout: 10000 },
);
```

**DON'T poll too frequently:**

```typescript
await recurse(
  () => apiRequest({ method: "GET", path: "/status" }),
  (res) => res.body.ready,
  { interval: 100 }, // Hammers API every 100ms!
);
```

**DO use reasonable interval for API calls:**

```typescript
await recurse(
  () => apiRequest({ method: "GET", path: "/status" }),
  (res) => res.body.ready,
  { interval: 2000 }, // Check every 2 seconds (reasonable)
);
```
