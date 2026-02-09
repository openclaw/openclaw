# Test Speed Tiers

OpenClaw organizes tests into three speed tiers for optimized CI execution and better developer experience.

## Overview

| Tier      | Duration | Description                     | CI Behavior                  |
| --------- | -------- | ------------------------------- | ---------------------------- |
| 🟢 Fast   | <100ms   | Pure unit tests, simple logic   | Runs first, fail-fast        |
| 🟡 Medium | 100ms-1s | Tests with mocks, I/O, setup    | Runs after fast passes       |
| 🔴 Slow   | >1s      | E2E, integration, browser tests | Runs in parallel with medium |

## Running Tests by Tier

```bash
# Run all tiers (default, sequential)
pnpm test:tiered

# Run specific tiers
pnpm test:fast      # Fast tests only
pnpm test:medium    # Medium tests only
pnpm test:slow      # Slow tests only

# Run multiple tiers
pnpm test:tiered --fast --medium

# Analyze test tier classification
pnpm test:analyze-tiers
pnpm test:analyze-tiers --verbose  # Show detailed classification
pnpm test:analyze-tiers --output report.json  # Save to file
```

## Tier Classification

### Fast Tier (<100ms)

Tests are classified as "fast" when they:

- Have no async operations or timers
- Don't spawn processes
- Don't perform file I/O
- Don't use fake timers or complex mocks

Examples:

- Utility function tests
- Data transformation tests
- Pure logic tests

### Medium Tier (100ms - 1s)

Tests are classified as "medium" when they:

- Use fake timers (`vi.useFakeTimers`)
- Perform file I/O operations
- Have `beforeAll`/`afterAll` hooks with setup
- Are located in `extensions/` directory

Examples:

- Extension tests
- Tests with mocked services
- Tests with file system operations

### Slow Tier (>1s)

Tests are classified as "slow" when they:

- Have file names matching `*.e2e.test.ts`, `*.live.test.ts`, or `*.integration.test.ts`
- Spawn child processes
- Have high timeout values (≥5000ms)
- Make network calls

Examples:

- E2E tests
- Integration tests with real services
- Provider contract tests

**Note**: UI browser tests (`ui/**/*.browser.test.ts`) are **not** included in the slow tier.
They require the Playwright browser environment and run separately via `pnpm test:ui`.

## CI Configuration

The CI workflow uses tiered execution for optimized performance:

1. **Fast tests** run first with high parallelism
2. If fast tests pass, **medium** and **slow** tests run in parallel
3. Each tier has optimized worker counts for its workload type

This approach:

- Catches regressions quickly (fast tests fail within ~30s)
- Reduces CI resource usage (stop early on fast failures)
- Allows parallel execution where appropriate

## Configuration Files

- `vitest.tier-fast.config.ts` - Fast tier configuration
- `vitest.tier-medium.config.ts` - Medium tier configuration
- `vitest.tier-slow.config.ts` - Slow tier configuration
- `scripts/test-tiered.mjs` - Tiered test runner
- `scripts/test-tier-analyzer.ts` - Classification analyzer

## UI Browser Tests

UI browser tests (`ui/src/**/*.browser.test.ts`) run separately from the tiered test system
because they require a browser environment (Playwright):

```bash
# Run UI browser tests
pnpm test:ui
```

These tests use the `ui/vitest.config.ts` configuration which enables browser mode with Playwright.
They are excluded from the tiered configs to avoid environment conflicts.

## Environment Variables

| Variable                  | Description                   | Default            |
| ------------------------- | ----------------------------- | ------------------ |
| `OPENCLAW_TEST_WORKERS`   | Override max workers per tier | Auto-scaled to CPU |
| `OPENCLAW_TEST_FAIL_FAST` | Stop on first tier failure    | `true`             |

## Adding New Tests

When writing new tests, consider which tier they belong to:

1. **Fast by default**: Write pure unit tests when possible
2. **Minimize dependencies**: Avoid unnecessary setup/teardown
3. **Use appropriate patterns**: E2E tests should use `.e2e.test.ts` suffix
4. **Check classification**: Run `pnpm test:analyze-tiers --verbose` to verify

## Migrating Existing Tests

To improve test suite performance:

1. Run the analyzer to identify slow tests: `pnpm test:analyze-tiers --output report.json`
2. Review tests classified as slow that could be faster
3. Consider refactoring to reduce I/O or process spawning
4. Move pure logic into separate fast test files
