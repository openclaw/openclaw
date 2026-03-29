# Testing Patterns

**Analysis Date:** 2026-03-28

## Test Framework

**Runner:**

- Vitest (version from `package.json`)
- Config: `vitest.config.ts` (base), `vitest.unit.config.ts` (unit), `vitest.e2e.config.ts` (e2e), `vitest.gateway.config.ts`, `vitest.channels.config.ts`, `vitest.live.config.ts`, `vitest.extensions.config.ts`
- Pool: `forks` (process isolation)
- Timeout: 120,000ms default; 180,000ms on Windows
- Workers: CI=3 (2 on Windows), local=resolved via `scripts/test-planner/runtime-profile.mjs`
- `unstubEnvs: true` and `unstubGlobals: true` — environment/global stubs are automatically restored after each test

**Assertion Library:**

- Vitest built-in `expect`

**Run Commands:**

```bash
pnpm test                        # Run all tests (parallel planner)
pnpm test:watch                  # Watch mode (vitest)
pnpm test:coverage               # Coverage with v8 provider (unit config)
pnpm test:fast                   # Fast unit run (vitest.unit.config.ts, no planner)
pnpm test:e2e                    # E2E tests only
pnpm test:gateway                # Gateway tests only
pnpm test:channels               # Channel surface tests only
pnpm test:extensions             # Extension tests only
pnpm test:live                   # Live tests (real API keys required)
pnpm test -- <filter> [args]     # Targeted run (use this, not raw vitest)
```

**Running a targeted test:**

```bash
pnpm test -- src/pairing/pairing-store.test.ts
pnpm test -- src/polls.test.ts -t "clamps poll duration"
```

## Test File Organization

**Location:**

- Unit tests: co-located with source file as `<source-name>.test.ts`
  - `src/utils.ts` → `src/utils.test.ts`
  - `src/pairing/pairing-store.ts` → `src/pairing/pairing-store.test.ts`
- E2E tests: co-located, named `<name>.e2e.test.ts`
  - `src/agents/subagent-announce.format.e2e.test.ts`
  - `src/plugins/wired-hooks-after-tool-call.e2e.test.ts`
- Live tests (real API keys): `<name>.live.test.ts`
  - `src/agents/anthropic.setup-token.live.test.ts`
  - `src/image-generation/runtime.live.test.ts`
- Cross-cutting/integration tests: `test/` directory
  - `test/architecture-smells.test.ts`
  - `test/extension-plugin-sdk-boundary.test.ts`
  - `test/gateway.multi.e2e.test.ts`

**Naming:**

- Test files match source filename: `<module>.test.ts`
- Specialization via dot prefix: `pairing-store.test.ts`, `pairing-messages.test.ts`
- E2E suffix: `*.e2e.test.ts`
- Live suffix: `*.live.test.ts`
- Integration E2E: `*.integration.e2e.test.ts`

**Structure:**

```
src/
├── pairing/
│   ├── pairing-store.ts
│   ├── pairing-store.test.ts       ← co-located unit test
│   ├── pairing-messages.ts
│   └── pairing-messages.test.ts    ← separate concern test file
├── infra/
│   ├── device-bootstrap.ts
│   ├── device-bootstrap.test.ts
│   ├── archive.ts
│   └── archive-helpers.test.ts
test/
├── setup.ts                        ← global setup
├── test-env.ts                     ← HOME/state isolation helper
└── architecture-smells.test.ts     ← cross-repo structural tests
```

## Test Structure

**Suite Organization:**

```typescript
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Top-level describe with module name
describe("device bootstrap tokens", () => {
  // Setup helpers defined inside describe
  const tempDirs = createTrackedTempDirs();
  const createTempDir = () => tempDirs.make("openclaw-device-bootstrap-test-");

  afterEach(async () => {
    vi.useRealTimers();
    await tempDirs.cleanup();
  });

  it("issues bootstrap tokens and persists them with an expiry", async () => {
    // Arrange: vi.useFakeTimers / vi.setSystemTime for time-sensitive tests
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T12:00:00Z"));

    const baseDir = await createTempDir();

    // Act
    const issued = await issueDeviceBootstrapToken({ baseDir });

    // Assert
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(issued.expiresAtMs).toBe(Date.now() + DEVICE_BOOTSTRAP_TOKEN_TTL_MS);
  });
});
```

