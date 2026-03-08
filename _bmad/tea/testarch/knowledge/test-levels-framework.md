<!-- Powered by BMAD-CORE™ -->

# Test Levels Framework

Comprehensive guide for determining appropriate test levels (unit, integration, E2E) for different scenarios.

## Test Level Decision Matrix

### Unit Tests

**When to use:**

- Testing pure functions and business logic
- Algorithm correctness
- Input validation and data transformation
- Error handling in isolated components
- Complex calculations or state machines

**Characteristics:**

- Fast execution (immediate feedback)
- No external dependencies (DB, API, file system)
- Highly maintainable and stable
- Easy to debug failures

**Example scenarios:**

```yaml
unit_test:
  component: "PriceCalculator"
  scenario: "Calculate discount with multiple rules"
  justification: "Complex business logic with multiple branches"
  mock_requirements: "None - pure function"
```

### Integration Tests

**When to use:**

- Component interaction verification
- Database operations and transactions
- API endpoint contracts
- Service-to-service communication
- Middleware and interceptor behavior

**Characteristics:**

- Moderate execution time
- Tests component boundaries
- May use test databases or containers
- Validates system integration points

**Example scenarios:**

```yaml
integration_test:
  components: ["UserService", "AuthRepository"]
  scenario: "Create user with role assignment"
  justification: "Critical data flow between service and persistence"
  test_environment: "In-memory database"
```

### End-to-End Tests

**When to use:**

- Critical user journeys
- Cross-system workflows
- Visual regression testing
- Compliance and regulatory requirements
- Final validation before release

**Characteristics:**

- Slower execution
- Tests complete workflows
- Requires full environment setup
- Most realistic but most brittle

**Example scenarios:**

```yaml
e2e_test:
  journey: "Complete checkout process"
  scenario: "User purchases with saved payment method"
  justification: "Revenue-critical path requiring full validation"
  environment: "Staging with test payment gateway"
```

## Test Level Selection Rules

### Favor Unit Tests When:

- Logic can be isolated
- No side effects involved
- Fast feedback needed
- High cyclomatic complexity

### Favor Integration Tests When:

- Testing persistence layer
- Validating service contracts
- Testing middleware/interceptors
- Component boundaries critical

### Favor E2E Tests When:

- User-facing critical paths
- Multi-system interactions
- Regulatory compliance scenarios
- Visual regression important

## Anti-patterns to Avoid

- E2E testing for business logic validation
- Unit testing framework behavior
- Integration testing third-party libraries
- Duplicate coverage across levels

## Duplicate Coverage Guard

**Before adding any test, check:**

1. Is this already tested at a lower level?
2. Can a unit test cover this instead of integration?
3. Can an integration test cover this instead of E2E?

**Coverage overlap is only acceptable when:**

- Testing different aspects (unit: logic, integration: interaction, e2e: user experience)
- Critical paths requiring defense in depth
- Regression prevention for previously broken functionality

## Test Naming Conventions

- Unit: `test_{component}_{scenario}`
- Integration: `test_{flow}_{interaction}`
- E2E: `test_{journey}_{outcome}`

## Test ID Format

`{EPIC}.{STORY}-{LEVEL}-{SEQ}`

Examples:

- `1.3-UNIT-001`
- `1.3-INT-002`
- `1.3-E2E-001`

## Real Code Examples

### Example 1: E2E Test (Full User Journey)

**Scenario**: User logs in, navigates to dashboard, and places an order.

```typescript
// tests/e2e/checkout-flow.spec.ts
import { test, expect } from "@playwright/test";
import { createUser, createProduct } from "../test-utils/factories";

test.describe("Checkout Flow", () => {
  test("user can complete purchase with saved payment method", async ({ page, apiRequest }) => {
    // Setup: Seed data via API (fast!)
    const user = createUser({ email: "buyer@example.com", hasSavedCard: true });
    const product = createProduct({ name: "Widget", price: 29.99, stock: 10 });

    await apiRequest.post("/api/users", { data: user });
    await apiRequest.post("/api/products", { data: product });

    // Network-first: Intercept BEFORE action
    const loginPromise = page.waitForResponse("**/api/auth/login");
    const cartPromise = page.waitForResponse("**/api/cart");
    const orderPromise = page.waitForResponse("**/api/orders");

    // Step 1: Login
    await page.goto("/login");
    await page.fill('[data-testid="email"]', user.email);
    await page.fill('[data-testid="password"]', "password123");
    await page.click('[data-testid="login-button"]');
    await loginPromise;

    // Assert: Dashboard visible
    await expect(page).toHaveURL("/dashboard");
    await expect(page.getByText(`Welcome, ${user.name}`)).toBeVisible();

    // Step 2: Add product to cart
    await page.goto(`/products/${product.id}`);
    await page.click('[data-testid="add-to-cart"]');
    await cartPromise;
    await expect(page.getByText("Added to cart")).toBeVisible();

    // Step 3: Checkout with saved payment
    await page.goto("/checkout");
    await expect(page.getByText("Visa ending in 1234")).toBeVisible(); // Saved card
    await page.click('[data-testid="use-saved-card"]');
    await page.click('[data-testid="place-order"]');
    await orderPromise;

    // Assert: Order confirmation
    await expect(page.getByText("Order Confirmed")).toBeVisible();
    await expect(page.getByText(/Order #\d+/)).toBeVisible();
    await expect(page.getByText("$29.99")).toBeVisible();
  });
});
```

