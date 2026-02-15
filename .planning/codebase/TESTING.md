# Testing Patterns

**Analysis Date:** 2026-02-15

## Test Framework

**Runner:**
- Vitest 4.0.18 with vmForks worker pool
- Multiple config variants:
  - `vitest.config.ts`: Base config with shared settings
  - `vitest.unit.config.ts`: Unit tests only (excludes gateway, extensions)
  - `vitest.e2e.config.ts`: End-to-end tests with vmForks isolation
  - `vitest.live.config.ts`: Live model integration tests (OPENCLAW_LIVE_TEST=1)
  - `vitest.gateway.config.ts`: Gateway-specific tests
  - `vitest.extensions.config.ts`: Extension tests
- Configuration file: `/home/ollie/Development/Tools/openclaw/vitest.config.ts`

**Assertion Library:**
- Vitest built-in: `expect()`
- Import: `import { expect, describe, it, beforeEach, afterEach, vi } from "vitest"`

**Run Commands:**
```bash
pnpm test              # Run all tests (parallel via test-parallel.mjs)
pnpm test:fast        # Unit tests only
pnpm test:coverage    # Unit tests with coverage report
pnpm test:watch       # Watch mode for development
pnpm test:e2e         # End-to-end tests
pnpm test:live        # Live integration tests
pnpm test:all         # Full suite: lint, build, unit, e2e, live, docker
```

## Test File Organization

**Location:**
- Co-located with source: `src/feature.ts` paired with `src/feature.test.ts`
- Test-specific utilities: `test/` directory at repo root
- Setup file: `test/setup.ts` runs before all test suites

**Naming:**
- Unit/integration: `{feature}.test.ts`
- End-to-end: `{feature}.e2e.test.ts`
- Live API integration: `{feature}.live.test.ts`
- Test fixtures/helpers: `{feature}.test-harness.ts` or `test-helpers.ts`

**Inclusion Patterns:**
```typescript
// From vitest.config.ts
include: ["src/**/*.test.ts", "extensions/**/*.test.ts", "test/format-error.test.ts"]
exclude: [
  "dist/**",
  "apps/macos/**",
  "**/*.live.test.ts",      // excluded from unit tests
  "**/*.e2e.test.ts",       // excluded from unit tests
]
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("module-name feature", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // reset test state
  });

  afterEach(async () => {
    // cleanup async operations
    await Promise.allSettled(Array.from(backgroundTasks));
  });

  it("does something when condition X", () => {
    // Arrange
    const input = setupTestData();

    // Act
    const result = functionUnderTest(input);

    // Assert
    expect(result).toBe(expectedValue);
  });

  describe("nested behavior", () => {
    it("handles edge case", () => {
      expect(true).toBe(true);
    });
  });
});
```

**Key Patterns:**
- Nested `describe()` blocks organize related tests
- Clear test names: "does X when Y" format
- Triple-A pattern: Arrange, Act, Assert
- One logical assertion per `expect()` (can chain `.to` calls)
- AAA comments optional but helpful for clarity

## Mocking

**Framework:** Vitest's `vi` API

**Mock Patterns:**
```typescript
// Module mocking (hoisted, runs before imports)
vi.mock("./session.js", () => {
  const createWaSocket = vi.fn(async (options) => {
    const sock = { ws: { close: vi.fn() } };
    if (options?.onQr) {
      setImmediate(() => options.onQr?.("qr-data"));
    }
    return sock;
  });

  return {
    createWaSocket,
    waitForWaConnection: vi.fn(),
    formatError: vi.fn((err) => `formatted:${String(err)}`),
  };
});

// Import mocked module and re-export
const { createWaSocket } = await import("./session.js");

// Function mocking in test
describe("feature", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls dependency correctly", async () => {
    // Chain mock behaviors
    createWaSocket
      .mockResolvedValueOnce({ connected: true })
      .mockRejectedValueOnce(new Error("network"));

    // Test
    await testFunction();

    // Assert calls
    expect(createWaSocket).toHaveBeenCalledTimes(2);
    expect(createWaSocket).toHaveBeenNthCalledWith(1, { timeout: 5000 });
  });
});
```

**Async Mocking:**
```typescript
// For importOriginal to preserve real implementations
vi.mock("../../globals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../globals.js")>();
  return {
    ...actual,  // keep real exports
    shouldLogVerbose: vi.fn(() => true),  // override specific exports
  };
});
```

**Stub Objects:**
```typescript
const replyLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

await deliverWebReply({
  replyResult,
  msg,
  replyLogger,
});

expect(replyLogger.info).toHaveBeenCalledWith(
  expect.any(Object),
  "auto-reply sent (text)"
);
```

**What to Mock:**
- External dependencies (databases, APIs, file system)
- Time-dependent operations (timers, delays)
- Non-deterministic operations
- Complex dependencies with many side effects

**What NOT to Mock:**
- Pure functions (test directly)
- Validation logic (especially Zod schemas)
- Business logic you're testing
- Error conditions you need to verify

## Fixtures and Factories

**Test Data Builders:**
```typescript
// From test/setup.ts - Factory pattern for test objects
function createStubPlugin(params: {
  id: ChannelId;
  label?: string;
  deliveryMode?: "direct" | "gateway";
}): ChannelPlugin {
  return {
    id: params.id,
    meta: {
      id: params.id,
      label: params.label ?? String(params.id),
      // ...
    },
    // ...
  };
}

// In tests
const plugin = createStubPlugin({
  id: "discord",
  label: "Discord",
});

function makeMsg(): WebInboundMsg {
  return {
    from: "+10000000000",
    to: "+20000000000",
    id: "msg-1",
    reply: vi.fn(async () => undefined),
    sendMedia: vi.fn(async () => undefined),
  } as unknown as WebInboundMsg;
}
```

