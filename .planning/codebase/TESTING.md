# Testing Patterns

**Analysis Date:** 2026-03-08

## Test Framework

**Runner:**
- Vitest (latest, workspace dependency)
- Config: `vitest.config.ts` (base), plus specialized configs for different test scopes

**Assertion Library:**
- Vitest built-in `expect` (Chai-compatible)

**Run Commands:**
```bash
pnpm test                    # Run all tests (parallel orchestrator via scripts/test-parallel.mjs)
pnpm test:fast               # Unit tests only (vitest.unit.config.ts)
pnpm test:watch              # Watch mode
pnpm test:coverage           # Unit tests with V8 coverage
pnpm test:e2e                # E2E tests (vitest.e2e.config.ts)
pnpm test:live               # Live tests with real API keys (OPENCLAW_LIVE_TEST=1)
pnpm test:channels           # Channel-specific tests (vitest.channels.config.ts)
pnpm test:gateway            # Gateway tests (vitest.gateway.config.ts)
pnpm test:extensions         # Extension tests (vitest.extensions.config.ts)
pnpm test:ui                 # UI tests (runs in ui/ workspace)
pnpm test:docker:all         # All Docker-based integration tests
pnpm test:install:smoke      # Install script smoke test in Docker
```

**Low-memory mode:**
```bash
OPENCLAW_TEST_PROFILE=low OPENCLAW_TEST_SERIAL_GATEWAY=1 pnpm test
```

## Test File Organization

**Location:**
- Co-located with source files (same directory)

**Naming:**
- Unit tests: `<source-name>.test.ts` (e.g., `logger.test.ts` next to `logger.ts`)
- Granular topic tests: `<source-name>.<topic>.test.ts` (e.g., `auth-profiles.resolve-auth-profile-order.test.ts`)
- E2E tests: `*.e2e.test.ts`
- Live tests (require real API keys): `*.live.test.ts`
- Guardrail tests (architecture enforcement): `*.guardrail.test.ts`

**Structure:**
```
src/
  agents/
    compaction.ts
    compaction.test.ts                    # Unit test
    compaction.retry.test.ts              # Granular topic test
    anthropic.setup-token.live.test.ts    # Live test
    acp-binding-architecture.guardrail.test.ts  # Guardrail test
  infra/
    archive.ts
    archive.test.ts
  test-utils/                            # Shared test helpers
    channel-plugins.ts
    fetch-mock.ts
    fixture-suite.ts
    frozen-time.ts
    env.ts
    temp-home.ts
    typed-cases.ts
test/
  setup.ts                               # Global test setup
  test-env.ts                            # HOME/env isolation
  fixtures/                              # JSON contract fixtures
    exec-allowlist-shell-parser-parity.json
    system-run-command-contract.json
```

## Vitest Configuration

**Base config** (`vitest.config.ts`):
- Pool: `forks` (process isolation)
- Workers: 4-16 locally (based on CPU count), 2-3 in CI
- Test timeout: 120s, hook timeout: 120s (180s on Windows)
- `unstubEnvs: true` and `unstubGlobals: true` (prevent cross-test pollution)
- Setup file: `test/setup.ts`
- Include patterns: `src/**/*.test.ts`, `extensions/**/*.test.ts`, `test/**/*.test.ts`
- Excludes: `dist/`, `apps/macos/`, `node_modules/`, `*.live.test.ts`, `*.e2e.test.ts`

**Plugin-SDK aliases:** All `openclaw/plugin-sdk/*` imports resolve to source `src/plugin-sdk/*.ts` during tests.

**Parallel orchestration** (`scripts/test-parallel.mjs`):
- Some test files are isolated into separate vitest runs for stability
- Filesystem-heavy, process-heavy, or setup-heavy suites run in dedicated batches

## Test Structure

**Suite Organization:**
```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { functionUnderTest } from "./module.js";

describe("functionUnderTest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does expected behavior", () => {
    const result = functionUnderTest("input");
    expect(result).toBe("expected");
  });

  it("handles edge case", () => {
    expect(() => functionUnderTest(null)).toThrow("error message");
  });
});
```

