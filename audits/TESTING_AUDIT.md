# 🧪 AUDITORIA: Testing & Quality Assurance

**Área:** Unit tests, integration tests, E2E tests, coverage, test quality  
**Data:** 2026-02-13  
**Status:** Identificação de gaps + correções propostas

---

## ❌ GAPS IDENTIFICADOS

### 1. Coverage Inconsistente

**Problema:**

- Alguns módulos: 90%+ coverage
- Outros módulos: 30% coverage
- Nenhum enforcement de thresholds
- Coverage reportado mas não bloqueante

**Impacto:**

- Bugs em produção (código não testado)
- Confiança baixa para fazer mudanças
- Medo de refatorar

### 2. Testes de Baixa Qualidade

**Problema:**

- Testes que sempre passam (false positives)
- Testes frágeis (quebram com qualquer mudança)
- Testes lentos (> 1s por teste unit)
- Testes sem assertions claras

**Impacto:**

- Falsa sensação de segurança
- CI lento (desenvolvedores pulam testes locais)
- Difícil diagnosticar failures

### 3. Edge Cases Não Testados

**Problema:**

- Só testam happy path
- Não testam error conditions
- Não testam boundary values
- Não testam race conditions

**Impacto:**

- Bugs descobertos em produção
- User frustration
- Emergency hotfixes

### 4. E2E Tests Ausentes

**Problema:**

- Apenas unit tests
- Integrações não testadas end-to-end
- User flows não validados
- Manual testing relied upon

**Impacto:**

- Regressões em fluxos críticos
- Bugs descobertos por usuários
- Deploy com receio

### 5. Test Data Management Caótico

**Problema:**

- Factories inconsistentes
- Dados hardcoded em testes
- Dependências entre testes (test pollution)
- Sem cleanup após testes

**Impacto:**

- Testes flaky (passam/falham aleatoriamente)
- Difícil reproduzir failures
- Test suite unreliable

---

## ✅ CORREÇÕES NECESSÁRIAS

### Correção 8.1: Coverage Thresholds Obrigatórios

```json
// vitest.config.ts

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],

      // MANDATORY THRESHOLDS (CI FAILS IF NOT MET)
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },

      // Exclude from coverage
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/*.config.ts',
        '**/types.ts',
      ],

      // Per-file thresholds (stricter for critical modules)
      perFile: {
        'src/auth/**': {
          lines: 90,
          functions: 90,
          branches: 85,
          statements: 90,
        },
        'src/payment/**': {
          lines: 95,
          functions: 95,
          branches: 90,
          statements: 95,
        },
      },
    },
  },
});
```

```yaml
# .github/workflows/test.yml

name: Tests

on: [pull_request, push]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install
      - run: pnpm test:coverage
        # BLOCKING: Must pass coverage thresholds

      - name: Upload coverage to Codecov
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/lcov.info
          fail_ci_if_error: true
```

### Correção 8.2: Test Quality Standards

````markdown
# TEST_QUALITY_STANDARDS.md

## The 3 A's Pattern (Mandatory)

Every test MUST follow Arrange-Act-Assert:

```typescript
test("should create order with valid items", async () => {
  // ARRANGE: Setup test data and dependencies
  const user = await createTestUser({ id: "user-1" });
  const items = [
    { productId: "prod-1", quantity: 2, price: 10.0 },
    { productId: "prod-2", quantity: 1, price: 25.0 },
  ];

  // ACT: Execute the operation being tested
  const order = await createOrder({ userId: user.id, items });

  // ASSERT: Verify the expected outcome
  expect(order).toMatchObject({
    userId: "user-1",
    items: expect.arrayContaining([
      expect.objectContaining({ productId: "prod-1", quantity: 2 }),
      expect.objectContaining({ productId: "prod-2", quantity: 1 }),
    ]),
    total: 45.0, // (2 * 10) + (1 * 25)
    status: "pending",
  });
  expect(order.id).toBeDefined();
  expect(order.createdAt).toBeInstanceOf(Date);
});
```
````

## Test Naming Convention

