# Testing Patterns

## What to Test First

Prioritize critical user journeys, auth boundaries, payments, file upload or download flows, and state transitions that are expensive to break.

Do not spend E2E budget on trivial presentational details that cheaper unit or component tests can cover.

Prefer assertions on what the user can observe: visible state, text, URL, enabled or disabled controls, downloads, navigation, and persisted app state.

## Test Structure

```typescript
import { test, expect } from "@playwright/test";

test.describe("Checkout Flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/products");
  });

  test("completes purchase with valid card", async ({ page }) => {
    await page.getByTestId("product-card").filter({ hasText: "Product A" }).click();
    await page.getByRole("button", { name: "Add to Cart" }).click();
    await page.getByRole("link", { name: "Checkout" }).click();
    await expect(page.getByRole("heading", { name: "Order Summary" })).toBeVisible();
  });
});
```

## Page Object Model

Use page objects when a flow is reused across many tests. Do not build a giant abstraction layer before duplication is real.

```typescript
export class CheckoutPage {
  constructor(private page: Page) {}

  readonly cartItems = this.page.getByTestId("cart-item");
  readonly checkoutButton = this.page.getByRole("button", { name: "Checkout" });
  readonly totalPrice = this.page.getByTestId("total-price");

  async removeItem(name: string) {
    await this.cartItems.filter({ hasText: name }).getByRole("button", { name: "Remove" }).click();
  }

  async expectTotal(amount: string) {
    await expect(this.totalPrice).toHaveText(amount);
  }
}
```

## Fixtures

```typescript
import { test as base } from "@playwright/test";
import { CheckoutPage } from "./pages/checkout.page";

type Fixtures = {
  checkoutPage: CheckoutPage;
};

export const test = base.extend<Fixtures>({
  checkoutPage: async ({ page }, use) => {
    await page.goto("/checkout");
    await use(new CheckoutPage(page));
  },
});
```

## Isolation Rules

- Keep tests independent so they can run alone, in parallel, or after retries without hidden dependencies.
- If tests mutate shared backend state, use dedicated accounts, seeded data, or per-worker isolation instead of reusing one mutable user everywhere.
- When auth is shared, prefer the Playwright setup-project pattern or one account per worker over ad hoc state reuse.

## Mock What You Do Not Need to Re-Test

```typescript
test("shows error on API failure", async ({ page }) => {
  await page.route("**/api/checkout", (route) => {
    route.fulfill({
      status: 500,
      body: JSON.stringify({ error: "Payment failed" }),
    });
  });

  await page.goto("/checkout");
  await page.getByRole("button", { name: "Pay" }).click();
  await expect(page.getByText("Payment failed")).toBeVisible();
});
```

Avoid testing third-party widgets, analytics, payment processors, or upstream APIs end to end unless the point of the test is that exact integration.

## Visual Regression

Use visual assertions for layout or rendering regressions that humans would otherwise miss. Keep viewport, fonts, and animations deterministic.

```typescript
test("matches snapshot", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveScreenshot("dashboard.png", {
    maxDiffPixels: 100,
  });
});
```

## Parallelization

```typescript
export default defineConfig({
  workers: process.env.CI ? 4 : undefined,
  fullyParallel: true,
});

test.describe.configure({ mode: "parallel" });
test.describe.configure({ mode: "serial" });
```

## Authentication State

Persist auth only when the suite already standardizes that pattern and the stored state is safe to reuse.

```typescript
const authFile = "playwright/.auth/user.json";
// Reuse a saved auth file only in suites that intentionally standardize it.
```

For one-off debugging, privileged accounts, or stateful flows that mutate backend data, prefer logging in inside the test or using isolated worker accounts instead of carrying one shared session everywhere.

## Assertions

```typescript
await expect(locator).toBeVisible();
await expect(locator).toHaveText("Expected");
await expect(locator).toBeEnabled();
await expect(locator).toHaveAttribute("href", "/path");
await expect(page).toHaveURL(/dashboard/);

await expect
  .poll(async () => {
    return await page.evaluate(() => window.dataLoaded);
  })
  .toBe(true);
```