**Use `test` or `it` interchangeably** -- both appear in the codebase. `it` is more common inside `describe` blocks; `test` appears at top level or for standalone assertions.

**Table-driven tests pattern** (very common):
```typescript
test("handles multiple cases", () => {
  const cases = [
    { input: "/tmp/file.zip", expected: "zip" },
    { input: "/tmp/file.tgz", expected: "tar" },
    { input: "/tmp/file.tar.gz", expected: "tar" },
  ];
  for (const testCase of cases) {
    expect(resolveArchiveKind(testCase.input)).toBe(testCase.expected);
  }
});
```

**`satisfies` for type-safe test config:**
```typescript
const cfg = {
  auth: { profiles: { [profileId]: { provider, mode } } },
} satisfies OpenClawConfig;
```

**Patterns:**
- Setup: `beforeAll` / `beforeEach` for shared state initialization
- Teardown: `afterEach` for mock restoration, `afterAll` for temp directory cleanup
- Assertion: Vitest `expect` with `.toBe()`, `.toEqual()`, `.toContain()`, `.toThrow()`, `.toMatch()`

## Global Test Setup

**File:** `test/setup.ts`

**What it does:**
1. Sets `process.env.VITEST = "true"`
2. Raises max process listeners to 128 (avoids warnings under vmForks)
3. Isolates HOME to a temp directory via `withIsolatedTestHome()` from `test/test-env.ts`
4. Deletes real API tokens from env (Telegram, Discord, Slack, GitHub, Copilot)
5. Sets up a default plugin registry with stub channel plugins (Discord, Slack, Telegram, WhatsApp, Signal, iMessage)
6. Restores plugin registry and real timers in `afterEach`

**Environment isolation** (`test/test-env.ts`):
- Creates temp HOME directory for each test worker
- Sets `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` to temp paths
- Cleans up temp dirs in `afterAll`
- Live tests (`LIVE=1` or `OPENCLAW_LIVE_TEST=1`) skip isolation and use real env

## Mocking

**Framework:** Vitest built-in (`vi`)

**Patterns:**

**Function mocks:**
```typescript
const log = vi.fn();
const error = vi.fn();
const runtime: RuntimeEnv = { log, error, exit: vi.fn() };
```

**Spy on existing methods:**
```typescript
const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
// ... test ...
logSpy.mockRestore();
```

**Module-level spies:**
```typescript
import * as routingBindings from "./bindings.js";
// Then spy on specific exports
```

**Env stubbing:**
```typescript
vi.stubEnv("MY_VAR", "test-value");
// Automatically unstubbed after each test (unstubEnvs: true in config)
```

**What to Mock:**
- External runtime dependencies (console, process.env, filesystem for isolation)
- Channel/plugin registries (replaced with test stubs via global setup)
- Network calls and API clients
- Time (`vi.useFakeTimers()` / `vi.setSystemTime()`)

**What NOT to Mock:**
- Pure logic functions -- test them directly
- Type definitions and config structures
- Internal helper functions that are part of the unit under test

**Fake timers safety:**
```typescript
// Global afterEach in test/setup.ts automatically restores real timers
afterEach(() => {
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
});
```

## Test Utilities

**Shared helpers in `src/test-utils/`:**

| Helper | File | Purpose |
|--------|------|---------|
| `createTestRegistry` | `src/test-utils/channel-plugins.ts` | Create stub plugin registries |
| `createChannelTestPluginBase` | `src/test-utils/channel-plugins.ts` | Create stub channel plugin |
| `createFixtureSuite` | `src/test-utils/fixture-suite.ts` | Manage temp dirs for test suites |
| `createTempHomeEnv` | `src/test-utils/temp-home.ts` | Isolated HOME env for tests |
| `captureEnv` / `withEnv` / `withEnvAsync` | `src/test-utils/env.ts` | Snapshot/restore env vars |
| `useFrozenTime` / `useRealTime` | `src/test-utils/frozen-time.ts` | Fake timer helpers |
| `withFetchPreconnect` | `src/test-utils/fetch-mock.ts` | Add preconnect stub to fetch mocks |
| `typedCases` | `src/test-utils/typed-cases.ts` | Type-safe test case arrays |

