# Testing Patterns

**Analysis Date:** 2026-03-08

## Test Framework

**Runner:**
- Vitest 4.0.18 (configured in `package.json` devDependencies)
- Config: `vitest.config.ts` (base), with specialized configs for different test types

**Assertion Library:**
- Vitest's built-in assertions with Expect API
- Import: `import { describe, expect, it } from "vitest"`

**Run Commands:**
```bash
pnpm test              # Run all tests (uses vitest.config.ts)
pnpm test:fast        # Run unit tests only (vitest.unit.config.ts)
pnpm test:watch       # Watch mode - re-run on file changes
pnpm test:coverage    # Generate coverage report (vitest.unit.config.ts)
pnpm test:e2e         # Run E2E tests (vitest.e2e.config.ts)
pnpm test:gateway     # Run gateway tests with forks pool
pnpm test:channels    # Run channel-specific tests
```

**Configuration Files:**
- `vitest.config.ts` - Base configuration with aliases and test settings
- `vitest.unit.config.ts` - Unit tests only (excludes agents, gateway, channels, discord, telegram, web, browser, line, auto-reply, commands)
- `vitest.e2e.config.ts` - End-to-end tests
- `vitest.gateway.config.ts` - Gateway tests with `pool=forks`
- `vitest.channels.config.ts` - Channel-plugin tests
- `vitest.extensions.config.ts` - Extension tests
- `vitest.live.config.ts` - Live integration tests (requires `OPENCLAW_LIVE_TEST=1`)

## Test File Organization

**Location:**
- Co-located with source: `src/agents/agent-paths.ts` → `src/agents/agent-paths.test.ts`
- Same directory as implementation

**Naming:**
- Pattern: `[module].test.ts` for most tests
- Pattern: `[module].[feature].test.ts` for feature-specific tests
  - Example: `pi-embedded-helpers.formatassistanterrortext.test.ts`
  - Example: `agents/payloads.errors.test.ts`
- Pattern: `[module].guardrail.test.ts` for validation/architecture tests
  - Example: `agents/acp-binding-architecture.guardrail.test.ts`
- Pattern: `[module].[type].test.ts` for special test types
  - Example: `docker-setup.e2e.test.ts` (end-to-end)
  - Example: `docker-image-digests.test.ts` (integration)

**Structure by Test Type:**
```
src/
├── agents/
│   ├── agent-scope.ts
│   ├── agent-scope.test.ts          # Unit tests
│   ├── agent-paths.ts
│   └── agent-paths.test.ts          # Unit tests
├── acp/runtime/
│   ├── errors.ts
│   └── errors.test.ts               # Unit tests with error boundary cases
└── [feature]/
    └── [feature].live.test.ts        # Live integration tests (excluded from normal runs)
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, expect, it } from "vitest";
import { functionToTest } from "./module.js";

describe("functionToTest", () => {
  it("should describe expected behavior", () => {
    const result = functionToTest();
    expect(result).toBe(expectedValue);
  });

  it("should handle edge cases", () => {
    expect(() => functionToTest(null)).toThrow();
  });
});
```

**Example from `src/agents/agent-scope.test.ts`:**
```typescript
describe("resolveAgentConfig", () => {
  it("should return undefined when no agents config exists", () => {
    const cfg: OpenClawConfig = {};
    const result = resolveAgentConfig(cfg, "main");
    expect(result).toBeUndefined();
  });

  it("should return undefined when agent id does not exist", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", workspace: "~/openclaw" }],
      },
    };
    const result = resolveAgentConfig(cfg, "nonexistent");
    expect(result).toBeUndefined();
  });

  it("should return basic agent config", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "main",
            name: "Main Agent",
            workspace: "~/openclaw",
            agentDir: "~/.openclaw/agents/main",
            model: "anthropic/claude-opus-4",
          },
        ],
      },
    };
    const result = resolveAgentConfig(cfg, "main");
    expect(result).toEqual({
      name: "Main Agent",
      workspace: "~/openclaw",
      agentDir: "~/.openclaw/agents/main",
      model: "anthropic/claude-opus-4",
      identity: undefined,
      groupChat: undefined,
      subagents: undefined,
      sandbox: undefined,
      tools: undefined,
    });
  });
});
```

