# Selector Strategies

## Hierarchy (Most to Least Resilient)

### 1. Role-Based (Best)

```typescript
page.getByRole("button", { name: "Submit" });
page.getByRole("link", { name: /sign up/i });
page.getByRole("heading", { level: 1 });
page.getByRole("textbox", { name: "Email" });
```

### 2. Test IDs (Explicit)

```typescript
page.getByTestId("checkout-button");
page.getByTestId("product-card");
```

Configure in `playwright.config.ts`:

```typescript
use: {
  testIdAttribute: "data-testid";
}
```

### 3. Label/Placeholder (Forms)

```typescript
page.getByLabel("Email address");
page.getByPlaceholder("Enter your email");
```

### 4. Text Content (Visible)

```typescript
page.getByText("Add to Cart", { exact: true });
page.getByText(/welcome/i); // regex for flexibility
```

### 5. CSS (Last Resort)

```typescript
// Avoid these patterns:
page.locator(".css-1a2b3c"); // generated class
page.locator("div > span:nth-child(2)"); // positional
page.locator("#root > div > div > button"); // deep nesting

// Acceptable:
page.locator('[data-product-id="123"]'); // semantic attribute
page.locator("form.login-form"); // stable class
```

## Chaining and Filtering

```typescript
page.getByRole("listitem").filter({ hasText: "Product A" });

page.getByTestId("cart").getByRole("button", { name: "Remove" });
```

Prefer filtering or parent-child chaining over `first()`, `last()`, or `nth()`. Use positional locators only when order is the thing being tested or there is genuinely no stable identity.

If a locator matches multiple elements, do not silence strictness with position by default. Disambiguate the locator until it represents the intended target.

## Frame Handling

```typescript
// Named frame
const frame = page.frameLocator('iframe[name="checkout"]');
frame.getByRole("button", { name: "Pay" }).click();

// Frame by URL
page.frameLocator('iframe[src*="stripe"]');
```

## Shadow DOM

```typescript
// Playwright pierces shadow DOM by default
page.locator("my-component").getByRole("button");
```

## Common Mistakes

| Mistake                                    | Better                                                 |
| ------------------------------------------ | ------------------------------------------------------ |
| `page.locator('button').click()`           | `page.getByRole('button', { name: 'Submit' }).click()` |
| `page.getByTestId('product-card').first()` | filter or chain until only the intended card matches   |
| `nth-child(3)`                             | Filter by text, role, test ID, or parent context       |
| `//div[@class="xyz"]/span[2]`              | Role-based or test ID                                  |
