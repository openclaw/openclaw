# Testing Patterns

**Analysis Date:** 2026-03-26

## Test Framework

**Runner:**

- Vitest (latest)
- Configuration: `vitest.config.ts` (main), plus specialized configs:
  - `vitest.unit.config.ts` – unit test runner
  - `vitest.channels.config.ts` – channel integration tests
  - `vitest.e2e.config.ts` – end-to-end tests
  - `vitest.extensions.config.ts` – plugin/extension tests
  - `vitest.gateway.config.ts` – gateway tests
  - `vitest.live.config.ts` – live integration tests (require real keys)
  - `vitest.performance-config.ts` – performance/timing tests

**Assertion Library:**

- Vitest built-in `expect()` API (compatible with Jest)

**Run Commands:**

```bash
pnpm test                    # Run all unit tests via test-parallel.mjs runner
pnpm test:coverage          # Run with v8 coverage and report to stdout
pnpm test -- <path>         # Run tests matching path/filter
pnpm test -- -t "pattern"   # Run tests matching description
pnpm test:channels          # Run channel integration tests (requires OPENCLAW_TEST_INCLUDE_CHANNELS=1)
pnpm test:e2e               # Run e2e tests
pnpm test:live              # Run live integration tests (requires LIVE=1)
pnpm test:docker:live-models  # Docker-based live model tests
pnpm test:docker:onboard    # Docker-based onboarding e2e
```

## Test File Organization

**Location:**

- Colocated with source: `src/**/*.test.ts`
- Extensions: `extensions/**/*.test.ts`
- Infrastructure: `test/**/*.test.ts`
- UI tests: `ui/src/**/*.test.ts` (listed explicitly in `vitest.config.ts` include)

**Naming:**

- Pattern: `{moduleName}.test.ts` for unit tests
- Pattern: `{moduleName}.e2e.test.ts` for end-to-end tests
- Pattern: `{moduleName}.live.test.ts` for live integration tests (real keys/external services)

**Structure:**

```
src/shared/
├── subagents-format.ts      # Implementation
├── subagents-format.test.ts # Tests
└── requirements.test.ts      # Tests for requirements.ts
```

## Test Structure

**Suite Organization:**

```typescript
import { describe, expect, it, vi } from "vitest";
import { formatTokenShort, resolveTotalTokens } from "./subagents-format.js";

describe("shared/subagents-format", () => {
  it("formats token counts with integer, kilo, and million branches", () => {
    expect(formatTokenShort()).toBeUndefined();
    expect(formatTokenShort(999.9)).toBe("999");
    expect(formatTokenShort(1_500)).toBe("1.5k");
  });

  it("resolves token totals and io breakdowns from valid numeric fields only", () => {
    expect(resolveTotalTokens()).toBeUndefined();
    expect(resolveTotalTokens({ totalTokens: 42 })).toBe(42);
    expect(resolveTotalTokens({ inputTokens: Number.NaN, outputTokens: 5 })).toBeUndefined();
  });
});
```

**Patterns:**

- Top-level `describe()` with module path as name: `describe("shared/subagents-format", () => { ... })`
- Each `it()` block tests a single behavior or edge case
- No `beforeEach()`/`afterEach()` unless needed (vitest auto-restores stubbed env/globals)
- Test names are descriptive and user-focused: "formats token counts with..." not "test token format"

## Mocking

**Framework:** Vitest `vi` module

**Patterns:**

```typescript
// Module mocking (in test setup or test file)
vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...original,
    getOAuthApiKey: () => undefined,
    getOAuthProviders: () => [],
    loginOpenAICodex: vi.fn(),
  };
});

// Spying on methods
const readFileSyncSpy = vi.spyOn(fsSync, "readFileSync").mockImplementation(() => {
  throw new Error("no proc status");
});
const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

// Verifying calls
expect(readFileSyncSpy).toHaveBeenCalledWith("/proc/42/status", "utf8");
expect(killSpy).toHaveBeenCalledWith(42, 0);

// Environment variable stubbing
vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
// Auto-restored after test (via unstubEnvs: true in vitest.config.ts)

// Global stubbing
vi.stubGlobals("process", { pid: 12345 });
// Auto-restored after test (via unstubGlobals: true)
```

**What to Mock:**

- External modules (npm packages) when testing in isolation
- Native APIs when behavior is hard to trigger (e.g., `fs.readFileSync` for `/proc` reads on Linux)
- `process.platform`, `process.env` when testing platform-specific logic
- Module methods that involve side effects (file I/O, network, system calls)

**What NOT to Mock:**

- Core logic within the same module
- Pure functions (just call them)
- Error conditions that can be triggered naturally (e.g., JSON parse errors via bad input)
- User-facing behavior that should be tested end-to-end

## Fixtures and Factories

**Test Data:**

```typescript
// Factory patterns in test/setup.ts
const createStubPlugin = (params: {
  id: ChannelId;
  label?: string;
  aliases?: string[];
  deliveryMode?: ChannelOutboundAdapter["deliveryMode"];
}): ChannelPlugin => ({
  id: params.id,
  meta: { id: params.id, label: params.label ?? String(params.id), ... },
  capabilities: { chatTypes: ["direct", "group"] },
  config: { ... },
  outbound: createStubOutbound(params.id, params.deliveryMode),
});

// Mock data setup via direct object literals in test
const entries: Record<string, string> = {
  [`/proc/${process.pid}/stat`]: `${process.pid} (node) S 1 ...`,
  "/proc/42/stat": "...",
};
mockProcReads(entries);
```