**Format:** `should [expected behavior] when [condition]`

✅ **Good:**

- `should return 401 when token is missing`
- `should create order when items are valid`
- `should reject payment when card is declined`

❌ **Bad:**

- `test1` (not descriptive)
- `it works` (vague)
- `order creation` (no expected behavior)

## Test Independence

**Every test MUST:**

- [ ] Run in isolation (no shared state)
- [ ] Clean up after itself
- [ ] Not depend on execution order
- [ ] Be idempotent (same result every run)

```typescript
// ❌ BAD: Shared state between tests
let user: User;

beforeAll(() => {
  user = createTestUser();
});

test("test 1", () => {
  user.name = "Alice"; // Mutates shared state!
});

test("test 2", () => {
  expect(user.name).toBe("Bob"); // Fails if test 1 ran first
});

// ✅ GOOD: Each test creates its own data
test("test 1", () => {
  const user = createTestUser({ name: "Alice" });
  // Use user...
});

test("test 2", () => {
  const user = createTestUser({ name: "Bob" });
  // Use user...
});
```

## Edge Cases (Mandatory)

Every feature MUST test:

### 1. Happy Path

```typescript
test("should process valid payment", async () => {
  const payment = await processPayment({
    amount: 100.0,
    cardToken: "valid_token",
  });
  expect(payment.status).toBe("succeeded");
});
```

### 2. Invalid Input

```typescript
test("should reject negative amount", async () => {
  await expect(processPayment({ amount: -10.0, cardToken: "valid_token" })).rejects.toThrow(
    "Amount must be positive",
  );
});
```

### 3. Missing Required Fields

```typescript
test("should reject when card token is missing", async () => {
  await expect(processPayment({ amount: 100.0 })).rejects.toThrow("Card token is required");
});
```

### 4. Boundary Values

```typescript
test("should accept minimum amount (1 cent)", async () => {
  const payment = await processPayment({
    amount: 0.01,
    cardToken: "valid_token",
  });
  expect(payment.status).toBe("succeeded");
});

test("should accept maximum amount", async () => {
  const payment = await processPayment({
    amount: 999999.99,
    cardToken: "valid_token",
  });
  expect(payment.status).toBe("succeeded");
});
```

### 5. External Service Failures

```typescript
test("should handle Stripe API timeout", async () => {
  mockStripe.charge.mockRejectedValue(new Error("Timeout"));

  await expect(processPayment({ amount: 100.0, cardToken: "valid_token" })).rejects.toThrow(
    "Payment service unavailable",
  );
});

test("should handle Stripe rate limiting", async () => {
  mockStripe.charge.mockRejectedValue(new Error("Rate limit exceeded"));

  await expect(processPayment({ amount: 100.0, cardToken: "valid_token" })).rejects.toThrow(
    "Too many requests",
  );
});
```

### 6. Race Conditions (for concurrent operations)

```typescript
test("should prevent double charge", async () => {
  const orderId = "order-1";

  // Simulate two concurrent charge attempts
  const [result1, result2] = await Promise.allSettled([chargeOrder(orderId), chargeOrder(orderId)]);

  // Only one should succeed
  const successes = [result1, result2].filter((r) => r.status === "fulfilled");
  expect(successes).toHaveLength(1);
});
```

## Performance Requirements

**Unit tests:**

- Target: < 50ms per test
- Max: 100ms per test
- Flag tests > 100ms for optimization

**Integration tests:**

- Target: < 500ms per test
- Max: 2s per test

**E2E tests:**

- Target: < 5s per test
- Max: 30s per test

```typescript
// Fail slow tests
test("should be fast", async () => {
  const start = Date.now();

  // Test logic...

  const duration = Date.now() - start;
  expect(duration).toBeLessThan(100); // ms
});
```

## Mocking Strategy

**Mock external dependencies, NOT internal logic:**

