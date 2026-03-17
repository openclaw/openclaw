# Testing Patterns

**Analysis Date:** 2026-03-17

## Test Framework

**Runner:**

- Vitest 4.1.0
- Config: `vitest.config.ts` (base), `vitest.unit.config.ts` (unit tests only), `vitest.gateway.config.ts` (gateway tests), `vitest.e2e.config.ts` (end-to-end), `vitest.live.config.ts` (live tests with real credentials)
- Pool strategy: `pool: "forks"` (default) with separate process pool per test file to prevent cross-file env pollution
- Max workers: 4-16 local, 2-3 in CI (Windows uses 2, others use 3)
- Timeouts: 120 seconds for tests, 120-180 seconds for hooks (higher on Windows)
- Hook cleanup: `unstubEnvs: true` and `unstubGlobals: true` to ensure per-test isolation under vmForks

**Assertion Library:**

- Vitest's native assertions: `expect(value).toBe()`, `expect(fn).toHaveBeenCalled()`, etc.
- No separate assertion library; vitest provides full assertion API
- Custom matchers can be added via vitest's `expect.extend()`

**Run Commands:**

```bash
pnpm test                    # Run all default tests (vitest.config.ts)
pnpm test:coverage          # Run with V8 coverage reporter
pnpm test:fast              # Unit tests only (vitest.unit.config.ts)
pnpm test:watch             # Watch mode with rerun on file change
pnpm test:gateway           # Gateway-specific tests (vitest.gateway.config.ts)
pnpm test:e2e               # End-to-end tests (vitest.e2e.config.ts)
pnpm test:live              # Live tests requiring real credentials (OPENCLAW_LIVE_TEST=1)
pnpm test -- <path> -t "pattern"  # Run specific test file or pattern
OPENCLAW_TEST_PROFILE=low pnpm test  # Low-profile mode for resource-constrained envs
OPENCLAW_TEST_SERIAL_GATEWAY=1 pnpm test  # Serial test execution (for memory pressure)
```

## Test File Organization

**Location:**

- **Co-located:** Unit tests live alongside source code: `src/pairing/pairing-challenge.ts` pairs with `src/pairing/pairing-challenge.test.ts`
- **Extensions:** `extensions/**/src/**/*.test.ts` follow same co-located pattern
- **E2E tests:** Located in `test/` directory for full-system flows
- **Live tests:** Use `*.live.test.ts` suffix for tests requiring real external services/credentials

**Naming:**

- Unit test files: `*.test.ts`
- E2E test files: `*.e2e.test.ts`
- Live/integration tests: `*.live.test.ts`
- Setup and utilities: `test/setup.ts`, `test/test-env.ts`, `test/helpers/`

**Structure:**

```
src/
├── pairing/
│   ├── pairing-challenge.ts          # Source implementation
│   ├── pairing-challenge.test.ts     # Co-located unit test
│   ├── pairing-store.ts
│   └── pairing-store.test.ts

test/
├── setup.ts                          # Global test setup (mock providers, plugin registry)
├── test-env.ts                       # Environment isolation utilities
├── helpers/                          # Shared test helpers
└── fixtures/                         # Fixture data
```

## Test Structure

**Suite Organization:**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { someFunction } from "./some-module.js";

describe("someFunction", () => {
  // Setup/teardown per-test
  let resource: SomeResource;

  beforeEach(() => {
    resource = createResource();
  });

  afterEach(() => {
    resource.cleanup?.();
  });

  // Grouped by behavior
  describe("when condition X", () => {
    it("returns Y", () => {
      expect(someFunction(input)).toBe(expected);
    });

    it("calls callback Z", async () => {
      const callback = vi.fn();
      await someFunction(input, callback);
      expect(callback).toHaveBeenCalledWith(expectedArg);
    });
  });

  describe("error cases", () => {
    it("throws on invalid input", () => {
      expect(() => someFunction(badInput)).toThrow("error message");
    });
  });
});
```

**Patterns:**

- Use `describe()` to group related tests; nest for sub-contexts
- Use `it()` for individual test cases (descriptive second parameter)
- Use `beforeEach()` / `afterEach()` for per-test setup and cleanup
- Use `beforeAll()` / `afterAll()` only for expensive one-time setup (test registration, etc.)
- Keep test names descriptive: "returns pairing code when request is newly created" not just "test 1"

**Example from codebase:**

```typescript
describe("issuePairingChallenge", () => {
  it("creates and sends a pairing reply when request is newly created", async () => {
    const sent: string[] = [];

    const result = await issuePairingChallenge({
      channel: "telegram",
      senderId: "123",
      senderIdLine: "Your Telegram user id: 123",
      upsertPairingRequest: async () => ({ code: "ABCD", created: true }),
      sendPairingReply: async (text) => {
        sent.push(text);
      },
    });

    expect(result).toEqual({ created: true, code: "ABCD" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("ABCD");
  });

  it("does not send a reply when request already exists", async () => {
    const sendPairingReply = vi.fn(async () => {});

    const result = await issuePairingChallenge({
      channel: "telegram",
      senderId: "123",
      senderIdLine: "Your Telegram user id: 123",
      upsertPairingRequest: async () => ({ code: "ABCD", created: false }),
      sendPairingReply,
    });

    expect(result).toEqual({ created: false });
    expect(sendPairingReply).not.toHaveBeenCalled();
  });
});
```

## Mocking

**Framework:** Vitest's built-in mocking API

**Patterns:**

Global mocks (in `test/setup.ts`):

```typescript
vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...original,
    getOAuthApiKey: () => undefined,
    getOAuthProviders: () => [],
    loginOpenAICodex: vi.fn(),
  };
});
```

Function mocks (in test files):

```typescript
const sendPairingReply = vi.fn(async () => {});
const onCreated = vi.fn();

