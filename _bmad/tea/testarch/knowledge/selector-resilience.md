# Selector Resilience

## Principle

Robust selectors follow a strict hierarchy: **data-testid > ARIA roles > text content > CSS/IDs** (last resort). Selectors must be resilient to UI changes (styling, layout, content updates) and remain human-readable for maintenance.

## Rationale

**The Problem**: Brittle selectors (CSS classes, nth-child, complex XPath) break when UI styling changes, elements are reordered, or design updates occur. This causes test maintenance burden and false negatives.

**The Solution**: Prioritize semantic selectors that reflect user intent (ARIA roles, accessible names, test IDs). Use dynamic filtering for lists instead of nth() indexes. Validate selectors during code review and refactor proactively.

**Why This Matters**:

- Prevents false test failures (UI refactoring doesn't break tests)
- Improves accessibility (ARIA roles benefit both tests and screen readers)
- Enhances readability (semantic selectors document user intent)
- Reduces maintenance burden (robust selectors survive design changes)

## Pattern Examples

### Example 1: Selector Hierarchy (Priority Order with Examples)

**Context**: Choose the most resilient selector for each element type

**Implementation**:

```typescript
// tests/selectors/hierarchy-examples.spec.ts
import { test, expect } from "@playwright/test";

test.describe("Selector Hierarchy Best Practices", () => {
  test("Level 1: data-testid (BEST - most resilient)", async ({ page }) => {
    await page.goto("/login");

    // ✅ Best: Dedicated test attribute (survives all UI changes)
    await page.getByTestId("email-input").fill("user@example.com");
    await page.getByTestId("password-input").fill("password123");
    await page.getByTestId("login-button").click();

    await expect(page.getByTestId("welcome-message")).toBeVisible();

    // Why it's best:
    // - Survives CSS refactoring (class name changes)
    // - Survives layout changes (element reordering)
    // - Survives content changes (button text updates)
    // - Explicit test contract (developer knows it's for testing)
  });

  test("Level 2: ARIA roles and accessible names (GOOD - future-proof)", async ({ page }) => {
    await page.goto("/login");

    // ✅ Good: Semantic HTML roles (benefits accessibility + tests)
    await page.getByRole("textbox", { name: "Email" }).fill("user@example.com");
    await page.getByRole("textbox", { name: "Password" }).fill("password123");
    await page.getByRole("button", { name: "Sign In" }).click();

    await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();

    // Why it's good:
    // - Survives CSS refactoring
    // - Survives layout changes
    // - Enforces accessibility (screen reader compatible)
    // - Self-documenting (role + name = clear intent)
  });

  test("Level 3: Text content (ACCEPTABLE - user-centric)", async ({ page }) => {
    await page.goto("/dashboard");

    // ✅ Acceptable: Text content (matches user perception)
    await page.getByText("Create New Order").click();
    await expect(page.getByText("Order Details")).toBeVisible();

    // Why it's acceptable:
    // - User-centric (what user sees)
    // - Survives CSS/layout changes
    // - Breaks when copy changes (forces test update with content)

    // ⚠️ Use with caution for dynamic/localized content:
    // - Avoid for content with variables: "User 123" (use regex instead)
    // - Avoid for i18n content (use data-testid or ARIA)
  });

  test("Level 4: CSS classes/IDs (LAST RESORT - brittle)", async ({ page }) => {
    await page.goto("/login");

    // ❌ Last resort: CSS class (breaks with styling updates)
    // await page.locator('.btn-primary').click()

    // ❌ Last resort: ID (breaks if ID changes)
    // await page.locator('#login-form').fill(...)

    // ✅ Better: Use data-testid or ARIA instead
    await page.getByTestId("login-button").click();

    // Why CSS/ID is last resort:
    // - Breaks with CSS refactoring (class name changes)
    // - Breaks with HTML restructuring (ID changes)
    // - Not semantic (unclear what element does)
    // - Tight coupling between tests and styling
  });
});
```

**Key Points**:

- Hierarchy: data-testid (best) > ARIA (good) > text (acceptable) > CSS/ID (last resort)
- data-testid survives ALL UI changes (explicit test contract)
- ARIA roles enforce accessibility (screen reader compatible)
- Text content is user-centric (but breaks with copy changes)
- CSS/ID are brittle (break with styling refactoring)

---

### Example 2: Dynamic Selector Patterns (Lists, Filters, Regex)

**Context**: Handle dynamic content, lists, and variable data with resilient selectors

**Implementation**:

```typescript
// tests/selectors/dynamic-selectors.spec.ts
import { test, expect } from "@playwright/test";

test.describe("Dynamic Selector Patterns", () => {
  test("regex for variable content (user IDs, timestamps)", async ({ page }) => {
    await page.goto("/users");

    // ✅ Good: Regex pattern for dynamic user IDs
    await expect(page.getByText(/User \d+/)).toBeVisible();

    // ✅ Good: Regex for timestamps
    await expect(page.getByText(/Last login: \d{4}-\d{2}-\d{2}/)).toBeVisible();

    // ✅ Good: Regex for dynamic counts
    await expect(page.getByText(/\d+ items in cart/)).toBeVisible();
  });

  test("partial text matching (case-insensitive, substring)", async ({ page }) => {
    await page.goto("/products");

    // ✅ Good: Partial match (survives minor text changes)
    await page.getByText("Product", { exact: false }).first().click();

    // ✅ Good: Case-insensitive (survives capitalization changes)
    await expect(page.getByText(/sign in/i)).toBeVisible();
  });

  test("filter locators for lists (avoid brittle nth)", async ({ page }) => {
    await page.goto("/products");

    // ❌ Bad: Index-based (breaks when order changes)
    // await page.locator('.product-card').nth(2).click()

    // ✅ Good: Filter by content (resilient to reordering)
    await page.locator('[data-testid="product-card"]').filter({ hasText: "Premium Plan" }).click();

    // ✅ Good: Filter by attribute
    await page
      .locator('[data-testid="product-card"]')
      .filter({ has: page.locator('[data-status="active"]') })
      .first()
      .click();
  });

  test("nth() only when absolutely necessary", async ({ page }) => {
    await page.goto("/dashboard");

    // ⚠️ Acceptable: nth(0) for first item (common pattern)
    const firstNotification = page.getByTestId("notification").nth(0);
    await expect(firstNotification).toContainText("Welcome");

    // ❌ Bad: nth(5) for arbitrary index (fragile)
    // await page.getByTestId('notification').nth(5).click()

    // ✅ Better: Use filter() with specific criteria
    await page.getByTestId("notification").filter({ hasText: "Critical Alert" }).click();
  });

  test("combine multiple locators for specificity", async ({ page }) => {
    await page.goto("/checkout");

    // ✅ Good: Narrow scope with combined locators
    const shippingSection = page.getByTestId("shipping-section");
    await shippingSection.getByLabel("Address Line 1").fill("123 Main St");
    await shippingSection.getByLabel("City").fill("New York");

    // Scoping prevents ambiguity (multiple "City" fields on page)
  });
});
```

**Key Points**:

- Regex patterns handle variable content (IDs, timestamps, counts)
- Partial matching survives minor text changes (`exact: false`)
- `filter()` is more resilient than `nth()` (content-based vs index-based)
- `nth(0)` acceptable for "first item", avoid arbitrary indexes
- Combine locators to narrow scope (prevent ambiguity)

---

### Example 3: Selector Anti-Patterns (What NOT to Do)

**Context**: Common selector mistakes that cause brittle tests

**Problem Examples**:

```typescript
// tests/selectors/anti-patterns.spec.ts
import { test, expect } from "@playwright/test";

test.describe("Selector Anti-Patterns to Avoid", () => {
  test("❌ Anti-Pattern 1: CSS classes (brittle)", async ({ page }) => {
    await page.goto("/login");

    // ❌ Bad: CSS class (breaks with design system updates)
    // await page.locator('.btn-primary').click()
    // await page.locator('.form-input-lg').fill('test@example.com')

    // ✅ Good: Use data-testid or ARIA role
    await page.getByTestId("login-button").click();
    await page.getByRole("textbox", { name: "Email" }).fill("test@example.com");
  });

  test("❌ Anti-Pattern 2: Index-based nth() (fragile)", async ({ page }) => {
    await page.goto("/products");

    // ❌ Bad: Index-based (breaks when product order changes)
    // await page.locator('.product-card').nth(3).click()

    // ✅ Good: Content-based filter
    await page.locator('[data-testid="product-card"]').filter({ hasText: "Laptop" }).click();
  });

  test("❌ Anti-Pattern 3: Complex XPath (hard to maintain)", async ({ page }) => {
    await page.goto("/dashboard");

    // ❌ Bad: Complex XPath (unreadable, breaks with structure changes)
    // await page.locator('xpath=//div[@class="container"]//section[2]//button[contains(@class, "primary")]').click()

    // ✅ Good: Semantic selector
    await page.getByRole("button", { name: "Create Order" }).click();
  });

  test("❌ Anti-Pattern 4: ID selectors (coupled to implementation)", async ({ page }) => {
    await page.goto("/settings");

    // ❌ Bad: HTML ID (breaks if ID changes for accessibility/SEO)
    // await page.locator('#user-settings-form').fill(...)

    // ✅ Good: data-testid or ARIA landmark
    await page.getByTestId("user-settings-form").getByLabel("Display Name").fill("John Doe");
  });

  test("✅ Refactoring: Bad → Good Selector", async ({ page }) => {
    await page.goto("/checkout");

    // Before (brittle):
    // await page.locator('.checkout-form > .payment-section > .btn-submit').click()

    // After (resilient):
    await page
      .getByTestId("checkout-form")
      .getByRole("button", { name: "Complete Payment" })
      .click();

    await expect(page.getByText("Payment successful")).toBeVisible();
  });
});
```

**Why These Fail**:

- **CSS classes**: Change frequently with design updates (Tailwind, CSS modules)
- **nth() indexes**: Fragile to element reordering (new features, A/B tests)
- **Complex XPath**: Unreadable, breaks with HTML structure changes
- **HTML IDs**: Not stable (accessibility improvements change IDs)

**Better Approach**: Use selector hierarchy (testid > ARIA > text)

---

### Example 4: Selector Debugging Techniques (Inspector, DevTools, MCP)

**Context**: Debug selector failures interactively to find better alternatives

**Implementation**:

```typescript
// tests/selectors/debugging-techniques.spec.ts
import { test, expect } from "@playwright/test";

test.describe("Selector Debugging Techniques", () => {
  test("use Playwright Inspector to test selectors", async ({ page }) => {
    await page.goto("/dashboard");

    // Pause test to open Inspector
    await page.pause();

    // In Inspector console, test selectors:
    // page.getByTestId('user-menu')              ✅ Works
    // page.getByRole('button', { name: 'Profile' }) ✅ Works
    // page.locator('.btn-primary')               ❌ Brittle

    // Use "Pick Locator" feature to generate selectors
    // Use "Record" mode to capture user interactions

    await page.getByTestId("user-menu").click();
    await expect(page.getByRole("menu")).toBeVisible();
  });

  test("use locator.all() to debug lists", async ({ page }) => {
    await page.goto("/products");

    // Debug: How many products are visible?
    const products = await page.getByTestId("product-card").all();
    console.log(`Found ${products.length} products`);

    // Debug: What text is in each product?
    for (const product of products) {
      const text = await product.textContent();
      console.log(`Product text: ${text}`);
    }

    // Use findings to build better selector
    await page.getByTestId("product-card").filter({ hasText: "Laptop" }).click();
  });

  test("use DevTools console to test selectors", async ({ page }) => {
    await page.goto("/checkout");

    // Open DevTools (manually or via page.pause())
    // Test selectors in console:
    // document.querySelectorAll('[data-testid="payment-method"]')
    // document.querySelector('#credit-card-input')

    // Find robust selector through trial and error
    await page.getByTestId("payment-method").selectOption("credit-card");
  });

  test("MCP browser_generate_locator (if available)", async ({ page }) => {
    await page.goto("/products");

    // If Playwright MCP available, use browser_generate_locator:
    // 1. Click element in browser
    // 2. MCP generates optimal selector
    // 3. Copy into test

    // Example output from MCP:
    // page.getByRole('link', { name: 'Product A' })

    // Use generated selector
    await page.getByRole("link", { name: "Product A" }).click();
    await expect(page).toHaveURL(/\/products\/\d+/);
  });
});
```

**Key Points**:

- Playwright Inspector: Interactive selector testing with "Pick Locator" feature
- `locator.all()`: Debug lists to understand structure and content
- DevTools console: Test CSS selectors before adding to tests
- MCP browser_generate_locator: Auto-generate optimal selectors (if MCP available)
- Always validate selectors work before committing

---

### Example 2: Selector Refactoring Guide (Before/After Patterns)

**Context**: Systematically improve brittle selectors to resilient alternatives

**Implementation**:

```typescript
// tests/selectors/refactoring-guide.spec.ts
import { test, expect } from "@playwright/test";

test.describe("Selector Refactoring Patterns", () => {
  test("refactor: CSS class → data-testid", async ({ page }) => {
    await page.goto("/products");

    // ❌ Before: CSS class (breaks with Tailwind updates)
    // await page.locator('.bg-blue-500.px-4.py-2.rounded').click()

    // ✅ After: data-testid
    await page.getByTestId("add-to-cart-button").click();

    // Implementation: Add data-testid to button component
    // <button className="bg-blue-500 px-4 py-2 rounded" data-testid="add-to-cart-button">
  });

  test("refactor: nth() index → filter()", async ({ page }) => {
    await page.goto("/users");

    // ❌ Before: Index-based (breaks when users reorder)
    // await page.locator('.user-row').nth(2).click()

    // ✅ After: Content-based filter
    await page.locator('[data-testid="user-row"]').filter({ hasText: "john@example.com" }).click();
  });

  test("refactor: Complex XPath → ARIA role", async ({ page }) => {
    await page.goto("/checkout");

    // ❌ Before: Complex XPath (unreadable, brittle)
    // await page.locator('xpath=//div[@id="payment"]//form//button[contains(@class, "submit")]').click()

    // ✅ After: ARIA role
    await page.getByRole("button", { name: "Complete Payment" }).click();
  });

  test("refactor: ID selector → data-testid", async ({ page }) => {
    await page.goto("/settings");

    // ❌ Before: HTML ID (changes with accessibility improvements)
    // await page.locator('#user-profile-section').getByLabel('Name').fill('John')

    // ✅ After: data-testid + semantic label
    await page.getByTestId("user-profile-section").getByLabel("Display Name").fill("John Doe");
  });

  test("refactor: Deeply nested CSS → scoped data-testid", async ({ page }) => {
    await page.goto("/dashboard");

    // ❌ Before: Deep nesting (breaks with structure changes)
    // await page.locator('.container .sidebar .menu .item:nth-child(3) a').click()

    // ✅ After: Scoped data-testid
    const sidebar = page.getByTestId("sidebar");
    await sidebar.getByRole("link", { name: "Settings" }).click();
  });
});
```

**Key Points**:

- CSS class → data-testid (survives design system updates)
- nth() → filter() (content-based vs index-based)
- Complex XPath → ARIA role (readable, semantic)
- ID → data-testid (decouples from HTML structure)
- Deep nesting → scoped locators (modular, maintainable)

---

### Example 3: Selector Best Practices Checklist

```typescript
// tests/selectors/validation-checklist.spec.ts
import { test, expect } from "@playwright/test";

/**
 * Selector Validation Checklist
 *
 * Before committing test, verify selectors meet these criteria:
 */
test.describe("Selector Best Practices Validation", () => {
  test("✅ 1. Prefer data-testid for interactive elements", async ({ page }) => {
    await page.goto("/login");

    // Interactive elements (buttons, inputs, links) should use data-testid
    await page.getByTestId("email-input").fill("test@example.com");
    await page.getByTestId("login-button").click();
  });

  test("✅ 2. Use ARIA roles for semantic elements", async ({ page }) => {
    await page.goto("/dashboard");

    // Semantic elements (headings, navigation, forms) use ARIA
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await page.getByRole("navigation").getByRole("link", { name: "Settings" }).click();
  });

  test("✅ 3. Avoid CSS classes (except when testing styles)", async ({ page }) => {
    await page.goto("/products");

    // ❌ Never for interaction: page.locator('.btn-primary')
    // ✅ Only for visual regression: await expect(page.locator('.error-banner')).toHaveCSS('color', 'rgb(255, 0, 0)')
  });

  test("✅ 4. Use filter() instead of nth() for lists", async ({ page }) => {
    await page.goto("/orders");

    // List selection should be content-based
    await page.getByTestId("order-row").filter({ hasText: "Order #12345" }).click();
  });

  test("✅ 5. Selectors are human-readable", async ({ page }) => {
    await page.goto("/checkout");

    // ✅ Good: Clear intent
    await page
      .getByTestId("shipping-address-form")
      .getByLabel("Street Address")
      .fill("123 Main St");

    // ❌ Bad: Cryptic
    // await page.locator('div > div:nth-child(2) > input[type="text"]').fill('123 Main St')
  });
});
```

**Validation Rules**:

1. **Interactive elements** (buttons, inputs) → data-testid
2. **Semantic elements** (headings, nav, forms) → ARIA roles
3. **CSS classes** → Avoid (except visual regression tests)
4. **Lists** → filter() over nth() (content-based selection)
5. **Readability** → Selectors document user intent (clear, semantic)

---

## Selector Resilience Checklist

Before deploying selectors:

- [ ] **Hierarchy followed**: data-testid (1st choice) > ARIA (2nd) > text (3rd) > CSS/ID (last resort)
- [ ] **Interactive elements use data-testid**: Buttons, inputs, links have dedicated test attributes
- [ ] **Semantic elements use ARIA**: Headings, navigation, forms use roles and accessible names
- [ ] **No brittle patterns**: No CSS classes (except visual tests), no arbitrary nth(), no complex XPath
- [ ] **Dynamic content handled**: Regex for IDs/timestamps, filter() for lists, partial matching for text
- [ ] **Selectors are scoped**: Use container locators to narrow scope (prevent ambiguity)
- [ ] **Human-readable**: Selectors document user intent (clear, semantic, maintainable)
- [ ] **Validated in Inspector**: Test selectors interactively before committing (page.pause())

## Integration Points

- **Used in workflows**: `*atdd` (generate tests with robust selectors), `*automate` (healing selector failures), `*test-review` (validate selector quality)
- **Related fragments**: `test-healing-patterns.md` (selector failure diagnosis), `fixture-architecture.md` (page object alternatives), `test-quality.md` (maintainability standards)
- **Tools**: Playwright Inspector (Pick Locator), DevTools console, Playwright MCP browser_generate_locator (optional)

_Source: Playwright selector best practices, accessibility guidelines (ARIA), production test maintenance patterns_
