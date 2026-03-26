---
name: vitest-cli
description: Command line interface commands and options
---

# Command Line Interface

## Commands

### `vitest`

Start Vitest in watch mode (dev) or run mode (CI):

```bash
vitest                    # Watch mode in dev, run mode in CI
vitest foobar             # Run tests containing "foobar" in path
vitest basic/foo.test.ts:10  # Run specific test by file and line number
```

### `vitest run`

Run tests once without watch mode:

```bash
vitest run
vitest run --coverage
```

### `vitest watch`

Explicitly start watch mode:

```bash
vitest watch
```

### `vitest related`

Run tests that import specific files (useful with lint-staged):

```bash
vitest related src/index.ts src/utils.ts --run
```

### `vitest bench`

Run only benchmark tests:

```bash
vitest bench
```

### `vitest list`

List all matching tests without running them:

```bash
vitest list                    # List test names
vitest list --json             # Output as JSON
vitest list --filesOnly        # List only test files
```

### `vitest init`

Initialize project setup:

```bash
vitest init browser            # Set up browser testing
```

## Common Options

```bash
# Configuration
--config <path>           # Path to config file
--project <name>          # Run specific project

# Filtering
--testNamePattern, -t     # Run tests matching pattern
--changed                 # Run tests for changed files
--changed HEAD~1          # Tests for last commit changes

# Reporters
--reporter <name>         # default, verbose, dot, json, html
--reporter=html --outputFile=report.html

# Coverage
--coverage                # Enable coverage
--coverage.provider v8    # Use v8 provider
--coverage.reporter text,html

# Execution
--shard <index>/<count>   # Split tests across machines
--bail <n>                # Stop after n failures
--retry <n>               # Retry failed tests n times
--sequence.shuffle        # Randomize test order

# Watch mode
--no-watch                # Disable watch mode
--standalone              # Start without running tests

# Environment
--environment <env>       # jsdom, happy-dom, node
--globals                 # Enable global APIs

# Debugging
--inspect                 # Enable Node inspector
--inspect-brk             # Break on start

# Output
--silent                  # Suppress console output
--no-color                # Disable colors
```

## Package.json Scripts

```json
{
  "scripts": {
    "test": "vitest",
    "test:run": "vitest run",
    "test:ui": "vitest --ui",
    "coverage": "vitest run --coverage"
  }
}
```

## Sharding for CI

Split tests across multiple machines:

```bash
# Machine 1
vitest run --shard=1/3 --reporter=blob

# Machine 2
vitest run --shard=2/3 --reporter=blob

# Machine 3
vitest run --shard=3/3 --reporter=blob

# Merge reports
vitest --merge-reports --reporter=junit
```

## Watch Mode Keyboard Shortcuts

In watch mode, press:
- `a` - Run all tests
- `f` - Run only failed tests
- `u` - Update snapshots
- `p` - Filter by filename pattern
- `t` - Filter by test name pattern
- `q` - Quit

## Key Points

- Watch mode is default in dev, run mode in CI (when `process.env.CI` is set)
- Use `--run` flag to ensure single run (important for lint-staged)
- Both camelCase (`--testTimeout`) and kebab-case (`--test-timeout`) work
- Boolean options can be negated with `--no-` prefix

<!-- 
Source references:
- https://vitest.dev/guide/cli.html
-->