// Use mocks as arguments
await issuePairingChallenge({
  // ...
  sendPairingReply,
  onCreated,
});

// Verify calls
expect(sendPairingReply).toHaveBeenCalledWith("reply text");
expect(onCreated).toHaveBeenCalledTimes(1);
expect(onCreated).not.toHaveBeenCalled();
```

Module mocks (inline in test):

```typescript
vi.mock("../infra/device-bootstrap.js", () => ({
  issueDeviceBootstrapToken: vi.fn(async () => ({
    token: "test-token",
  })),
}));
```

Spy on existing functions:

```typescript
const spy = vi.spyOn(fs, "readFile");
spy.mockImplementation(async (path, opts) => {
  if (path === expectedPath) {
    return "mocked content";
  }
  return original(path, opts);
});
expect(spy).toHaveBeenCalledWith(expectedPath, expect.any(Object));
spy.mockRestore();
```

Environment stubbing (per-test isolation):

```typescript
beforeEach(() => {
  vi.stubEnv("OPENCLAW_PROFILE", "isolated");
});

afterEach(() => {
  vi.unstubAllEnvs();
});
```

**What to Mock:**

- External service calls (HTTP, file system, crypto random operations)
- Time-based operations: `vi.useFakeTimers()` for testing delays/intervals
- Module-level side effects or expensive operations
- Dependencies injected as parameters (preferred over mocking modules)

**What NOT to Mock:**

- Pure functions being tested (test them directly)
- Core utilities like path, JSON operations
- The system under test (test real implementation)
- Helper libraries unless they have external dependencies
- Standard library methods unless testing edge cases

## Fixtures and Factories

**Test Data:**

```typescript
// Factory functions for test objects
export function createStubPlugin(params: {
  id: ChannelId;
  label?: string;
  aliases?: string[];
  deliveryMode?: ChannelOutboundAdapter["deliveryMode"];
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

// Usage in tests
const testPlugin = createStubPlugin({ id: "discord", label: "Discord" });
```

**Location:**

- Test utilities in `src/test-utils/`: `channel-plugins.js`, `env.js`, `temp-dir.js`, etc.
- Shared test helpers in `test/helpers/`
- Fixture data in `test/fixtures/`

**Common Helpers:**

- `captureEnv()`: Save/restore environment variables for test isolation
- `withEnvAsync()`: Run test code with specific env vars set, auto-restore
- `withTempDir()`: Create temp directory, run test code, auto-cleanup
- `createTestRegistry()`: Create plugin registry with stub plugins
- `createTrackedTempDirs()`: Manage multiple temp directories with cleanup

## Coverage

**Requirements:** V8 coverage with thresholds enforced

**Thresholds:**

- Lines: 70%
- Functions: 70%
- Branches: 55%
- Statements: 70%

**Exclusions:**

- CLI entry points and wiring (`src/cli/`, `src/commands/`)
- Large integration surfaces (gateway, channels, agents) validated via e2e/manual tests
- Generated code and templates
- Type definition files

**View Coverage:**

```bash
pnpm test:coverage              # Generate coverage report
open coverage/index.html        # View HTML report (macOS)
```

**Coverage is enforced by:**

- Vitest config `coverage.thresholds` in `vitest.config.ts`
- CI gates the coverage report; tests fail if thresholds not met
- `all: false` means only files exercised by tests are counted (not whole src/)

## Test Types

**Unit Tests:**

- **Scope:** Single function or small module
- **Approach:** Test inputs and outputs in isolation; mock external dependencies
- **Location:** `src/**/*.test.ts`
- **Example:** `src/pairing/pairing-challenge.test.ts` tests `issuePairingChallenge()` in isolation with mock callbacks
- **Run:** `pnpm test:fast` or `pnpm test` with `vitest.unit.config.ts`

**Integration Tests:**

- **Scope:** Multiple modules working together; may use real file system or in-memory state
- **Approach:** Test workflows that span multiple layers (config, infra, channels)
- **Location:** `src/**/*.test.ts` with setup from `test/setup.ts` (e.g., plugin registry)
- **Example:** Tests in `src/infra/` that interact with real temp directories and store operations
- **Run:** `pnpm test` or `pnpm test:contracts`

**Contract Tests:**

- **Scope:** Verify plugin/provider API contracts
- **Approach:** Validate that implementations conform to expected interfaces
- **Location:** `src/channels/plugins/contracts/`, `src/plugins/contracts/`
- **Run:** `pnpm test:contracts:channels` and `pnpm test:contracts:plugins`

**End-to-End Tests:**

- **Scope:** Full system flows (CLI, gateway, multi-process)
- **Approach:** Start gateway, CLI, or services; run commands; verify output
- **Location:** `test/**/*.e2e.test.ts`
- **Example:** `test/gateway.multi.e2e.test.ts`
- **Run:** `pnpm test:e2e`

**Live Tests:**

- **Scope:** Real external service integration (Discord, Telegram, OpenAI API)
- **Approach:** Use real credentials (from env vars) to test against live services
- **Location:** `src/**/*.live.test.ts` or `test/**/*.live.test.ts`
- **Example:** Android node capability tests, model fetch tests
- **Run:** `OPENCLAW_LIVE_TEST=1 pnpm test:live` or `CLAWDBOT_LIVE_TEST=1 pnpm test:live`
- **Skipped by default** unless `OPENCLAW_LIVE_TEST=1` or `CLAWDBOT_LIVE_TEST=1` is set

## Common Patterns

**Async Testing:**

```typescript
// vitest handles async naturally
it("fetches data asynchronously", async () => {
  const result = await someAsyncFunction();
  expect(result).toEqual(expected);
});

// Or with promises and vi.advanceTimersByTime
it("resolves after delay using fake timers", async () => {
  vi.useFakeTimers();
  const promise = sleep(1000);
  vi.advanceTimersByTime(1000);
  await expect(promise).resolves.toBeUndefined();
  vi.useRealTimers();
});
```

**Error Testing:**

```typescript
it("throws on invalid input", () => {
  expect(() => functionThatThrows()).toThrow("error message");
});

it("rejects on async error", async () => {
  await expect(asyncFunctionThatThrows()).rejects.toThrow("error");
});

// Capture error for inspection
it("includes error details", async () => {
  try {
    await functionThatThrows();
  } catch (err) {
    expect((err as Error).message).toContain("expected text");
  }
});
```

**Testing with Real Files:**

```typescript
import { withTempDir } from "../test-utils/temp-dir.js";

it("reads JSON5 object session stores", async () => {
  await withTempDir("openclaw-session-store-", async (dir) => {
    const storePath = path.join(dir, "sessions.json");
    await fs.writeFile(storePath, "{ main: { sessionId: 's1' } }", "utf-8");

    const result = readSessionStoreJson5(storePath);
    expect(result.ok).toBe(true);
    expect(result.store.main?.sessionId).toBe("s1");
    // temp dir auto-cleaned up after test
  });
});
```

**Data-Driven Tests:**

```typescript
const cases = [
  { input: "a", expected: "A" },
  { input: "b", expected: "B" },
];

for (const testCase of cases) {
  it(`converts ${testCase.input}`, () => {
    expect(convert(testCase.input)).toBe(testCase.expected);
  });
}
```

## Global Setup

**File:** `test/setup.ts`

**What happens:**

1. Mock `@mariozechner/pi-ai` (OAuth providers)
2. Set `VITEST=true` and plugin cache timeout (`OPENCLAW_PLUGIN_MANIFEST_CACHE_MS=60000`)
3. Increase process listener limit to 128 (Vitest vm forks create many listeners)
4. Create isolated test home directory (cleans up after all tests)
5. Install process warning filter
6. Create default plugin registry with stub Discord, Slack, Telegram, WhatsApp, Signal, iMessage
7. Before each test: set active plugin registry to default
8. After each test: restore plugin registry if modified, reset fake timers if active

**Test Environment Isolation:**

- HOME directory is isolated per test run (via `withIsolatedTestHome()`)
- Environment variables are stubbed per-test via `vi.stubEnv()` and `unstubEnvs: true`
- Fake timers are reset after each test to prevent leakage

## Debugging Tests

**Run specific test:**

```bash
pnpm test -- src/pairing/pairing-challenge.test.ts
pnpm test -- src/pairing/pairing-challenge.test.ts -t "creates and sends"
```

**Watch mode:**

```bash
pnpm test:watch
# Or with filter
pnpm test -- src/pairing --watch
```

**Enable verbose logging:**

```bash
DEBUG=* pnpm test -- src/pairing/pairing-challenge.test.ts
```

**Inspect failures:**

- Check test output for assertion diffs
- Use `expect(actual).toEqual(expected)` for detailed object diffs
- For async issues, check test timeout (120s default; override with `it(..., fn, timeout)`)

---

_Testing analysis: 2026-03-17_