**Setup Patterns:**
- Global setup via `test/setup.ts`:
  - Environment isolation: `withIsolatedTestHome()` creates temp directories
  - Plugin registry: `DEFAULT_PLUGIN_REGISTRY` shared across tests
  - Warning filters: prevent noisy warnings in CI
  - Max listeners raised to 128 (vitest vforks can leak listeners)

**Location:**
- Test fixtures: `test/helpers/` directory
- Registry creation: `test-utils/channel-plugins.js`
- Environment utilities: `test/test-env.ts`

## Coverage

**Requirements:**
```typescript
// From vitest.config.ts
thresholds: {
  lines: 70,
  functions: 70,
  branches: 55,
  statements: 70,
}
```

**View Coverage:**
```bash
pnpm test:coverage
# Generates text report + lcov report
# View in browser: open coverage/index.html
```

**Configuration Notes:**
- `all: false`: Only measure code actually exercised (not theoretical coverage)
- Include only core `src/` files, exclude:
  - Extensions, apps, UI
  - Tests themselves
  - CLI, daemon, TUI, gateway (integration-tested instead)
  - Entry points (smoke/e2e validate)
  - Hard-to-unit-test integration surfaces

## Test Types

**Unit Tests:**
- Scope: Single function or module in isolation
- Mocks: All external dependencies
- Example: `src/web/auto-reply/util.test.ts` - utility functions
- Location: `src/**/*.test.ts`
- Run: `pnpm test:fast`

**Integration Tests:**
- Scope: Multiple modules working together
- Mocks: External services, network, file system
- Real dependencies: business logic, domain objects
- Example: `src/web/auto-reply/monitor/process-message.inbound-contract.test.ts` - contracts
- Location: `src/**/*.test.ts` (same as unit, distinguished by scope)

**Contract Tests:**
- Scope: Verify message/context structure matches expected schema
- Pattern: `expectInboundContextContract(ctx)` helper
- Files: `**/process-message.inbound-contract.test.ts`
- Purpose: Catch shape mismatches in complex data flows

**End-to-End Tests:**
- Scope: Real system integration (spawned processes, actual connections)
- Setup: Often involve Docker, real APIs, or isolated VMs
- Config: `vitest.e2e.config.ts` with vmForks isolation
- Files: `**/*.e2e.test.ts`
- Run: `pnpm test:e2e`

**Live Integration Tests:**
- Scope: Against real external APIs (production-like conditions)
- Trigger: `OPENCLAW_LIVE_TEST=1` environment variable
- Files: `**/*.live.test.ts`
- Run: `pnpm test:live` (skipped in normal test runs)

## Common Patterns

**Async Testing:**
```typescript
// Direct await
it("processes async operation", async () => {
  const result = await functionUnderTest();
  expect(result).toBe(expected);
});

// Using .resolves / .rejects
it("rejects on error", async () => {
  await expect(
    functionUnderTest()
  ).rejects.toThrow("expected error message");
});

// Mock async behavior
beforeEach(() => {
  waitForWaConnection
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("timeout"));
});
```

**Error Testing:**
```typescript
// Direct throw assertion
it("throws on invalid input", () => {
  expect(() => functionUnderTest(null)).toThrow(
    new Error("Input required")
  );
});

// Async error testing
it("rejects with typed error", async () => {
  const err = await functionUnderTest().catch((e) => e);
  expect(err).toHaveProperty("statusCode", 515);
});

// Error case via type assertion
// oxlint-disable-next-line typescript/no-explicit-any
const result = await functionUnderTest() as any;
```

**Environment Stubbing:**
```typescript
// Vitest provides vi.stubEnv
it("respects environment variable", () => {
  vi.stubEnv("SOME_VAR", "test-value");
  expect(process.env.SOME_VAR).toBe("test-value");

  // Automatically restored after test (unstubEnvs: true)
});
```

**Fake Timers:**
```typescript
afterEach(() => {
  // Guard against leaked fake timers across test files
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
});

it("handles timeout", async () => {
  vi.useFakeTimers();
  const promise = functionWithTimeout();
  vi.advanceTimersByTime(5000);
  const result = await promise;
  expect(result).toBe(expected);
  vi.useRealTimers();
});
```

**Callback/Event Testing:**
```typescript
it("calls callback when event fires", async () => {
  const onQr = vi.fn();

  await startWebLoginWithQr({
    onQr,
    timeoutMs: 5000,
  });

  // Test triggered callback
  expect(onQr).toHaveBeenCalledWith("qr-data");
});
```

## Test Performance

**Configuration Notes:**
- `pool: "forks"` for unit tests (better for CPU-bound tests)
- `pool: "vmForks"` for e2e tests (better isolation, prevents env leaks)
- `maxWorkers: 3-16` depending on CPU count and CI vs local
- `testTimeout: 120_000ms` (2 minutes default)
- `hookTimeout: 120-180_000ms` (handles slow setup/teardown)

**Optimization:**
- `unstubEnvs: true`, `unstubGlobals: true` to prevent cross-test pollution
- `vi.clearAllMocks()` in `beforeEach` to reset state
- Shared registry (`DEFAULT_PLUGIN_REGISTRY`) created once, reused
- Environmental isolation: `withIsolatedTestHome()` for filesystem tests

---

*Testing analysis: 2026-02-15*
