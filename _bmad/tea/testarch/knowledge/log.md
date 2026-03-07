# Log Utility

## Principle

Use structured logging that integrates with Playwright's test reports. Support object logging, test step decoration, and multiple log levels (info, step, success, warning, error, debug).

## Rationale

Console.log in Playwright tests has limitations:

- Not visible in HTML reports
- No test step integration
- No structured output
- Lost in terminal noise during CI

The `log` utility provides:

- **Report integration**: Logs appear in Playwright HTML reports
- **Test step decoration**: `log.step()` creates collapsible steps in UI
- **Object logging**: Automatically formats objects/arrays
- **Multiple levels**: info, step, success, warning, error, debug
- **Optional console**: Can disable console output but keep report logs

## Quick Start

```typescript
import { log } from "@seontechnologies/playwright-utils";

// Basic logging
await log.info("Starting test");
await log.step("Test step shown in Playwright UI");
await log.success("Operation completed");
await log.warning("Something to note");
await log.error("Something went wrong");
await log.debug("Debug information");
```

## Pattern Examples

### Example 1: Basic Logging Levels

**Context**: Log different types of messages throughout test execution.

**Implementation**:

```typescript
import { log } from "@seontechnologies/playwright-utils";

test("logging demo", async ({ page }) => {
  await log.step("Navigate to login page");
  await page.goto("/login");

  await log.info("Entering credentials");
  await page.fill("#username", "testuser");

  await log.success("Login successful");

  await log.warning("Rate limit approaching");

  await log.debug({ userId: "123", sessionId: "abc" });

  // Errors still throw but get logged first
  try {
    await page.click("#nonexistent");
  } catch (error) {
    await log.error("Click failed", false); // false = no console output
    throw error;
  }
});
```

**Key Points**:

- `step()` creates collapsible steps in Playwright UI
- `info()`, `success()`, `warning()` for different message types
- `debug()` for detailed data (objects/arrays)
- `error()` with optional console suppression
- All logs appear in test reports

### Example 2: Object and Array Logging

**Context**: Log structured data for debugging without cluttering console.

**Implementation**:

```typescript
test("object logging", async ({ apiRequest }) => {
  const { body } = await apiRequest({
    method: "GET",
    path: "/api/users",
  });

  // Log array of objects
  await log.debug(body); // Formatted as JSON in report

  // Log specific object
  await log.info({
    totalUsers: body.length,
    firstUser: body[0]?.name,
    timestamp: new Date().toISOString(),
  });

  // Complex nested structures
  await log.debug({
    request: {
      method: "GET",
      path: "/api/users",
      timestamp: Date.now(),
    },
    response: {
      status: 200,
      body: body.slice(0, 3), // First 3 items
    },
  });
});
```

**Key Points**:

- Objects auto-formatted as pretty JSON
- Arrays handled gracefully
- Nested structures supported
- All visible in Playwright report attachments

### Example 3: Test Step Organization

**Context**: Organize test execution into collapsible steps for better readability in reports.

**Implementation**:

```typescript
test("organized with steps", async ({ page, apiRequest }) => {
  await log.step("ARRANGE: Setup test data");
  const { body: user } = await apiRequest({
    method: "POST",
    path: "/api/users",
    body: { name: "Test User" },
  });

  await log.step("ACT: Perform user action");
  await page.goto(`/users/${user.id}`);
  await page.click("#edit");
  await page.fill("#name", "Updated Name");
  await page.click("#save");

  await log.step("ASSERT: Verify changes");
  await expect(page.getByText("Updated Name")).toBeVisible();

  // In Playwright UI, each step is collapsible
});
```

**Key Points**:

- `log.step()` creates collapsible sections
- Organize by Arrange-Act-Assert
- Steps visible in Playwright trace viewer
- Better debugging when tests fail

### Example 4: Test Step Decorators

**Context**: Create collapsible test steps in Playwright UI using decorators.

**Page Object Methods with @methodTestStep:**

```typescript
import { methodTestStep } from "@seontechnologies/playwright-utils";

class TodoPage {
  constructor(private page: Page) {
    this.name = "TodoPage";
  }

  readonly name: string;

  @methodTestStep("Add todo item")
  async addTodo(text: string) {
    await log.info(`Adding todo: ${text}`);
    const newTodo = this.page.getByPlaceholder("What needs to be done?");
    await newTodo.fill(text);
    await newTodo.press("Enter");
    await log.step("step within a decorator");
    await log.success(`Added todo: ${text}`);
  }

  @methodTestStep("Get all todos")
  async getTodos() {
    await log.info("Getting all todos");
    return this.page.getByTestId("todo-title");
  }
}
```

**Function Helpers with functionTestStep:**

```typescript
import { functionTestStep } from "@seontechnologies/playwright-utils";

// Define todo items for the test
const TODO_ITEMS = ["buy groceries", "pay bills", "schedule meeting"];

const createDefaultTodos = functionTestStep("Create default todos", async (page: Page) => {
  await log.info("Creating default todos");
  await log.step("step within a functionWrapper");
  const todoPage = new TodoPage(page);

  for (const item of TODO_ITEMS) {
    await todoPage.addTodo(item);
  }

  await log.success("Created all default todos");
});

const checkNumberOfTodosInLocalStorage = functionTestStep(
  "Check total todos count fn-step",
  async (page: Page, expected: number) => {
    await log.info(`Verifying todo count: ${expected}`);
    const result = await page.waitForFunction(
      (e) => JSON.parse(localStorage["react-todos"]).length === e,
      expected,
    );
    await log.success(`Verified todo count: ${expected}`);
    return result;
  },
);
```