**Key Points (E2E)**:

- Tests complete user journey across multiple pages
- API setup for data (fast), UI for assertions (user-centric)
- Network-first interception to prevent flakiness
- Validates critical revenue path end-to-end

### Example 2: Integration Test (API/Service Layer)

**Scenario**: UserService creates user and assigns role via AuthRepository.

```typescript
// tests/integration/user-service.spec.ts
import { test, expect } from "@playwright/test";
import { createUser } from "../test-utils/factories";

test.describe("UserService Integration", () => {
  test("should create user with admin role via API", async ({ request }) => {
    const userData = createUser({ role: "admin" });

    // Direct API call (no UI)
    const response = await request.post("/api/users", {
      data: userData,
    });

    expect(response.status()).toBe(201);

    const createdUser = await response.json();
    expect(createdUser.id).toBeTruthy();
    expect(createdUser.email).toBe(userData.email);
    expect(createdUser.role).toBe("admin");

    // Verify database state
    const getResponse = await request.get(`/api/users/${createdUser.id}`);
    expect(getResponse.status()).toBe(200);

    const fetchedUser = await getResponse.json();
    expect(fetchedUser.role).toBe("admin");
    expect(fetchedUser.permissions).toContain("user:delete");
    expect(fetchedUser.permissions).toContain("user:update");

    // Cleanup
    await request.delete(`/api/users/${createdUser.id}`);
  });

  test("should validate email uniqueness constraint", async ({ request }) => {
    const userData = createUser({ email: "duplicate@example.com" });

    // Create first user
    const response1 = await request.post("/api/users", { data: userData });
    expect(response1.status()).toBe(201);

    const user1 = await response1.json();

    // Attempt duplicate email
    const response2 = await request.post("/api/users", { data: userData });
    expect(response2.status()).toBe(409); // Conflict
    const error = await response2.json();
    expect(error.message).toContain("Email already exists");

    // Cleanup
    await request.delete(`/api/users/${user1.id}`);
  });
});
```

**Key Points (Integration)**:

- Tests service layer + database interaction
- No UI involved—pure API validation
- Business logic focus (role assignment, constraints)
- Faster than E2E, more realistic than unit tests

### Example 3: Component Test (Isolated UI Component)

**Scenario**: Test button component in isolation with props and user interactions.

```typescript
// src/components/Button.cy.tsx (Cypress Component Test)
import { Button } from './Button';

describe('Button Component', () => {
  it('should render with correct label', () => {
    cy.mount(<Button label="Click Me" />);
    cy.contains('Click Me').should('be.visible');
  });

  it('should call onClick handler when clicked', () => {
    const onClickSpy = cy.stub().as('onClick');
    cy.mount(<Button label="Submit" onClick={onClickSpy} />);

    cy.get('button').click();
    cy.get('@onClick').should('have.been.calledOnce');
  });

  it('should be disabled when disabled prop is true', () => {
    cy.mount(<Button label="Disabled" disabled={true} />);
    cy.get('button').should('be.disabled');
    cy.get('button').should('have.attr', 'aria-disabled', 'true');
  });

  it('should show loading spinner when loading', () => {
    cy.mount(<Button label="Loading" loading={true} />);
    cy.get('[data-testid="spinner"]').should('be.visible');
    cy.get('button').should('be.disabled');
  });

  it('should apply variant styles correctly', () => {
    cy.mount(<Button label="Primary" variant="primary" />);
    cy.get('button').should('have.class', 'btn-primary');

    cy.mount(<Button label="Secondary" variant="secondary" />);
    cy.get('button').should('have.class', 'btn-secondary');
  });
});

// Playwright Component Test equivalent
import { test, expect } from '@playwright/experimental-ct-react';
import { Button } from './Button';

test.describe('Button Component', () => {
  test('should call onClick handler when clicked', async ({ mount }) => {
    let clicked = false;
    const component = await mount(
      <Button label="Submit" onClick={() => { clicked = true; }} />
    );

    await component.getByRole('button').click();
    expect(clicked).toBe(true);
  });

  test('should be disabled when loading', async ({ mount }) => {
    const component = await mount(<Button label="Loading" loading={true} />);
    await expect(component.getByRole('button')).toBeDisabled();
    await expect(component.getByTestId('spinner')).toBeVisible();
  });
});
```