```typescript
// ✅ GOOD: Mock external API
vi.mock("stripe", () => ({
  Stripe: vi.fn(() => ({
    charges: {
      create: vi.fn().mockResolvedValue({ id: "charge_123", status: "succeeded" }),
    },
  })),
}));

test("should create charge", async () => {
  const result = await chargeCard({ amount: 100.0, token: "tok_visa" });
  expect(result.id).toBe("charge_123");
});

// ❌ BAD: Mock internal logic (tests nothing)
vi.mock("./payment-service", () => ({
  processPayment: vi.fn().mockResolvedValue({ status: "succeeded" }),
}));

test("should process payment", async () => {
  const result = await processPayment({ amount: 100.0 });
  expect(result.status).toBe("succeeded"); // This test is useless
});
```

````

### Correção 8.3: Test Data Factories

```typescript
// tests/factories/user.factory.ts

import { faker } from '@faker-js/faker';
import type { User } from '@/types';

interface UserFactoryOptions {
  id?: string;
  email?: string;
  name?: string;
  role?: 'user' | 'admin';
  createdAt?: Date;
}

export function createTestUser(overrides: UserFactoryOptions = {}): User {
  return {
    id: overrides.id ?? faker.string.uuid(),
    email: overrides.email ?? faker.internet.email(),
    name: overrides.name ?? faker.person.fullName(),
    role: overrides.role ?? 'user',
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: new Date(),
  };
}

export function createTestUsers(count: number, overrides: UserFactoryOptions = {}): User[] {
  return Array.from({ length: count }, () => createTestUser(overrides));
}

// Usage in tests
test('should list users', async () => {
  const users = createTestUsers(5, { role: 'user' });
  // Use users in test...
});
````

```typescript
// tests/factories/order.factory.ts

export function createTestOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: overrides.id ?? faker.string.uuid(),
    userId: overrides.userId ?? faker.string.uuid(),
    items: overrides.items ?? [
      {
        productId: faker.string.uuid(),
        quantity: faker.number.int({ min: 1, max: 5 }),
        price: parseFloat(faker.commerce.price()),
      },
    ],
    total: overrides.total ?? 100.0,
    status: overrides.status ?? "pending",
    createdAt: overrides.createdAt ?? new Date(),
  };
}
```

### Correção 8.4: Integration Testing

```typescript
// tests/integration/orders.integration.test.ts

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, TestContext } from "../helpers/test-context";

describe("Orders API Integration", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    // Setup: Start test database, seed data, start server
    ctx = await createTestContext({
      database: true,
      server: true,
    });
  });

  afterAll(async () => {
    // Cleanup: Stop server, drop test database
    await ctx.cleanup();
  });

  test("should create order end-to-end", async () => {
    // 1. Create user
    const user = await ctx.db.users.create({
      data: { email: "test@example.com", name: "Test User" },
    });

    // 2. Login to get auth token
    const loginRes = await ctx.http.post("/auth/login", {
      email: "test@example.com",
      password: "password123",
    });
    const { token } = loginRes.data;

    // 3. Create order
    const orderRes = await ctx.http.post(
      "/api/orders",
      {
        items: [{ productId: "prod-1", quantity: 2 }],
      },
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    // 4. Verify order in database
    const order = await ctx.db.orders.findUnique({
      where: { id: orderRes.data.id },
      include: { items: true },
    });

    expect(order).toMatchObject({
      userId: user.id,
      status: "pending",
      items: [expect.objectContaining({ productId: "prod-1", quantity: 2 })],
    });

    // 5. Verify response
    expect(orderRes.status).toBe(201);
    expect(orderRes.data).toMatchObject({
      id: order.id,
      total: expect.any(Number),
    });
  });

  test("should reject order without auth", async () => {
    const res = await ctx.http.post("/api/orders", {
      items: [{ productId: "prod-1", quantity: 1 }],
    });

    expect(res.status).toBe(401);
    expect(res.data.error).toBe("Authentication required");
  });
});
```

### Correção 8.5: E2E Testing with Playwright

```typescript
// tests/e2e/checkout.e2e.test.ts

import { test, expect } from "@playwright/test";

