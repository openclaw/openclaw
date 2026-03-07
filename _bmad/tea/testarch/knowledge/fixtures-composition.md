# Fixtures Composition with mergeTests

## Principle

Combine multiple Playwright fixtures using `mergeTests` to create a unified test object with all capabilities. Build composable test infrastructure by merging playwright-utils fixtures with custom project fixtures.

## Rationale

Using fixtures from multiple sources requires combining them:

- Importing from multiple fixture files is verbose
- Name conflicts between fixtures
- Duplicate fixture definitions
- No clear single test object

Playwright's `mergeTests` provides:

- **Single test object**: All fixtures in one import
- **Conflict resolution**: Handles name collisions automatically
- **Composition pattern**: Mix utilities, custom fixtures, third-party fixtures
- **Type safety**: Full TypeScript support for merged fixtures
- **Maintainability**: One place to manage all fixtures

## Pattern Examples

### Example 1: Basic Fixture Merging

**Context**: Combine multiple playwright-utils fixtures into single test object.

**Implementation**:

```typescript
// playwright/support/merged-fixtures.ts
import { mergeTests } from "@playwright/test";
import { test as apiRequestFixture } from "@seontechnologies/playwright-utils/api-request/fixtures";
import { test as authFixture } from "@seontechnologies/playwright-utils/auth-session/fixtures";
import { test as recurseFixture } from "@seontechnologies/playwright-utils/recurse/fixtures";

// Merge all fixtures
export const test = mergeTests(apiRequestFixture, authFixture, recurseFixture);

export { expect } from "@playwright/test";
```

```typescript
// In your tests - import from merged fixtures
import { test, expect } from "../support/merged-fixtures";

test("all utilities available", async ({
  apiRequest, // From api-request fixture
  authToken, // From auth fixture
  recurse, // From recurse fixture
}) => {
  // All fixtures available in single test signature
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

- Create one `merged-fixtures.ts` per project
- Import test object from merged fixtures in all test files
- All utilities available without multiple imports
- Type-safe access to all fixtures

### Example 2: Combining with Custom Fixtures

**Context**: Add project-specific fixtures alongside playwright-utils.

**Implementation**:

```typescript
// playwright/support/custom-fixtures.ts - Your project fixtures
import { test as base } from "@playwright/test";
import { createUser } from "./factories/user-factory";
import { seedDatabase } from "./helpers/db-seeder";

export const test = base.extend({
  // Custom fixture 1: Auto-seeded user
  testUser: async ({ request }, use) => {
    const user = await createUser({ role: "admin" });
    await seedDatabase("users", [user]);
    await use(user);
    // Cleanup happens automatically
  },

  // Custom fixture 2: Database helpers
  db: async ({}, use) => {
    await use({
      seed: seedDatabase,
      clear: () => seedDatabase.truncate(),
    });
  },
});

// playwright/support/merged-fixtures.ts - Combine everything
import { mergeTests } from "@playwright/test";
import { test as apiRequestFixture } from "@seontechnologies/playwright-utils/api-request/fixtures";
import { test as authFixture } from "@seontechnologies/playwright-utils/auth-session/fixtures";
import { test as customFixtures } from "./custom-fixtures";

export const test = mergeTests(
  apiRequestFixture,
  authFixture,
  customFixtures, // Your project fixtures
);

export { expect } from "@playwright/test";
```

```typescript
// In tests - all fixtures available
import { test, expect } from "../support/merged-fixtures";

test("using mixed fixtures", async ({
  apiRequest, // playwright-utils
  authToken, // playwright-utils
  testUser, // custom
  db, // custom
}) => {
  // Use playwright-utils
  const { body } = await apiRequest({
    method: "GET",
    path: `/api/users/${testUser.id}`,
    headers: { Authorization: `Bearer ${authToken}` },
  });

  // Use custom fixture
  await db.clear();
});
```

**Key Points**:

- Custom fixtures extend `base` test
- Merge custom with playwright-utils fixtures
- All available in one test signature
- Maintainable separation of concerns

### Example 3: Full Utility Suite Integration

**Context**: Production setup with all core playwright-utils and custom fixtures.

**Implementation**:

```typescript
// playwright/support/merged-fixtures.ts
import { mergeTests } from "@playwright/test";

// Playwright utils fixtures
import { test as apiRequestFixture } from "@seontechnologies/playwright-utils/api-request/fixtures";
import { test as authFixture } from "@seontechnologies/playwright-utils/auth-session/fixtures";
import { test as interceptFixture } from "@seontechnologies/playwright-utils/intercept-network-call/fixtures";
import { test as recurseFixture } from "@seontechnologies/playwright-utils/recurse/fixtures";
import { test as networkRecorderFixture } from "@seontechnologies/playwright-utils/network-recorder/fixtures";

// Custom project fixtures
import { test as customFixtures } from "./custom-fixtures";

// Merge everything
export const test = mergeTests(
  apiRequestFixture,
  authFixture,
  interceptFixture,
  recurseFixture,
  networkRecorderFixture,
  customFixtures,
);

export { expect } from "@playwright/test";
```

```typescript
// In tests
import { test, expect } from "../support/merged-fixtures";

