# Auth Session Utility

## Principle

Persist authentication tokens to disk and reuse across test runs. Support multiple user identifiers, ephemeral authentication, and worker-specific accounts for parallel execution. Fetch tokens once, use everywhere. **Works for both API-only tests and browser tests.**

## Rationale

Playwright's built-in authentication works but has limitations:

- Re-authenticates for every test run (slow)
- Single user per project setup
- No token expiration handling
- Manual session management
- Complex setup for multi-user scenarios

The `auth-session` utility provides:

- **Token persistence**: Authenticate once, reuse across runs
- **Multi-user support**: Different user identifiers in same test suite
- **Ephemeral auth**: On-the-fly user authentication without disk persistence
- **Worker-specific accounts**: Parallel execution with isolated user accounts
- **Automatic token management**: Checks validity, renews if expired
- **Flexible provider pattern**: Adapt to any auth system (OAuth2, JWT, custom)
- **API-first design**: Get tokens for API tests without browser overhead

## Pattern Examples

### Example 1: Basic Auth Session Setup

**Context**: Configure global authentication that persists across test runs.

**Implementation**:

```typescript
// Step 1: Configure in global-setup.ts
import {
  authStorageInit,
  setAuthProvider,
  configureAuthSession,
  authGlobalInit,
} from "@seontechnologies/playwright-utils/auth-session";
import myCustomProvider from "./auth/custom-auth-provider";

async function globalSetup() {
  // Ensure storage directories exist
  authStorageInit();

  // Configure storage path
  configureAuthSession({
    authStoragePath: process.cwd() + "/playwright/auth-sessions",
    debug: true,
  });

  // Set custom provider (HOW to authenticate)
  setAuthProvider(myCustomProvider);

  // Optional: pre-fetch token for default user
  await authGlobalInit();
}

export default globalSetup;

// Step 2: Create auth fixture
import { test as base } from "@playwright/test";
import {
  createAuthFixtures,
  setAuthProvider,
} from "@seontechnologies/playwright-utils/auth-session";
import myCustomProvider from "./custom-auth-provider";

// Register provider early
setAuthProvider(myCustomProvider);

export const test = base.extend(createAuthFixtures());

// Step 3: Use in tests
test("authenticated request", async ({ authToken, request }) => {
  const response = await request.get("/api/protected", {
    headers: { Authorization: `Bearer ${authToken}` },
  });

  expect(response.ok()).toBeTruthy();
});
```

**Key Points**:

- Global setup runs once before all tests
- Token fetched once, reused across all tests
- Custom provider defines your auth mechanism
- Order matters: configure, then setProvider, then init

### Example 2: Multi-User Authentication

**Context**: Testing with different user roles (admin, regular user, guest) in same test suite.

**Implementation**:

```typescript
import { test } from "../support/auth/auth-fixture";

// Option 1: Per-test user override
test("admin actions", async ({ authToken, authOptions }) => {
  // Override default user
  authOptions.userIdentifier = "admin";

  const { authToken: adminToken } = await test.step("Get admin token", async () => {
    return { authToken }; // Re-fetches with new identifier
  });

  // Use admin token
  const response = await request.get("/api/admin/users", {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
});

// Option 2: Parallel execution with different users
test.describe.parallel("multi-user tests", () => {
  test("user 1 actions", async ({ authToken }) => {
    // Uses default user (e.g., 'user1')
  });

  test("user 2 actions", async ({ authToken, authOptions }) => {
    authOptions.userIdentifier = "user2";
    // Uses different token for user2
  });
});
```

**Key Points**:

- Override `authOptions.userIdentifier` per test
- Tokens cached separately per user identifier
- Parallel tests isolated with different users
- Worker-specific accounts possible

### Example 3: Ephemeral User Authentication

**Context**: Create temporary test users that don't persist to disk (e.g., testing user creation flow).

**Implementation**:

```typescript
import { applyUserCookiesToBrowserContext } from "@seontechnologies/playwright-utils/auth-session";
import { createTestUser } from "../utils/user-factory";

test("ephemeral user test", async ({ context, page }) => {
  // Create temporary user (not persisted)
  const ephemeralUser = await createTestUser({
    role: "admin",
    permissions: ["delete-users"],
  });

  // Apply auth directly to browser context
  await applyUserCookiesToBrowserContext(context, ephemeralUser);

  // Page now authenticated as ephemeral user
  await page.goto("/admin/users");

  await expect(page.getByTestId("delete-user-btn")).toBeVisible();

  // User and token cleaned up after test
});
```

**Key Points**:

- No disk persistence (ephemeral)
- Apply cookies directly to context
- Useful for testing user lifecycle
- Clean up automatic when test ends

### Example 4: Testing Multiple Users in Single Test

**Context**: Testing interactions between users (messaging, sharing, collaboration features).

**Implementation**:

```typescript
test("user interaction", async ({ browser }) => {
  // User 1 context
  const user1Context = await browser.newContext({
    storageState: "./auth-sessions/local/user1/storage-state.json",
  });
  const user1Page = await user1Context.newPage();

  // User 2 context
  const user2Context = await browser.newContext({
    storageState: "./auth-sessions/local/user2/storage-state.json",
  });
  const user2Page = await user2Context.newPage();

  // User 1 sends message
  await user1Page.goto("/messages");
  await user1Page.fill("#message", "Hello from user 1");
  await user1Page.click("#send");

  // User 2 receives message
  await user2Page.goto("/messages");
  await expect(user2Page.getByText("Hello from user 1")).toBeVisible();

  // Cleanup
  await user1Context.close();
  await user2Context.close();
});
```

**Key Points**:

- Each user has separate browser context
- Reference storage state files directly
- Test real-time interactions
- Clean up contexts after test

### Example 5: Worker-Specific Accounts (Parallel Testing)

**Context**: Running tests in parallel with isolated user accounts per worker to avoid conflicts.

**Implementation**:

```typescript
// playwright.config.ts
export default defineConfig({
  workers: 4, // 4 parallel workers
  use: {
    // Each worker uses different user
    storageState: async ({}, use, testInfo) => {
      const workerIndex = testInfo.workerIndex;
      const userIdentifier = `worker-${workerIndex}`;

      await use(`./auth-sessions/local/${userIdentifier}/storage-state.json`);
    },
  },
});

// Tests run in parallel, each worker with its own user
test("parallel test 1", async ({ page }) => {
  // Worker 0 uses worker-0 account
  await page.goto("/dashboard");
});

test("parallel test 2", async ({ page }) => {
  // Worker 1 uses worker-1 account
  await page.goto("/dashboard");
});
```

**Key Points**:

- Each worker has isolated user account
- No conflicts in parallel execution
- Token management automatic per worker
- Scales to any number of workers

### Example 6: Pure API Authentication (No Browser)

**Context**: Get auth tokens for API-only tests using auth-session disk persistence.

**Implementation**:

```typescript
// Step 1: Create API-only auth provider (no browser needed)
// playwright/support/api-auth-provider.ts
import { type AuthProvider } from "@seontechnologies/playwright-utils/auth-session";

const apiAuthProvider: AuthProvider = {
  getEnvironment: (options) => options.environment || "local",
  getUserIdentifier: (options) => options.userIdentifier || "api-user",

  extractToken: (storageState) => {
    // Token stored in localStorage format for disk persistence
    const tokenEntry = storageState.origins?.[0]?.localStorage?.find(
      (item) => item.name === "auth_token",
    );
    return tokenEntry?.value;
  },

  isTokenExpired: (storageState) => {
    const expiryEntry = storageState.origins?.[0]?.localStorage?.find(
      (item) => item.name === "token_expiry",
    );
    if (!expiryEntry) return true;
    return Date.now() > parseInt(expiryEntry.value, 10);
  },

  manageAuthToken: async (request, options) => {
    const email = process.env.TEST_USER_EMAIL;
    const password = process.env.TEST_USER_PASSWORD;

    if (!email || !password) {
      throw new Error("TEST_USER_EMAIL and TEST_USER_PASSWORD must be set");
    }

    // Pure API login - no browser!
    const response = await request.post("/api/auth/login", {
      data: { email, password },
    });

    if (!response.ok()) {
      throw new Error(`Auth failed: ${response.status()}`);
    }

    const { token, expiresIn } = await response.json();
    const expiryTime = Date.now() + expiresIn * 1000;

    // Return storage state format for disk persistence
    return {
      cookies: [],
      origins: [
        {
          origin: process.env.API_BASE_URL || "http://localhost:3000",
          localStorage: [
            { name: "auth_token", value: token },
            { name: "token_expiry", value: String(expiryTime) },
          ],
        },
      ],
    };
  },
};

export default apiAuthProvider;

// Step 2: Create auth fixture
// playwright/support/fixtures.ts
import { test as base } from "@playwright/test";
import {
  createAuthFixtures,
  setAuthProvider,
} from "@seontechnologies/playwright-utils/auth-session";
import apiAuthProvider from "./api-auth-provider";

setAuthProvider(apiAuthProvider);

export const test = base.extend(createAuthFixtures());

// Step 3: Use in tests - token persisted to disk!
// tests/api/authenticated-api.spec.ts
import { test } from "../support/fixtures";
import { expect } from "@playwright/test";

test("should access protected endpoint", async ({ authToken, apiRequest }) => {
  // authToken is automatically loaded from disk or fetched if expired
  const { status, body } = await apiRequest({
    method: "GET",
    path: "/api/me",
    headers: { Authorization: `Bearer ${authToken}` },
  });

  expect(status).toBe(200);
});

test("should create resource with auth", async ({ authToken, apiRequest }) => {
  const { status, body } = await apiRequest({
    method: "POST",
    path: "/api/orders",
    headers: { Authorization: `Bearer ${authToken}` },
    body: { items: [{ productId: "prod-1", quantity: 2 }] },
  });

  expect(status).toBe(201);
  expect(body.id).toBeDefined();
});
```

**Key Points**:

- Token persisted to disk (not in-memory) - survives test reruns
- Provider fetches token once, reuses until expired
- Pure API authentication - no browser context needed
- `authToken` fixture handles disk read/write automatically
- Environment variables validated with clear error message

### Example 7: Service-to-Service Authentication

**Context**: Test microservice authentication patterns (API keys, service tokens) with proper environment validation.

**Implementation**:

```typescript
// tests/api/service-auth.spec.ts
import { test as base, expect } from "@playwright/test";
import { test as apiFixture } from "@seontechnologies/playwright-utils/api-request/fixtures";
import { mergeTests } from "@playwright/test";

// Validate environment variables at module load
const SERVICE_API_KEY = process.env.SERVICE_API_KEY;
const INTERNAL_SERVICE_URL = process.env.INTERNAL_SERVICE_URL;

if (!SERVICE_API_KEY) {
  throw new Error("SERVICE_API_KEY environment variable is required");
}
if (!INTERNAL_SERVICE_URL) {
  throw new Error("INTERNAL_SERVICE_URL environment variable is required");
}

const test = mergeTests(base, apiFixture);

test.describe("Service-to-Service Auth", () => {
  test("should authenticate with API key", async ({ apiRequest }) => {
    const { status, body } = await apiRequest({
      method: "GET",
      path: "/internal/health",
      baseUrl: INTERNAL_SERVICE_URL,
      headers: { "X-API-Key": SERVICE_API_KEY },
    });

    expect(status).toBe(200);
    expect(body.status).toBe("healthy");
  });

  test("should reject invalid API key", async ({ apiRequest }) => {
    const { status, body } = await apiRequest({
      method: "GET",
      path: "/internal/health",
      baseUrl: INTERNAL_SERVICE_URL,
      headers: { "X-API-Key": "invalid-key" },
    });

    expect(status).toBe(401);
    expect(body.code).toBe("INVALID_API_KEY");
  });

  test("should call downstream service with propagated auth", async ({ apiRequest }) => {
    const { status, body } = await apiRequest({
      method: "POST",
      path: "/internal/aggregate-data",
      baseUrl: INTERNAL_SERVICE_URL,
      headers: {
        "X-API-Key": SERVICE_API_KEY,
        "X-Request-ID": `test-${Date.now()}`,
      },
      body: { sources: ["users", "orders", "inventory"] },
    });

    expect(status).toBe(200);
    expect(body.aggregatedFrom).toHaveLength(3);
  });
});
```