**Patterns:**
- Use `describe()` blocks to group related tests
- One assertion per test when possible (clear failure messages)
- Descriptive test names: "should [expected behavior] [conditions]"
- Setup within each test using inline fixtures (not shared beforeEach when possible)

## Setup and Teardown

**Hooks:**
- `afterEach()` for cleanup (seen in `src/agents/agent-scope.test.ts:18-20`)
- Unstub environment variables after each test: `vi.unstubAllEnvs()`

**Example from `src/agents/agent-scope.test.ts:18-20`:**
```typescript
afterEach(() => {
  vi.unstubAllEnvs();
});
```

**Configuration (vitest.config.ts:74-78):**
- `unstubEnvs: true` - Environment stubs are scoped to test
- `unstubGlobals: true` - Global mocks are scoped to test
- Prevents cross-test pollution, especially under `pool=vmForks`

## Environment & Isolation

**Environment Handling:**
- Stub environment variables per test using `withEnv()` utility
- Example from `src/agents/agent-paths.test.ts:20-30`:
```typescript
withEnv(
  {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_AGENT_DIR: undefined,
    PI_CODING_AGENT_DIR: undefined,
  },
  () => {
    const resolved = resolveOpenClawAgentDir();
    expect(resolved).toBe(path.join(stateDir, "agents", "main", "agent"));
  },
);
```

**Temp Files:**
- Use `fs.mkdtemp()` for creating temporary test directories
- Always cleanup in finally block: `await fs.rm(stateDir, { recursive: true, force: true })`

## Mocking

**Framework:** Vitest's `vi` (spies, mocks, stubs)

**Patterns:**
```typescript
import { vi } from "vitest";

// Create mock function
const readAcpSessionEntryMock = vi.fn();

// Reset before each test
readAcpSessionEntryMock.mockReset();

// Setup return value
readAcpSessionEntryMock.mockReturnValue({
  entry: { sessionId: "123" },
  storePath: "/path/to/store",
});

// Assert it was called with specific args
expect(readAcpSessionEntryMock).toHaveBeenCalledWith({
  sessionKey: "test:main",
});
```

**Example from `src/agents/acp-spawn-parent-stream.test.ts`:**
```typescript
const readAcpSessionEntryMock = vi.fn();

// In test setup
readAcpSessionEntryMock.mockReturnValue({
  entry: {
    sessionId: "test-session",
    // ...
  },
  storePath: "/path/to/store",
});

// In assertions
expect(readAcpSessionEntryMock).toHaveBeenCalledWith({
  sessionKey: "test:main",
});
```

**What to Mock:**
- External service calls (API clients, databases)
- File system operations (in unit tests)
- Time-dependent functions
- Expensive operations

**What NOT to Mock:**
- Pure functions (test the actual logic)
- Type definitions and validation
- Configuration resolution (use real config objects instead)
- Error handling paths (test actual errors)

## Fixtures and Factories

**Test Data:**
- Inline fixtures directly in test
- Example from `src/agents/agent-scope.test.ts:30-35`:
```typescript
const cfg: OpenClawConfig = {
  agents: {
    list: [{ id: "main", workspace: "~/openclaw" }],
  },
};
```

**Factories for Reusable Data:**
- Located in `test-utils/` directory or imported from same file
- Example from `src/agents/agent-paths.test.ts:9-16`:
```typescript
const withTempStateDir = async (run: (stateDir: string) => void) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
  try {
    run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
};
```

**Usage Pattern:**
- Factories accept callback functions
- Ensure cleanup happens in finally block

## Async Testing

**Patterns:**
- Use `async/await` in test functions
- Promise-based assertions with `expect().rejects`

**Example from `src/acp/runtime/errors.test.ts:6-18`:**
```typescript
await expect(
  withAcpRuntimeErrorBoundary({
    run: async () => {
      throw new Error("boom");
    },
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "fallback",
  }),
).rejects.toMatchObject({
  name: "AcpRuntimeError",
  code: "ACP_TURN_FAILED",
  message: "boom",
});
```

**Error Testing:**
```typescript
it("passes through existing ACP runtime errors", async () => {
  const existing = new AcpRuntimeError("ACP_BACKEND_MISSING", "backend missing");
  await expect(
    withAcpRuntimeErrorBoundary({
      run: async () => {
        throw existing;
      },
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "fallback",
    }),
  ).rejects.toBe(existing);
});
```

