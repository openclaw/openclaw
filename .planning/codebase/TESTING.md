# Testing Patterns

**Analysis Date:** 2026-02-02

## Test Framework

**Runner:**
- Vitest with V8 coverage
- Config: `vitest.config.ts`
- Version: `^4.0.18`

**Assertion Library:**
- Vitest built-in `expect`
- No additional assertion library needed

**Run Commands:**
```bash
pnpm test              # Run all tests (parallelized)
pnpm test:coverage     # Run tests with coverage report
pnpm test:watch       # Watch mode for development
pnpm test:live        # Live tests with real API keys
pnpm test:e2e         # End-to-end tests
pnpm test:all         # Full test suite (lint + build + test + e2e + live + docker)
```

## Test File Organization

**Location:**
- Co-located with source files: `src/**/*.test.ts`
- Extension tests: `extensions/**/*.test.ts`
- Test utilities: `test/` and `src/test-utils/`

**Naming:**
- Match source files exactly: `utils/boolean.ts` → `utils/boolean.test.ts`
- Use `.test.ts` suffix for all tests
- E2E tests use `.e2e.test.ts` suffix

**Structure:**
```
src/
├── utils/
│   ├── boolean.ts
│   └── boolean.test.ts
├── agents/
│   ├── agent-scope.ts
│   └── agent-scope.test.ts
└── test-utils/
    └── channel-plugins.ts
```

## Test Structure

**Suite Organization:**
```typescript
describe("functionName", () => {
  it("should do something", () => {
    // Arrange
    const input = "test";

    // Act
    const result = functionName(input);

    // Assert
    expect(result).toBe("expected");
  });

  it("should handle edge cases", async () => {
    // Test async behavior
    const result = await asyncFunction();
    expect(result).resolves.toBe("expected");
  });
});
```

**Setup/Teardown:**
- Global setup in `test/setup.ts`
- Per-test setup in `beforeEach()`
- Per-test cleanup in `afterEach()`

**Common Test Patterns:**
- Use `describe()` for logical grouping
- Use `it()` for individual test cases
- Use `expect()` for assertions
- Use `vi.mock()` for dependency mocking

## Mocking

**Framework:** Vitest mock functions

**Patterns:**
```typescript
// Hoisted mocks
const mocks = vi.hoisted(() => ({
  someFunction: vi.fn(),
}));

// Module mocking
vi.mock("../module.ts", async () => {
  const actual = await vi.importActual<typeof import("../module.ts")>("../module.ts");
  return {
    ...actual,
    someFunction: mocks.someFunction,
  };
});

// Function mocking
const mockFunction = vi.fn().mockResolvedValue({ ok: true });
```

**What to Mock:**
- External dependencies (API clients, databases)
- File system operations
- Network requests
- Time-sensitive functions

**What NOT to Mock:**
- Simple utility functions
- Data transformation logic
- Error handling patterns

## Fixtures and Factories

**Test Data:**
```typescript
// Test configuration
const testConfig: OpenClawConfig = {
  channels: {
    telegram: { botToken: "test-token" },
  },
};

// Mock responses
const mockResponse = {
  messageId: "123",
  chatId: "456",
};

// Test helper functions
const createTestPlugin = (id: ChannelId) => ({
  id,
  meta: { id, label: "Test", blurb: "Test stub" },
  capabilities: { chatTypes: ["direct", "group"] },
  config: { /* ... */ },
  outbound: { /* ... */ },
});
```

**Location:**
- Test utilities in `src/test-utils/`
- Test setup in `test/setup.ts`
- Extension-specific test helpers in extension directories

## Coverage

**Requirements:** 70% threshold for lines/branches/functions/statements

**View Coverage:**
```bash
pnpm test:coverage
# Opens coverage report with line-by-line analysis
```

**Coverage Exclusions:**
- Entrypoints: `src/entry.ts`, `src/index.ts`
- CLI wiring: `src/cli/**`, `src/commands/**`
- Daemon code: `src/daemon/**`
- Gateway integration: `src/gateway/**`
- Channel surfaces: `src/discord/**`, `src/slack/**`, etc.
- Interactive UIs: `src/tui/**`, `src/wizard/**`
- Test files: `src/**/*.test.ts`

## Test Types

**Unit Tests:**
- Scope: Individual functions and modules
- Pattern: Isolated testing with mocks
- Location: `src/**/*.test.ts`
- Example: `src/utils/boolean.test.ts`

**Integration Tests:**
- Scope: Component interactions
- Pattern: Real dependencies where practical
- Location: Various test files
- Example: `src/infra/outbound/deliver.test.ts`

**E2E Tests:**
- Framework: Vitest with `.e2e.test.ts` suffix
- Scope: Full application flows
- Pattern: Real scenarios with actual services
- Command: `pnpm test:e2e`

**Live Tests:**
- Environment: Uses real API keys
- Trigger: `CLAWDBOT_LIVE_TEST=1 pnpm test:live`
- Scope: Real integrations
- Example: `src/agents/anthropic.setup-token.live.test.ts`

## Common Patterns

**Async Testing:**
```typescript
it("async operation", async () => {
  const result = await asyncFunction();
  expect(result).resolves.toBe("expected");
});

it("async error handling", async () => {
  await expect(asyncFunction()).rejects.toThrow("error message");
});
```

**Mock Setup:**
```typescript
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});
```

**Error Testing:**
```typescript
it("handles invalid input", () => {
  expect(() => function(null)).toThrow("Invalid input");
});

it("returns error for missing config", async () => {
  const result = await functionWithoutConfig();
  expect(result).toEqual({ error: "Configuration missing" });
});
```

**Testing Configuration Loading:**
```typescript
it("loads default config", () => {
  const cfg = loadConfig();
  expect(cfg).toMatchObject({ channels: {} });
});
```

**Testing Agent Operations:**
```typescript
it("resolves agent config", () => {
  const cfg: OpenClawConfig = { agents: { list: [{ id: "main" }] } };
  const result = resolveAgentConfig(cfg, "main");
  expect(result).toBeDefined();
});
```

## Test Environment Setup

**Global Setup:**
- Environment isolation with `withIsolatedTestHome()`
- Plugin registry setup for channel tests
- Warning filters installed

**Test Isolation:**
- Each test gets fresh mocks
- Temp directories for file operations
- Environment variable isolation

**Channel Testing:**
```typescript
beforeEach(() => {
  setActivePluginRegistry(createDefaultRegistry());
});

afterEach(() => {
  setActivePluginRegistry(createDefaultRegistry());
});
```

## Extension Testing

**Extension Tests:**
- Located in `extensions/*/src/*.test.ts`
- Follow same patterns as core tests
- May have additional setup for extension-specific needs

**Example Extension Test:**
```typescript
// extensions/matrix/src/matrix/client.test.ts
describe("resolveMatrixConfig", () => {
  it("prefers config over env", () => {
    const cfg = { channels: { matrix: { homeserver: "https://cfg.example.org" } } };
    const env = { MATRIX_HOMESERVER: "https://env.example.org" };
    const resolved = resolveMatrixConfig(cfg, env);
    expect(resolved.homeserver).toBe("https://cfg.example.org");
  });
});
```

## Test Execution

**Parallel Execution:**
- Unit tests run in parallel with configurable workers
- Extensions run in separate parallel groups
- Gateway tests run serially
- Worker count capped at 16, adjusted for CI

**CI Integration:**
- Full test suite on PRs
- Coverage thresholds enforced
- Live tests in CI with proper environment setup

**Test Isolation:**
- No shared state between tests
- Each test cleans up after itself
- Proper mock reset between tests

---

*Testing analysis: 2026-02-02*