**Key Points (Component)**:

- Tests UI component in isolation (no full app)
- Props + user interactions + visual states
- Faster than E2E, more realistic than unit tests for UI
- Great for design system components

### Example 4: Unit Test (Pure Function)

**Scenario**: Test pure business logic function without framework dependencies.

```typescript
// src/utils/price-calculator.test.ts (Jest/Vitest)
import { calculateDiscount, applyTaxes, calculateTotal } from "./price-calculator";

describe("PriceCalculator", () => {
  describe("calculateDiscount", () => {
    it("should apply percentage discount correctly", () => {
      const result = calculateDiscount(100, { type: "percentage", value: 20 });
      expect(result).toBe(80);
    });

    it("should apply fixed amount discount correctly", () => {
      const result = calculateDiscount(100, { type: "fixed", value: 15 });
      expect(result).toBe(85);
    });

    it("should not apply discount below zero", () => {
      const result = calculateDiscount(10, { type: "fixed", value: 20 });
      expect(result).toBe(0);
    });

    it("should handle no discount", () => {
      const result = calculateDiscount(100, { type: "none", value: 0 });
      expect(result).toBe(100);
    });
  });

  describe("applyTaxes", () => {
    it("should calculate tax correctly for US", () => {
      const result = applyTaxes(100, { country: "US", rate: 0.08 });
      expect(result).toBe(108);
    });

    it("should calculate tax correctly for EU (VAT)", () => {
      const result = applyTaxes(100, { country: "DE", rate: 0.19 });
      expect(result).toBe(119);
    });

    it("should handle zero tax rate", () => {
      const result = applyTaxes(100, { country: "US", rate: 0 });
      expect(result).toBe(100);
    });
  });

  describe("calculateTotal", () => {
    it("should calculate total with discount and taxes", () => {
      const items = [
        { price: 50, quantity: 2 }, // 100
        { price: 30, quantity: 1 }, // 30
      ];
      const discount = { type: "percentage", value: 10 }; // -13
      const tax = { country: "US", rate: 0.08 }; // +9.36

      const result = calculateTotal(items, discount, tax);
      expect(result).toBeCloseTo(126.36, 2);
    });

    it("should handle empty items array", () => {
      const result = calculateTotal([], { type: "none", value: 0 }, { country: "US", rate: 0 });
      expect(result).toBe(0);
    });

    it("should calculate correctly without discount or tax", () => {
      const items = [{ price: 25, quantity: 4 }];
      const result = calculateTotal(items, { type: "none", value: 0 }, { country: "US", rate: 0 });
      expect(result).toBe(100);
    });
  });
});
```

**Key Points (Unit)**:

- Pure function testing—no framework dependencies
- Fast execution (milliseconds)
- Edge case coverage (zero, negative, empty inputs)
- High cyclomatic complexity handled at unit level

## When to Use Which Level

| Scenario               | Unit          | Integration       | E2E           |
| ---------------------- | ------------- | ----------------- | ------------- |
| Pure business logic    | ✅ Primary    | ❌ Overkill       | ❌ Overkill   |
| Database operations    | ❌ Can't test | ✅ Primary        | ❌ Overkill   |
| API contracts          | ❌ Can't test | ✅ Primary        | ⚠️ Supplement |
| User journeys          | ❌ Can't test | ❌ Can't test     | ✅ Primary    |
| Component props/events | ✅ Partial    | ⚠️ Component test | ❌ Overkill   |
| Visual regression      | ❌ Can't test | ⚠️ Component test | ✅ Primary    |
| Error handling (logic) | ✅ Primary    | ⚠️ Integration    | ❌ Overkill   |
| Error handling (UI)    | ❌ Partial    | ⚠️ Component test | ✅ Primary    |

## Anti-Pattern Examples

**❌ BAD: E2E test for business logic**

```typescript
// DON'T DO THIS
test("calculate discount via UI", async ({ page }) => {
  await page.goto("/calculator");
  await page.fill('[data-testid="price"]', "100");
  await page.fill('[data-testid="discount"]', "20");
  await page.click('[data-testid="calculate"]');
  await expect(page.getByText("$80")).toBeVisible();
});
// Problem: Slow, brittle, tests logic that should be unit tested
```

**✅ GOOD: Unit test for business logic**

```typescript
test("calculate discount", () => {
  expect(calculateDiscount(100, 20)).toBe(80);
});
// Fast, reliable, isolated
```

_Source: Murat Testing Philosophy (test pyramid), existing test-levels-framework.md structure._