## Test Types & Scope

**Unit Tests:**
- Scope: Single function or module in isolation
- Location: `src/**/*.test.ts`
- Run: `pnpm test:fast` or `pnpm test`
- Configuration: `vitest.unit.config.ts` for fast-running subset
- Example: `agent-scope.test.ts` tests config resolution logic in isolation

**Integration Tests:**
- Scope: Multiple modules working together
- Location: `src/**/*.test.ts` (same as unit, but testing interaction)
- Example: `docker-image-digests.test.ts`, `docker-setup.e2e.test.ts`
- Run with: `pnpm test:docker:*` commands for Docker-specific tests

**E2E Tests:**
- Scope: Full system end-to-end workflows
- Location: Files matching `**/*.e2e.test.ts` or configured in `vitest.e2e.config.ts`
- Run: `pnpm test:e2e`
- Requirements: Full environment setup (gateway running, etc.)

**Live Integration Tests:**
- Scope: Real external service integration (requires actual credentials)
- Location: Files matching `**/*.live.test.ts`
- Excluded from normal test runs (separate vitest.live.config.ts)
- Run: `OPENCLAW_LIVE_TEST=1 vitest run --config vitest.live.config.ts`
- Example: `android-node.capabilities.live.test.ts`

## Coverage

**Requirements:** No enforced minimum (project-specific goals)

**View Coverage:**
```bash
pnpm test:coverage
```

**Configuration (vitest.config.ts):**
- Coverage tool: `@vitest/coverage-v8` (from devDependencies)
- Run with: `vitest run --config vitest.unit.config.ts --coverage`

## Validation & Verification (FrankOS Context)

**Testing Requirements (Per Engineering Constitution):**
- All systems must have rollback procedures before deployment
- Configuration changes require verification testing before production use
- Test plans must be documented with expected results
- Risk assessment logged in ledger before changes

**QA Practices Observed in Codebase:**
1. Type checking: `pnpm check` runs type checking
2. Linting: `pnpm lint` with type-aware oxlint
3. Format validation: `pnpm format:check`
4. Deadcode detection: `pnpm deadcode:report` (knip, ts-prune, ts-unused-exports)
5. Performance budgeting: `pnpm check:loc --max 500` (max 500 lines per file)

**CI/CD Integration:**
- Tests run in parallel using `vitest` worker threads
- Configuration: `maxWorkers: isCI ? ciWorkers : localWorkers`
- Windows CI: 2 workers; Unix CI: 3 workers; Local: up to 16 workers
- Test timeout: 120 seconds (180 seconds for hooks on Windows)

## Common Test Patterns

**Configuration Testing:**
```typescript
it("resolves agent config with all fields", () => {
  const cfg: OpenClawConfig = {
    agents: { list: [{ id: "main", /* ... */ }] },
  };
  const result = resolveAgentConfig(cfg, "main");
  expect(result).toEqual({
    name: "Main Agent",
    workspace: "~/openclaw",
    // ... all expected fields
  });
});
```

**Undefined/Missing Case:**
```typescript
it("returns undefined for missing agent", () => {
  const cfg: OpenClawConfig = { /* no agents */ };
  const result = resolveAgentConfig(cfg, "nonexistent");
  expect(result).toBeUndefined();
});
```

**Environment Variable Handling:**
```typescript
it("honors OPENCLAW_AGENT_DIR overrides", async () => {
  await withTempStateDir((stateDir) => {
    const override = path.join(stateDir, "agent");
    withEnv(
      { OPENCLAW_AGENT_DIR: override, /* ... */ },
      () => {
        const resolved = resolveOpenClawAgentDir();
        expect(resolved).toBe(path.resolve(override));
      },
    );
  });
});
```

**Error Type Checking:**
```typescript
it("wraps generic errors with fallback code", async () => {
  await expect(
    withAcpRuntimeErrorBoundary({
      run: async () => { throw new Error("boom"); },
      fallbackCode: "CODE",
      fallbackMessage: "msg",
    }),
  ).rejects.toMatchObject({
    name: "AcpRuntimeError",
    code: "CODE",
    message: "boom",
  });
});
```

---

*Testing analysis: 2026-03-08*