### Example 5: File Logging

**Context**: Enable file logging for persistent logs.

**Implementation**:

```typescript
// playwright/support/fixtures.ts
import { test as base } from "@playwright/test";
import { log, captureTestContext } from "@seontechnologies/playwright-utils";

// Configure file logging globally
log.configure({
  fileLogging: {
    enabled: true,
    outputDir: "playwright-logs/organized-logs",
    forceConsolidated: false, // One file per test
  },
});

// Extend base test with file logging context capture
export const test = base.extend({
  // Auto-capture test context for file logging
  autoTestContext: [
    async ({}, use, testInfo) => {
      captureTestContext(testInfo);
      await use(undefined);
    },
    { auto: true },
  ],
});
```

### Example 6: Integration with Auth and API

**Context**: Log authenticated API requests with tokens (safely).

**Implementation**:

```typescript
import { test } from "@seontechnologies/playwright-utils/fixtures";

// Helper to create safe token preview
function createTokenPreview(token: string): string {
  if (!token || token.length < 10) return "[invalid]";
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

test("should log auth flow", async ({ authToken, apiRequest }) => {
  await log.info(`Using token: ${createTokenPreview(authToken)}`);

  await log.step("Fetch protected resource");
  const { status, body } = await apiRequest({
    method: "GET",
    path: "/api/protected",
    headers: { Authorization: `Bearer ${authToken}` },
  });

  await log.debug({
    status,
    bodyPreview: {
      id: body.id,
      recordCount: body.data?.length,
    },
  });

  await log.success("Protected resource accessed successfully");
});
```

**Key Points**:

- Never log full tokens (security risk)
- Use preview functions for sensitive data
- Combine with auth and API utilities
- Log at appropriate detail level

## Configuration

**Defaults:** console logging enabled, file logging disabled.

```typescript
// Enable file logging in config
log.configure({
  console: true, // default
  fileLogging: {
    enabled: true,
    outputDir: "playwright-logs",
    forceConsolidated: false, // One file per test
  },
});

// Per-test override
await log.info("Message", {
  console: { enabled: false },
  fileLogging: { enabled: true },
});
```

### Environment Variables

```bash
# Disable all logging
SILENT=true

# Disable only file logging
DISABLE_FILE_LOGS=true

# Disable only console logging
DISABLE_CONSOLE_LOGS=true
```

### Level Filtering

```typescript
log.configure({
  level: "warning", // Only warning, error levels will show
});

// Available levels (in priority order):
// debug < info < step < success < warning < error
```

### Sync Methods

For non-test contexts (global setup, utility functions):

```typescript
// Use sync methods when async/await isn't available
log.infoSync("Initializing configuration");
log.successSync("Environment configured");
log.errorSync("Setup failed");
```

## Log Levels Guide

| Level     | When to Use                         | Shows in Report   | Shows in Console |
| --------- | ----------------------------------- | ----------------- | ---------------- |
| `step`    | Test organization, major actions    | Collapsible steps | Yes              |
| `info`    | General information, state changes  | Yes               | Yes              |
| `success` | Successful operations               | Yes               | Yes              |
| `warning` | Non-critical issues, skipped checks | Yes               | Yes              |
| `error`   | Failures, exceptions                | Yes               | Configurable     |
| `debug`   | Detailed data, objects              | Yes (attached)    | Configurable     |

## Comparison with console.log

| console.log             | log Utility               |
| ----------------------- | ------------------------- |
| Not in reports          | Appears in reports        |
| No test steps           | Creates collapsible steps |
| Manual JSON.stringify() | Auto-formats objects      |
| No log levels           | 6 log levels              |
| Lost in CI output       | Preserved in artifacts    |

## Related Fragments

- `overview.md` - Basic usage and imports
- `api-request.md` - Log API requests
- `auth-session.md` - Log auth flow (safely)
- `recurse.md` - Log polling progress

## Anti-Patterns

**DON'T log objects in steps:**

```typescript
await log.step({ user: "test", action: "create" }); // Shows empty in UI
```

**DO use strings for steps, objects for debug:**

```typescript
await log.step("Creating user: test"); // Readable in UI
await log.debug({ user: "test", action: "create" }); // Detailed data
```

**DON'T log sensitive data:**

```typescript
await log.info(`Password: ${password}`); // Security risk!
await log.info(`Token: ${authToken}`); // Full token exposed!
```

**DO use previews or omit sensitive data:**

```typescript
await log.info("User authenticated successfully"); // No sensitive data
await log.debug({ tokenPreview: token.slice(0, 6) + "..." });
```

**DON'T log excessively in loops:**

```typescript
for (const item of items) {
  await log.info(`Processing ${item.id}`); // 100 log entries!
}
```

**DO log summary or use debug level:**

```typescript
await log.step(`Processing ${items.length} items`);
await log.debug({ itemIds: items.map((i) => i.id) }); // One log entry
```