**Location:**

- Global fixtures in `test/setup.ts` (used by all tests via `setupFiles` in config)
- Test-specific factories defined inline or in utility modules like `src/test-utils/channel-plugins.ts`
- Helper functions with test\_ suffix for test-only utilities: `createDefaultRegistry()`, `cleanupSessionStateForTest()`

## Coverage

**Requirements:**

- Thresholds enforced: lines 70%, branches 55%, functions 70%, statements 70% (V8 provider)
- Only applied to `./src/**/*.ts` (not extensions, apps, or tests themselves)
- Coverage excludes integration surfaces and manually-tested code:
  - CLI wiring (`src/cli/**`, `src/commands/**`)
  - Large integrations (`src/channels/**`, `src/gateway/**`, `src/agents/**`)
  - E2E/manual surfaces (`src/tui/**`, `src/wizard/**`, `src/browser/**`)

**View Coverage:**

```bash
pnpm test:coverage     # Generates lcov report in console; also writes dist/coverage/
# Open dist/coverage/index.html in browser for detailed per-file coverage
```

## Test Types

**Unit Tests:**

- Scope: Single function or module in isolation
- Approach: Pure input/output testing (e.g., `formatTokenShort(1500) === "1.5k"`)
- Mocking: External modules and platform APIs only
- Example: `src/shared/subagents-format.test.ts` tests formatting logic without network/file I/O
- Location: Colocated `*.test.ts` files

**Integration Tests:**

- Scope: Multiple modules working together (channels, providers, config parsing)
- Approach: Real filesystem, config parsing, partial channel stubs
- Mocking: Network/external services; local data/config real
- Run: `pnpm test:channels` (with `OPENCLAW_TEST_INCLUDE_CHANNELS=1`)
- Example: tests verify gateway/channel routing logic with stub plugins

**E2E Tests:**

- Scope: Full workflows (setup, messaging, reply cycles)
- Approach: Real gateway process, real channel plugins, live config
- Mocking: External LLM services (stubbed), external messaging APIs (stubbed)
- Run: `pnpm test:e2e`
- Configuration: `vitest.e2e.config.ts`

**Live Integration Tests:**

- Scope: External service integration (OpenAI, Anthropic, Discord, Slack, etc.)
- Approach: Real API keys from environment, real external calls
- Run: `LIVE=1 pnpm test:live` (or `OPENCLAW_LIVE_TEST=1` for OpenClaw-only tests)
- Configuration: `vitest.live.config.ts`
- Environment: Excluded from CI by default; manual/local only

## Common Patterns

**Async Testing:**

```typescript
// Async test with natural await
it("returns true for the current running process", async () => {
  const result = await withLinuxProcessPlatform(async () => {
    return isPidAlive(process.pid);
  });
  expect(result).toBe(true);
});

// Helper that manages platform restoration
async function withProcessPlatform<T>(
  platform: NodeJS.Platform,
  run: () => Promise<T>,
): Promise<T> {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...originalPlatformDescriptor, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
    vi.restoreAllMocks();
  }
}
```

**Error Testing:**

```typescript
// Expect thrown error
it("throws clear unknown and ambiguous node errors", () => {
  expect(() => getNode("unknown")).toThrow("unknown node: unknown");
  expect(() => getNode("abc")).toThrow(/known:.+/);
});

// Test error handling path
it("returns null for invalid PIDs", () => {
  expect(getProcessStartTime(0)).toBeNull();
  expect(getProcessStartTime(Number.NaN)).toBeNull();
});
```

**Environment/Global Restoration:**

- Vitest automatically restores stubbed env and globals after each test (`unstubEnvs: true`, `unstubGlobals: true`)
- Manual restoration required only for prototype mutation or custom global state
- Example from `test/setup.ts`: `afterEach()` hook resets plugin registry and cache state
- Cleanup function calls: `resetContextWindowCacheForTest()`, `cleanupSessionStateForTest()`

**Test Isolation:**

- `pool: "forks"` (not threads) — each test runs in its own process fork for full isolation
- Max workers: `localWorkers` (4–16) / CI: 2–3 workers (to avoid resource exhaustion)
- `forceRerunTriggers` configuration files that invalidate cached test runs
- Test helpers cleanup: ensure file handles, timers, listeners, module state cleaned up

## Performance & Memory Tests

**Experimental Config:**

- `vitest.performance-config.ts` loads optional memory hotspot and timing baselines
- Run via: scoped test execution or specialized performance suites
- Tracks call counts and memory usage to catch regressions in hot paths

## Running Tests Locally vs CI

**Local Development:**

- `pnpm test` – defaults to sensible worker count based on CPU count
- For resource-constrained hosts: `OPENCLAW_TEST_PROFILE=low OPENCLAW_TEST_SERIAL_GATEWAY=1 pnpm test`
- Watch mode: not typically used (use `--changed` instead)

**CI Pipeline:**

- Runs on GitHub Actions
- `pnpm check` includes linting, type checking, and base unit tests as gate
- `pnpm test` full suite before merge to `main`
- Reduced worker count on Windows (2 workers) vs Linux/macOS (3)

---

_Testing analysis: 2026-03-26_