test.describe("Checkout Flow", () => {
  test("should complete purchase end-to-end", async ({ page }) => {
    // 1. Navigate to login
    await page.goto("/login");

    // 2. Login
    await page.fill('input[name="email"]', "test@example.com");
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');

    // 3. Wait for redirect to dashboard
    await page.waitForURL("/dashboard");
    await expect(page.locator("h1")).toContainText("Dashboard");

    // 4. Navigate to products
    await page.click('a[href="/products"]');
    await page.waitForURL("/products");

    // 5. Add product to cart
    await page.click('button[data-product-id="prod-1"]');
    await expect(page.locator(".cart-count")).toHaveText("1");

    // 6. Go to checkout
    await page.click('a[href="/checkout"]');
    await page.waitForURL("/checkout");

    // 7. Verify order summary
    await expect(page.locator(".order-summary")).toContainText("Product 1");
    await expect(page.locator(".order-total")).toContainText("$99.99");

    // 8. Fill payment info (test mode)
    await page.fill('input[name="cardNumber"]', "4242424242424242");
    await page.fill('input[name="expiry"]', "12/25");
    await page.fill('input[name="cvc"]', "123");

    // 9. Submit order
    await page.click('button[type="submit"]:has-text("Place Order")');

    // 10. Wait for success page
    await page.waitForURL(/\/orders\/[a-z0-9-]+/);
    await expect(page.locator("h1")).toContainText("Order Confirmed");

    // 11. Verify order details
    const orderId = page.url().split("/").pop();
    await expect(page.locator(`[data-order-id="${orderId}"]`)).toBeVisible();
    await expect(page.locator(".order-status")).toHaveText("Processing");
  });

  test("should handle payment failure gracefully", async ({ page }) => {
    // Setup: Login and add item to cart
    await page.goto("/checkout");
    await page.fill('input[name="email"]', "test@example.com");
    await page.fill('input[name="password"]', "password123");
    await page.click('button[type="submit"]');

    // Use declined test card
    await page.fill('input[name="cardNumber"]', "4000000000000002");
    await page.fill('input[name="expiry"]', "12/25");
    await page.fill('input[name="cvc"]', "123");

    // Submit
    await page.click('button[type="submit"]:has-text("Place Order")');

    // Verify error message
    await expect(page.locator(".error-message")).toContainText("Your card was declined");

    // Verify still on checkout page (not redirected)
    expect(page.url()).toContain("/checkout");
  });
});
```

### Correção 8.6: Visual Regression Testing

```typescript
// tests/visual/components.visual.test.ts

import { test, expect } from "@playwright/test";

test.describe("Visual Regression", () => {
  test("button variations", async ({ page }) => {
    await page.goto("/storybook/button");

    // Test each button variant
    const variants = ["primary", "secondary", "danger"];

    for (const variant of variants) {
      await page.click(`button[data-variant="${variant}"]`);
      await expect(page.locator(".preview")).toHaveScreenshot(`button-${variant}.png`);
    }
  });

  test("responsive layout", async ({ page }) => {
    await page.goto("/dashboard");

    // Desktop
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(page).toHaveScreenshot("dashboard-desktop.png");

    // Tablet
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page).toHaveScreenshot("dashboard-tablet.png");

    // Mobile
    await page.setViewportSize({ width: 375, height: 667 });
    await expect(page).toHaveScreenshot("dashboard-mobile.png");
  });
});
```

### Correção 8.7: Test Coverage Dashboard

```typescript
// scripts/generate-coverage-report.ts

import { coverageConfigDefaults } from "vitest/config";
import { readFile, writeFile } from "fs/promises";

interface CoverageReport {
  total: {
    lines: { pct: number };
    statements: { pct: number };
    functions: { pct: number };
    branches: { pct: number };
  };
  files: Record<
    string,
    {
      lines: { pct: number };
      // ... other metrics
    }
  >;
}