**Patterns:**

- `beforeAll`/`afterAll` for shared expensive setup (e.g., temp directories, fixture roots)
- `beforeEach`/`afterEach` for per-test state resets (caches, timers, mocks)
- `vi.useFakeTimers()` + `vi.setSystemTime()` for time-sensitive tests; always `vi.useRealTimers()` in `afterEach`
- Helper functions defined at describe-scope to reduce repetition: `withTempDir`, `expectResolvedSetupOk`, `expectResolvedRoute`
- `it.each([...])` for table-driven/parameterized tests (widely used)

## Mocking

**Framework:** Vitest (`vi`)

**Module-level mock (static, hoisted):**

```typescript
vi.mock("../infra/device-bootstrap.js", () => ({
  issueDeviceBootstrapToken: vi.fn(async () => ({
    token: "bootstrap-123",
    expiresAtMs: 123,
  })),
}));

// Access mock for assertions
const issueDeviceBootstrapTokenMock = vi.mocked(
  (await import("../infra/device-bootstrap.js")).issueDeviceBootstrapToken,
);
```

**Partial module mock (keep real + override):**

```typescript
import { mergeMockedModule } from "../test-utils/vitest-module-mocks.js";

vi.mock("../config/sessions.js", async (importOriginal) => {
  return mergeMockedModule(await importOriginal(), (actual) => ({
    loadSessionStore: vi.fn(),
  }));
});
```

Helper: `src/test-utils/vitest-module-mocks.ts`

**Spy on imported module function:**

```typescript
const loadSessionStoreSpy = vi.spyOn(configSessions, "loadSessionStore");
const callGatewaySpy = vi.spyOn(gatewayCall, "callGateway");

// Set implementation
callGatewaySpy.mockImplementation(async (_req) => ({ runId: "run-main", status: "ok" }));
```

**Environment variable stubbing:**

```typescript
vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
// Automatically restored after each test (unstubEnvs: true in vitest.config.ts)
```

**Fake timers:**

```typescript
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process, "kill").mockImplementation(() => true);
});

afterEach(async () => {
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Advance time
vi.advanceTimersByTime(1000);
await vi.advanceTimersByTimeAsync(0);
await vi.runAllTimersAsync();
```

**What to Mock:**

- External process calls (`callGateway`, `process.kill`, `process.emit`)
- Filesystem operations when testing logic above I/O layer
- Module functions that make network calls or spawn processes
- Time (via fake timers) for TTL/expiry logic

**What NOT to Mock:**

- The module under test itself
- Pure utility functions with no side effects
- `node:` built-ins when testing actual I/O behavior (use real temp dirs instead)

## Fixtures and Factories

**Temp Directory Factories:**

```typescript
// Simple one-off temp dir
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-"));

// Tracked temp dirs (preferred for tests with multiple dirs — auto-cleanup)
const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-device-bootstrap-test-");
afterEach(async () => {
  await tempDirs.cleanup();
});
```

Helpers: `src/test-utils/tracked-temp-dirs.ts`, `src/test-utils/temp-home.ts`, `src/test-utils/fixture-suite.ts`

**Environment Isolation:**

```typescript
import { withEnvAsync, withEnv, captureEnv } from "../test-utils/env.js";

await withEnvAsync({ OPENCLAW_STATE_DIR: dir }, async () => {
  // Test runs with isolated env
});
```

Helper: `src/test-utils/env.ts`

**Channel Plugin Stubs (for routing/session tests):**

```typescript
import { createTestRegistry, createChannelTestPluginBase } from "../test-utils/channel-plugins.js";

const registry = createTestRegistry([
  { pluginId: "discord", plugin: createStubPlugin({ id: "discord" }), source: "test" },
]);
```

Helpers: `src/test-utils/channel-plugins.ts`, `src/test-utils/channel-plugin-test-fixtures.ts`

**Global test registry (from `test/setup.ts`):**

- All tests automatically get a default plugin registry with stubs for: `discord`, `slack`, `telegram`, `whatsapp`, `signal`, `imessage`
- Registry is reset after each test via `afterEach`
- Override the registry in specific tests by calling `setActivePluginRegistry(customRegistry)`

