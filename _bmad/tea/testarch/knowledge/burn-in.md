# Burn-in Test Runner

## Principle

Use smart test selection with git diff analysis to run only affected tests. Filter out irrelevant changes (configs, types, docs) and control test volume with percentage-based execution. Reduce unnecessary CI runs while maintaining reliability.

## Rationale

Playwright's `--only-changed` triggers all affected tests:

- Config file changes trigger hundreds of tests
- Type definition changes cause full suite runs
- No volume control (all or nothing)
- Slow CI pipelines

The `burn-in` utility provides:

- **Smart filtering**: Skip patterns for irrelevant files (configs, types, docs)
- **Volume control**: Run percentage of affected tests after filtering
- **Custom dependency analysis**: More accurate than Playwright's built-in
- **CI optimization**: Faster pipelines without sacrificing confidence
- **Process of elimination**: Start with all → filter irrelevant → control volume

## Pattern Examples

### Example 1: Basic Burn-in Setup

**Context**: Run burn-in on changed files compared to main branch.

**Implementation**:

```typescript
// Step 1: Create burn-in script
// playwright/scripts/burn-in-changed.ts
import { runBurnIn } from '@seontechnologies/playwright-utils/burn-in'

async function main() {
  await runBurnIn({
    configPath: 'playwright/config/.burn-in.config.ts',
    baseBranch: 'main'
  })
}

main().catch(console.error)

// Step 2: Create config
// playwright/config/.burn-in.config.ts
import type { BurnInConfig } from '@seontechnologies/playwright-utils/burn-in'

const config: BurnInConfig = {
  // Files that never trigger tests (first filter)
  skipBurnInPatterns: [
    '**/config/**',
    '**/*constants*',
    '**/*types*',
    '**/*.md',
    '**/README*'
  ],

  // Run 30% of remaining tests after skip filter
  burnInTestPercentage: 0.3,

  // Burn-in repetition
  burnIn: {
    repeatEach: 3,  // Run each test 3 times
    retries: 1      // Allow 1 retry
  }
}

export default config

// Step 3: Add package.json script
{
  "scripts": {
    "test:pw:burn-in-changed": "tsx playwright/scripts/burn-in-changed.ts"
  }
}
```

**Key Points**:

- Two-stage filtering: skip patterns, then volume control
- `skipBurnInPatterns` eliminates irrelevant files
- `burnInTestPercentage` controls test volume (0.3 = 30%)
- Custom dependency analysis finds actually affected tests

### Example 2: CI Integration

**Context**: Use burn-in in GitHub Actions for efficient CI runs.

**Implementation**:

```yaml
# .github/workflows/burn-in.yml
name: Burn-in Changed Tests

on:
  pull_request:
    branches: [main]

jobs:
  burn-in:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # Need git history

      - name: Setup Node
        uses: actions/setup-node@v4

      - name: Install dependencies
        run: npm ci

      - name: Run burn-in on changed tests
        run: npm run test:pw:burn-in-changed -- --base-branch=origin/main

      - name: Upload artifacts
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: burn-in-failures
          path: test-results/
```

**Key Points**:

- `fetch-depth: 0` for full git history
- Pass `--base-branch=origin/main` for PR comparison
- Upload artifacts only on failure
- Significantly faster than full suite

### Example 3: How It Works (Process of Elimination)

**Context**: Understanding the filtering pipeline.

**Scenario:**

```
Git diff finds: 21 changed files
├─ Step 1: Skip patterns filter
│  Removed: 6 files (*.md, config/*, *types*)
│  Remaining: 15 files
│
├─ Step 2: Dependency analysis
│  Tests that import these 15 files: 45 tests
│
└─ Step 3: Volume control (30%)
   Final tests to run: 14 tests (30% of 45)

Result: Run 14 targeted tests instead of 147 with --only-changed!
```

**Key Points**:

- Three-stage pipeline: skip → analyze → control
- Custom dependency analysis (not just imports)
- Percentage applies AFTER filtering
- Dramatically reduces CI time

### Example 4: Environment-Specific Configuration

**Context**: Different settings for local vs CI environments.

**Implementation**:

```typescript
import type { BurnInConfig } from "@seontechnologies/playwright-utils/burn-in";

const config: BurnInConfig = {
  skipBurnInPatterns: ["**/config/**", "**/*types*", "**/*.md"],

  // CI runs fewer iterations, local runs more
  burnInTestPercentage: process.env.CI ? 0.2 : 0.3,

  burnIn: {
    repeatEach: process.env.CI ? 2 : 3,
    retries: process.env.CI ? 0 : 1, // No retries in CI
  },
};

export default config;
```

**Key Points**:

- `process.env.CI` for environment detection
- Lower percentage in CI (20% vs 30%)
- Fewer iterations in CI (2 vs 3)
- No retries in CI (fail fast)

### Example 5: Sharding Support

**Context**: Distribute burn-in tests across multiple CI workers.

**Implementation**:

```typescript
// burn-in-changed.ts with sharding
import { runBurnIn } from "@seontechnologies/playwright-utils/burn-in";

async function main() {
  const shardArg = process.argv.find((arg) => arg.startsWith("--shard="));

  if (shardArg) {
    process.env.PW_SHARD = shardArg.split("=")[1];
  }

  await runBurnIn({
    configPath: "playwright/config/.burn-in.config.ts",
  });
}
```

```yaml
# GitHub Actions with sharding
jobs:
  burn-in:
    strategy:
      matrix:
        shard: [1/3, 2/3, 3/3]
    steps:
      - run: npm run test:pw:burn-in-changed -- --shard=${{ matrix.shard }}
```

**Key Points**:

- Pass `--shard=1/3` for parallel execution
- Burn-in respects Playwright sharding
- Distribute across multiple workers
- Reduces total CI time further

## Integration with CI Workflow

When setting up CI with `*ci` workflow, recommend burn-in for:

- Pull request validation
- Pre-merge checks
- Nightly builds (subset runs)

## Related Fragments

- `ci-burn-in.md` - Traditional burn-in patterns (10-iteration loops)
- `selective-testing.md` - Test selection strategies
- `overview.md` - Installation

## Anti-Patterns

**❌ Over-aggressive skip patterns:**

```typescript
skipBurnInPatterns: [
  "**/*", // Skips everything!
];
```

**✅ Targeted skip patterns:**

```typescript
skipBurnInPatterns: ["**/config/**", "**/*types*", "**/*.md", "**/*constants*"];
```

**❌ Too low percentage (false confidence):**

```typescript
burnInTestPercentage: 0.05; // Only 5% - might miss issues
```

**✅ Balanced percentage:**

```typescript
burnInTestPercentage: 0.2; // 20% in CI, provides good coverage
```