async function generateReport() {
  // Read coverage from coverage-summary.json
  const coverage: CoverageReport = JSON.parse(
    await readFile("./coverage/coverage-summary.json", "utf-8"),
  );

  // Identify files below threshold
  const lowCoverage = Object.entries(coverage.files)
    .filter(([_, metrics]) => metrics.lines.pct < 80)
    .sort((a, b) => a[1].lines.pct - b[1].lines.pct);

  // Generate HTML report
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Coverage Report</title>
  <style>
    body { font-family: sans-serif; margin: 20px; }
    .good { color: green; }
    .warning { color: orange; }
    .bad { color: red; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background-color: #f2f2f2; }
  </style>
</head>
<body>
  <h1>Test Coverage Report</h1>
  
  <h2>Overall Coverage</h2>
  <table>
    <tr>
      <th>Metric</th>
      <th>Coverage</th>
      <th>Status</th>
    </tr>
    <tr>
      <td>Lines</td>
      <td class="${coverage.total.lines.pct >= 80 ? "good" : "bad"}">
        ${coverage.total.lines.pct.toFixed(2)}%
      </td>
      <td>${coverage.total.lines.pct >= 80 ? "✅" : "❌"}</td>
    </tr>
    <tr>
      <td>Functions</td>
      <td class="${coverage.total.functions.pct >= 80 ? "good" : "bad"}">
        ${coverage.total.functions.pct.toFixed(2)}%
      </td>
      <td>${coverage.total.functions.pct >= 80 ? "✅" : "❌"}</td>
    </tr>
    <tr>
      <td>Branches</td>
      <td class="${coverage.total.branches.pct >= 80 ? "good" : "bad"}">
        ${coverage.total.branches.pct.toFixed(2)}%
      </td>
      <td>${coverage.total.branches.pct >= 80 ? "✅" : "❌"}</td>
    </tr>
  </table>

  <h2>Files Below Threshold (< 80%)</h2>
  <table>
    <tr>
      <th>File</th>
      <th>Coverage</th>
    </tr>
    ${lowCoverage
      .map(
        ([file, metrics]) => `
      <tr>
        <td>${file}</td>
        <td class="bad">${metrics.lines.pct.toFixed(2)}%</td>
      </tr>
    `,
      )
      .join("")}
  </table>
</body>
</html>
  `;

  await writeFile("./coverage/report.html", html);

  // Post to team chat
  if (lowCoverage.length > 0) {
    console.log("\n⚠️  Files below coverage threshold:");
    lowCoverage.slice(0, 10).forEach(([file, metrics]) => {
      console.log(`  - ${file}: ${metrics.lines.pct.toFixed(2)}%`);
    });
  }
}

generateReport();
```

---

## 📊 MÉTRICAS DE SUCESSO

### Coverage

- [ ] 80% line coverage (overall)
- [ ] 90% coverage em módulos críticos (auth, payment)
- [ ] Zero arquivos com < 50% coverage
- [ ] Coverage não regredir entre PRs

### Test Quality

- [ ] Zero testes flaky (passam/falham aleatoriamente)
- [ ] 95% dos testes completam em < 100ms
- [ ] 100% dos testes são independentes (sem ordem)
- [ ] Zero testes skipped/disabled sem justificativa

### Test Completeness

- [ ] 100% de endpoints públicos têm testes
- [ ] 100% de features têm happy path + 3 edge cases
- [ ] 100% de fluxos críticos têm E2E tests
- [ ] Zero bugs recorrentes (todos têm regression test)

---

## 🎯 ACTION ITEMS

### Imediatos

1. [ ] Implementar coverage thresholds obrigatórios (80%)
2. [ ] Criar test factories para User, Order, Payment
3. [ ] Escrever testes para top 5 features sem cobertura
4. [ ] Setup Playwright para E2E testing

### Curto Prazo

1. [ ] Audit todos os testes existentes (qualidade)
2. [ ] Adicionar integration tests para fluxos críticos
3. [ ] Implementar visual regression testing
4. [ ] Setup test coverage dashboard

### Longo Prazo

1. [ ] Mutation testing (avaliar qualidade dos testes)
2. [ ] Performance testing automatizado
3. [ ] Contract testing (entre serviços)
4. [ ] Chaos engineering (resilience testing)

---

**FIM DO DOCUMENTO**
