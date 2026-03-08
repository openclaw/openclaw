# Playwright Utils Overview

## Principle

Use production-ready, fixture-based utilities from `@seontechnologies/playwright-utils` for common Playwright testing patterns. Build test helpers as pure functions first, then wrap in framework-specific fixtures for composability and reuse. **Works equally well for pure API testing (no browser) and UI testing.**

## Rationale

Writing Playwright utilities from scratch for every project leads to:

- Duplicated code across test suites
- Inconsistent patterns and quality
- Maintenance burden when Playwright APIs change
- Missing advanced features (schema validation, HAR recording, auth persistence)

`@seontechnologies/playwright-utils` provides:

- **Production-tested utilities**: Used at SEON Technologies in production
- **Functional-first design**: Core logic as pure functions, fixtures for convenience
- **Composable fixtures**: Use `mergeTests` to combine utilities
- **TypeScript support**: Full type safety with generic types
- **Comprehensive coverage**: API requests, auth, network, logging, file handling, burn-in
- **Backend-first mentality**: Most utilities work without a browser - pure API/service testing is a first-class use case

## Installation

```bash
npm install -D @seontechnologies/playwright-utils
```

**Peer Dependencies:**

- `@playwright/test` >= 1.54.1 (required)
- `ajv` >= 8.0.0 (optional - for JSON Schema validation)
- `zod` >= 3.0.0 (optional - for Zod schema validation)

## Available Utilities

### Core Testing Utilities

| Utility                    | Purpose                                                                       | Test Context       |
| -------------------------- | ----------------------------------------------------------------------------- | ------------------ |
| **api-request**            | Typed HTTP client with schema validation, retry, and operation-based overload | **API/Backend**    |
| **recurse**                | Polling for async operations, background jobs                                 | **API/Backend**    |
| **auth-session**           | Token persistence, multi-user, service-to-service                             | **API/Backend/UI** |
| **log**                    | Playwright report-integrated logging                                          | **API/Backend/UI** |
| **file-utils**             | CSV/XLSX/PDF/ZIP reading & validation                                         | **API/Backend/UI** |
| **burn-in**                | Smart test selection with git diff                                            | **CI/CD**          |
| **network-recorder**       | HAR record/playback for offline testing                                       | UI only            |
| **intercept-network-call** | Network spy/stub with auto JSON parsing                                       | UI only            |
| **network-error-monitor**  | Automatic HTTP 4xx/5xx detection                                              | UI only            |

**Note**: 6 of 9 utilities work without a browser. Only 3 are UI-specific (network-recorder, intercept-network-call, network-error-monitor).

## Design Patterns

### Pattern 1: Functional Core, Fixture Shell

**Context**: All utilities follow the same architectural pattern - pure function as core, fixture as wrapper.

**Implementation**:

```typescript
// Direct import (pass Playwright context explicitly)
import { apiRequest } from "@seontechnologies/playwright-utils";

test("direct usage", async ({ request }) => {
  const { status, body } = await apiRequest({
    request, // Must pass request context
    method: "GET",
    path: "/api/users",
  });
});

// Fixture import (context injected automatically)
import { test } from "@seontechnologies/playwright-utils/fixtures";

test("fixture usage", async ({ apiRequest }) => {
  const { status, body } = await apiRequest({
    // No need to pass request context
    method: "GET",
    path: "/api/users",
  });
});
```

**Key Points**:

- Pure functions testable without Playwright running
- Fixtures inject framework dependencies automatically
- Choose direct import (more control) or fixture (convenience)

### Pattern 2: Subpath Imports for Tree-Shaking

**Context**: Import only what you need to keep bundle sizes small.

**Implementation**:

```typescript
// Import specific utility
import { apiRequest } from "@seontechnologies/playwright-utils/api-request";

// Import specific fixture
import { test } from "@seontechnologies/playwright-utils/api-request/fixtures";

// Import everything (use sparingly)
import { apiRequest, recurse, log } from "@seontechnologies/playwright-utils";
```

**Key Points**:

- Subpath imports enable tree-shaking
- Keep bundle sizes minimal
- Import from specific paths for production builds

### Pattern 3: Fixture Composition with mergeTests

**Context**: Combine multiple playwright-utils fixtures with your own custom fixtures.

**Implementation**:

```typescript
// playwright/support/merged-fixtures.ts
import { mergeTests } from "@playwright/test";
import { test as apiRequestFixture } from "@seontechnologies/playwright-utils/api-request/fixtures";
import { test as authFixture } from "@seontechnologies/playwright-utils/auth-session/fixtures";
import { test as recurseFixture } from "@seontechnologies/playwright-utils/recurse/fixtures";
import { test as logFixture } from "@seontechnologies/playwright-utils/log/fixtures";

// Merge all fixtures into one test object
export const test = mergeTests(apiRequestFixture, authFixture, recurseFixture, logFixture);

export { expect } from "@playwright/test";
```

```typescript
// In your tests
import { test, expect } from "../support/merged-fixtures";

test("all utilities available", async ({ apiRequest, authToken, recurse, log }) => {
  await log.step("Making authenticated API request");

  const { body } = await apiRequest({
    method: "GET",
    path: "/api/protected",
    headers: { Authorization: `Bearer ${authToken}` },
  });

  await recurse(
    () => apiRequest({ method: "GET", path: `/status/${body.id}` }),
    (res) => res.body.ready === true,
  );
});
```

**Key Points**:

- `mergeTests` combines multiple fixtures without conflicts
- Create one merged-fixtures.ts file per project
- Import test object from your merged fixtures in all tests
- All utilities available in single test signature

## Integration with Existing Tests

### Gradual Adoption Strategy

**1. Start with logging** (zero breaking changes):

```typescript
import { log } from "@seontechnologies/playwright-utils";

test("existing test", async ({ page }) => {
  await log.step("Navigate to page"); // Just add logging
  await page.goto("/dashboard");
  // Rest of test unchanged
});
```

**2. Add API utilities** (for API tests):

```typescript
import { test } from "@seontechnologies/playwright-utils/api-request/fixtures";

test("API test", async ({ apiRequest }) => {
  const { status, body } = await apiRequest({
    method: "GET",
    path: "/api/users",
  });

  expect(status).toBe(200);
});
```

**3. Expand to network utilities** (for UI tests):

```typescript
import { test } from "@seontechnologies/playwright-utils/fixtures";

test("UI with network control", async ({ page, interceptNetworkCall }) => {
  const usersCall = interceptNetworkCall({
    url: "**/api/users",
  });

  await page.goto("/dashboard");
  const { responseJson } = await usersCall;

  expect(responseJson).toHaveLength(10);
});
```

**4. Full integration** (merged fixtures):

Create merged-fixtures.ts and use across all tests.

## Related Fragments

- `api-request.md` - HTTP client with schema validation
- `network-recorder.md` - HAR-based offline testing
- `auth-session.md` - Token management
- `intercept-network-call.md` - Network interception
- `recurse.md` - Polling patterns
- `log.md` - Logging utility
- `file-utils.md` - File operations
- `fixtures-composition.md` - Advanced mergeTests patterns

## Anti-Patterns

**❌ Don't mix direct and fixture imports in same test:**

```typescript
import { apiRequest } from "@seontechnologies/playwright-utils";
import { test } from "@seontechnologies/playwright-utils/auth-session/fixtures";

test("bad", async ({ request, authToken }) => {
  // Confusing - mixing direct (needs request) and fixture (has authToken)
  await apiRequest({ request, method: "GET", path: "/api/users" });
});
```

**✅ Use consistent import style:**

```typescript
import { test } from "../support/merged-fixtures";

test("good", async ({ apiRequest, authToken }) => {
  // Clean - all from fixtures
  await apiRequest({ method: "GET", path: "/api/users" });
});
```

**❌ Don't import everything when you need one utility:**

```typescript
import * as utils from "@seontechnologies/playwright-utils"; // Large bundle
```

**✅ Use subpath imports:**

```typescript
import { apiRequest } from "@seontechnologies/playwright-utils/api-request"; // Small bundle
```

## Reference Implementation

The official `@seontechnologies/playwright-utils` repository provides working examples of all patterns described in these fragments.

**Repository:** <https://github.com/seontechnologies/playwright-utils>

**Key resources:**

- **Test examples:** `playwright/tests` - All utilities in action
- **Framework setup:** `playwright.config.ts`, `playwright/support/merged-fixtures.ts`
- **CI patterns:** `.github/workflows/` - GitHub Actions with sharding, parallelization

**Quick start:**

```bash
git clone https://github.com/seontechnologies/playwright-utils.git
cd playwright-utils
nvm use
npm install
npm run test:pw-ui  # Explore tests with Playwright UI
npm run test:pw
```

All patterns in TEA fragments are production-tested in this repository.