**Assertion helpers:**

```typescript
import { withEnvAsync } from "../test-utils/env.js";

// Custom assertion helpers defined per-test-file
function expectResolvedSetupOk(resolved: ResolvedSetup, params: { authLabel: string; ... }) {
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error("expected setup resolution to succeed");
  expect(resolved.authLabel).toBe(params.authLabel);
}
```

**Location:**

- Test-specific helpers: defined at describe-scope within the test file
- Shared test utilities: `src/test-utils/` directory
- Test fixtures/data: `test/fixtures/`, `test-fixtures/`
- Secret test vectors: `src/test-utils/secret-ref-test-vectors.ts`

## Coverage

**Requirements:** V8 provider with enforced thresholds on `src/**/*.ts`:

- Lines: 70%
- Functions: 70%
- Statements: 70%
- Branches: 55%

**View Coverage:**

```bash
pnpm test:coverage
# Coverage report lands in coverage/ directory (lcov + text)
```

**Coverage scope:** Only files actually exercised by the test suite (`all: false`). Large integration surfaces (agents, channels, gateway, plugins, acp) are excluded from coverage thresholds and validated via e2e/manual/contract tests instead.

## Test Types

**Unit Tests (`*.test.ts`):**

- Scope: single module or function, fully isolated
- Use temp dirs, fake timers, `vi.mock`, `vi.spyOn`
- ~2055 test files under `src/`
- Run with: `pnpm test:fast` or `pnpm test`

**E2E Tests (`*.e2e.test.ts`):**

- Scope: end-to-end flows; spawn subprocesses or run full agent cycles
- May require gateway running
- Run with: `pnpm test:e2e`
- Separate config: `vitest.e2e.config.ts`

**Live Tests (`*.live.test.ts`):**

- Scope: real API integrations (OpenAI, Anthropic, etc.)
- Require real API keys: `CLAWDBOT_LIVE_TEST=1 pnpm test:live`
- Excluded from normal test runs
- Docker variants: `pnpm test:docker:live-models`

**Contract Tests (`src/channels/plugins/contracts/`, `src/plugins/contracts/`):**

- Validate channel plugin interface contracts
- Run serially: `pnpm test:contracts`
- Config: `vitest.contracts.config.ts`

**Gateway Tests:**

- Auth compat, reconnect, protocol: `pnpm test:gateway`
- Config: `vitest.gateway.config.ts`

**Docker E2E:**

- Install smoke, onboarding, OpenWebUI, QR import: `pnpm test:docker:all`
- Scripts in `scripts/e2e/`

## Common Patterns

**Async Testing:**

```typescript
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
it("enforces max option count when configured", () => {
  expect(() =>
    normalizePollInput({ question: "Q", options: ["A", "B", "C"] }, { maxOptions: 2 }),
  ).toThrow(/at most 2/);
});
```

**Parameterized (table-driven) Tests:**

```typescript
it.each([
  { durationHours: undefined, expected: 24 },
  { durationHours: 999, expected: 48 },
  { durationHours: 1, expected: 1 },
])("clamps poll duration for $durationHours hours", ({ durationHours, expected }) => {
  expect(normalizePollDurationHours(durationHours, { defaultHours: 24, maxHours: 48 })).toBe(
    expected,
  );
});
```

**Discriminated Result Assertion:**

```typescript
const result = await someOperation();
expect(result.ok).toBe(true);
if (!result.ok) {
  throw new Error("expected ok result");
}
// TypeScript now narrows to ok: true branch
expect(result.payload.bootstrapToken).toBe("bootstrap-123");
```

**Testing Internal State (via `__testing` export):**

```typescript
import { __testing, scheduleGatewaySigusr1Restart } from "./restart.js";

beforeEach(() => {
  __testing.resetSigusr1State();
});
afterEach(async () => {
  __testing.resetSigusr1State();
});
```

**Low-memory / Serial Mode:**

```bash
OPENCLAW_TEST_PROFILE=low OPENCLAW_TEST_SERIAL_GATEWAY=1 pnpm test
```

---

_Testing analysis: 2026-03-28_