test("full integration", async ({
  page,
  context,
  apiRequest,
  authToken,
  interceptNetworkCall,
  recurse,
  networkRecorder,
  testUser, // custom
}) => {
  // All utilities + custom fixtures available
  await networkRecorder.setup(context);

  const usersCall = interceptNetworkCall({ url: "**/api/users" });

  await page.goto("/users");
  const { responseJson } = await usersCall;

  expect(responseJson).toContainEqual(expect.objectContaining({ id: testUser.id }));
});
```

**Key Points**:

- One merged-fixtures.ts for entire project
- Combine all playwright-utils you use
- Add custom project fixtures
- Single import in all test files

### Example 4: Fixture Override Pattern

**Context**: Override default options for specific test files or describes.

**Implementation**:

```typescript
import { test, expect } from "../support/merged-fixtures";

// Override auth options for entire file
test.use({
  authOptions: {
    userIdentifier: "admin",
    environment: "staging",
  },
});

test("uses admin on staging", async ({ authToken }) => {
  // Token is for admin user on staging environment
});

// Override for specific describe block
test.describe("manager tests", () => {
  test.use({
    authOptions: {
      userIdentifier: "manager",
    },
  });

  test("manager can access reports", async ({ page }) => {
    // Uses manager token
    await page.goto("/reports");
  });
});
```

**Key Points**:

- `test.use()` overrides fixture options
- Can override at file or describe level
- Options merge with defaults
- Type-safe overrides

### Example 5: Avoiding Fixture Conflicts

**Context**: Handle name collisions when merging fixtures with same names.

**Implementation**:

```typescript
// If two fixtures have same name, last one wins
import { test as fixture1 } from "./fixture1"; // has 'user' fixture
import { test as fixture2 } from "./fixture2"; // also has 'user' fixture

const test = mergeTests(fixture1, fixture2);
// fixture2's 'user' overrides fixture1's 'user'

// Better: Rename fixtures before merging
import { test as base } from "@playwright/test";
import { test as fixture1 } from "./fixture1";

const fixture1Renamed = base.extend({
  user1: fixture1._extend.user, // Rename to avoid conflict
});

const test = mergeTests(fixture1Renamed, fixture2);
// Now both 'user1' and 'user' available

// Best: Design fixtures without conflicts
// - Prefix custom fixtures: 'myAppUser', 'myAppDb'
// - Playwright-utils uses descriptive names: 'apiRequest', 'authToken'
```

**Key Points**:

- Last fixture wins in conflicts
- Rename fixtures to avoid collisions
- Design fixtures with unique names
- Playwright-utils uses descriptive names (no conflicts)

## Recommended Project Structure

```
playwright/
├── support/
│   ├── merged-fixtures.ts        # ⭐ Single test object for project
│   ├── custom-fixtures.ts        # Your project-specific fixtures
│   ├── auth/
│   │   ├── auth-fixture.ts       # Auth wrapper (if needed)
│   │   └── custom-auth-provider.ts
│   ├── fixtures/
│   │   ├── user-fixture.ts
│   │   ├── db-fixture.ts
│   │   └── api-fixture.ts
│   └── utils/
│       └── factories/
└── tests/
    ├── api/
    │   └── users.spec.ts          # import { test } from '../../support/merged-fixtures'
    ├── e2e/
    │   └── login.spec.ts          # import { test } from '../../support/merged-fixtures'
    └── component/
        └── button.spec.ts         # import { test } from '../../support/merged-fixtures'
```

## Benefits of Fixture Composition

**Compared to direct imports:**

```typescript
// ❌ Without mergeTests (verbose)
import { test as base } from "@playwright/test";
import { apiRequest } from "@seontechnologies/playwright-utils/api-request";
import { getAuthToken } from "./auth";
import { createUser } from "./factories";

test("verbose", async ({ request }) => {
  const token = await getAuthToken();
  const user = await createUser();
  const response = await apiRequest({ request, method: "GET", path: "/api/users" });
  // Manual wiring everywhere
});

// ✅ With mergeTests (clean)
import { test } from "../support/merged-fixtures";

test("clean", async ({ apiRequest, authToken, testUser }) => {
  const { body } = await apiRequest({ method: "GET", path: "/api/users" });
  // All fixtures auto-wired
});
```

**Reduction:** ~10 lines per test → ~2 lines

## Related Fragments

- `overview.md` - Installation and design principles
- `api-request.md`, `auth-session.md`, `recurse.md` - Utilities to merge
- `network-recorder.md`, `intercept-network-call.md`, `log.md` - Additional utilities

## Anti-Patterns

**❌ Importing test from multiple fixture files:**

```typescript
import { test } from "@seontechnologies/playwright-utils/api-request/fixtures";
// Also need auth...
import { test as authTest } from "@seontechnologies/playwright-utils/auth-session/fixtures";
// Name conflict! Which test to use?
```

**✅ Use merged fixtures:**

```typescript
import { test } from "../support/merged-fixtures";
// All utilities available, no conflicts
```

**❌ Merging too many fixtures (kitchen sink):**

```typescript
// Merging 20+ fixtures makes test signature huge
const test = mergeTests(...20 different fixtures)

test('my test', async ({ fixture1, fixture2, ..., fixture20 }) => {
  // Cognitive overload
})
```

**✅ Merge only what you actually use:**

```typescript
// Merge the 4-6 fixtures your project actually needs
const test = mergeTests(apiRequestFixture, authFixture, recurseFixture, customFixtures);
```