**Test fixture helpers** (inline in test files):
```typescript
// Factory functions for test data
function makeMessage(id: number, size: number): AgentMessage {
  return { role: "user", content: "x".repeat(size), timestamp: id };
}

// Config builders
function cfgFor(profileId: string, provider: string, mode: string) {
  return { auth: { profiles: { [profileId]: { provider, mode } } } } satisfies OpenClawConfig;
}
```

## Fixtures

**JSON contract fixtures:** `test/fixtures/*.json`
- Used for parity/contract tests that verify runtime behavior matches documented contracts
- Examples: `exec-allowlist-shell-parser-parity.json`, `system-run-command-contract.json`

**Inline test data:** Most test data is constructed inline using factory functions (no large fixture files)

## Coverage

**Requirements:**
- Provider: V8
- Thresholds: 70% lines, 70% functions, 55% branches, 70% statements
- `all: false` -- only counts files exercised by tests

**View Coverage:**
```bash
pnpm test:coverage
```

**Coverage scope:**
- Only `src/**/*.ts` counted (not extensions, apps, UI, tests)
- Extensive exclusion list in `vitest.config.ts` for CLI wiring, channel surfaces, gateway integration, TUI/wizard flows, and other integration-tested code

## Test Types

**Unit Tests** (`*.test.ts`):
- Co-located with source
- Test pure logic, transformations, and isolated modules
- Run via `pnpm test:fast` (vitest.unit.config.ts)

**Guardrail Tests** (`*.guardrail.test.ts`):
- Verify architectural constraints by scanning source code
- Example: `acp-binding-architecture.guardrail.test.ts` reads source files and asserts forbidden API patterns are not used
- Prevent architectural regression

**Integration Tests** (channel/gateway configs):
- Run via `pnpm test:channels`, `pnpm test:gateway`
- Heavier setup, may touch filesystem/network stubs

**E2E Tests** (`*.e2e.test.ts`):
- Run via `pnpm test:e2e` (vitest.e2e.config.ts)
- Process-level forks, 1-2 workers, deterministic isolation
- Located in `test/` and `src/`

**Live Tests** (`*.live.test.ts`):
- Require real API keys (set `LIVE=1` or `OPENCLAW_LIVE_TEST=1`)
- Run via `pnpm test:live` (vitest.live.config.ts), single worker
- Use real HOME/env (no isolation)

**Docker Tests:**
- Shell scripts in `scripts/e2e/` and `scripts/test-*.sh`
- Run via `pnpm test:docker:*` commands
- Test install flows, gateway networking, plugin lifecycle

## Common Patterns

**Async Testing:**
```typescript
it("resolves async values", async () => {
  const result = await resolveApiKeyForProfile({ cfg, store, profileId });
  expect(result).toBeDefined();
});
```

**Error Testing:**
```typescript
it("rejects with expected error", async () => {
  await expect(
    extractArchive({ archivePath, destDir, timeoutMs: 5000, limits: { maxExtractedBytes: 10 } }),
  ).rejects.toThrow("archive extracted size exceeds limit");
});
```

**Temp directory management:**
```typescript
let fixtureRoot = "";
beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));
});
afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});
```

**Environment variable testing:**
```typescript
// Option 1: vi.stubEnv (auto-restored)
vi.stubEnv("MY_VAR", "value");

// Option 2: Manual capture/restore
const snapshot = captureEnv(["HOME", "MY_VAR"]);
try {
  process.env.MY_VAR = "test";
  // ... test ...
} finally {
  snapshot.restore();
}

// Option 3: withEnv helper
const result = withEnv({ MY_VAR: "test" }, () => readConfig());
```

**Plugin registry override in tests:**
```typescript
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";

const customRegistry = createTestRegistry([
  { pluginId: "discord", plugin: myCustomPlugin, source: "test" },
]);
setActivePluginRegistry(customRegistry);
// ... test ...
// Registry auto-restored by global afterEach in test/setup.ts
```

---

*Testing analysis: 2026-03-08*