**Key Points**:

- Environment variables validated at module load with clear errors
- API key authentication (simpler than OAuth - no disk persistence needed)
- Test internal/service endpoints
- Validate auth rejection scenarios
- Correlation ID for request tracing

> **Note**: API keys are typically static secrets that don't expire, so disk persistence (auth-session) isn't needed. For rotating service tokens, use the auth-session provider pattern from Example 6.

## Custom Auth Provider Pattern

**Context**: Adapt auth-session to your authentication system (OAuth2, JWT, SAML, custom).

**Minimal provider structure**:

```typescript
import { type AuthProvider } from "@seontechnologies/playwright-utils/auth-session";

const myCustomProvider: AuthProvider = {
  getEnvironment: (options) => options.environment || "local",

  getUserIdentifier: (options) => options.userIdentifier || "default-user",

  extractToken: (storageState) => {
    // Extract token from your storage format
    return storageState.cookies.find((c) => c.name === "auth_token")?.value;
  },

  extractCookies: (tokenData) => {
    // Convert token to cookies for browser context
    return [
      {
        name: "auth_token",
        value: tokenData,
        domain: "example.com",
        path: "/",
        httpOnly: true,
        secure: true,
      },
    ];
  },

  isTokenExpired: (storageState) => {
    // Check if token is expired
    const expiresAt = storageState.cookies.find((c) => c.name === "expires_at");
    return Date.now() > parseInt(expiresAt?.value || "0");
  },

  manageAuthToken: async (request, options) => {
    // Main token acquisition logic
    // Return storage state with cookies/localStorage
  },
};

export default myCustomProvider;
```

## Integration with API Request

```typescript
import { test } from "@seontechnologies/playwright-utils/fixtures";

test("authenticated API call", async ({ apiRequest, authToken }) => {
  const { status, body } = await apiRequest({
    method: "GET",
    path: "/api/protected",
    headers: { Authorization: `Bearer ${authToken}` },
  });

  expect(status).toBe(200);
});
```

## Related Fragments

- `api-testing-patterns.md` - Pure API testing patterns (no browser)
- `overview.md` - Installation and fixture composition
- `api-request.md` - Authenticated API requests
- `fixtures-composition.md` - Merging auth with other utilities

## Anti-Patterns

**❌ Calling setAuthProvider after globalSetup:**

```typescript
async function globalSetup() {
  configureAuthSession(...)
  await authGlobalInit()  // Provider not set yet!
  setAuthProvider(provider)  // Too late
}
```

**✅ Register provider before init:**

```typescript
async function globalSetup() {
  authStorageInit()
  configureAuthSession(...)
  setAuthProvider(provider)  // First
  await authGlobalInit()     // Then init
}
```

**❌ Hardcoding storage paths:**

```typescript
const storageState = "./auth-sessions/local/user1/storage-state.json"; // Brittle
```

**✅ Use helper functions:**

```typescript
import { getTokenFilePath } from "@seontechnologies/playwright-utils/auth-session";

const tokenPath = getTokenFilePath({
  environment: "local",
  userIdentifier: "user1",
  tokenFileName: "storage-state.json",
});
```
