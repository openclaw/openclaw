---
name: test-filtering
description: Filter tests by name, file patterns, and tags
---

# Test Filtering

## CLI Filtering

### By File Path

```bash
# Run files containing "user"
vitest user

# Multiple patterns
vitest user auth

# Specific file
vitest src/user.test.ts

# By line number
vitest src/user.test.ts:25
```

### By Test Name

```bash
# Tests matching pattern
vitest -t "login"
vitest --testNamePattern "should.*work"

# Regex patterns
vitest -t "/user|auth/"
```

## Changed Files

```bash
# Uncommitted changes
vitest --changed

# Since specific commit
vitest --changed HEAD~1
vitest --changed abc123

# Since branch
vitest --changed origin/main
```

## Related Files

Run tests that import specific files:

```bash
vitest related src/utils.ts src/api.ts --run
```

Useful with lint-staged:

```js
// .lintstagedrc.js
export default {
  '*.{ts,tsx}': 'vitest related --run',
}
```

## Focus Tests (.only)

```ts
test.only('only this runs', () => {})

describe.only('only this suite', () => {
  test('runs', () => {})
})
```

In CI, `.only` throws error unless configured:

```ts
defineConfig({
  test: {
    allowOnly: true, // Allow .only in CI
  },
})
```

## Skip Tests

```ts
test.skip('skipped', () => {})

// Conditional
test.skipIf(process.env.CI)('not in CI', () => {})
test.runIf(!process.env.CI)('local only', () => {})

// Dynamic skip
test('dynamic', ({ skip }) => {
  skip(someCondition, 'reason')
})
```

## Tags

Filter by custom tags:

```ts
test('database test', { tags: ['db'] }, () => {})
test('slow test', { tags: ['slow', 'integration'] }, () => {})
```

Run tagged tests:

```bash
vitest --tags db
vitest --tags "db,slow"      # OR
vitest --tags db --tags slow # OR
```

Configure allowed tags:

```ts
defineConfig({
  test: {
    tags: ['db', 'slow', 'integration'],
    strictTags: true, // Fail on unknown tags
  },
})
```

## Include/Exclude Patterns

```ts
defineConfig({
  test: {
    // Test file patterns
    include: ['**/*.{test,spec}.{ts,tsx}'],
    
    // Exclude patterns
    exclude: [
      '**/node_modules/**',
      '**/e2e/**',
      '**/*.skip.test.ts',
    ],
    
    // Include source for in-source testing
    includeSource: ['src/**/*.ts'],
  },
})
```

## Watch Mode Filtering

In watch mode, press:
- `p` - Filter by filename pattern
- `t` - Filter by test name pattern
- `a` - Run all tests
- `f` - Run only failed tests

## Projects Filtering

Run specific project:

```bash
vitest --project unit
vitest --project integration --project e2e
```

## Environment-based Filtering

```ts
const isDev = process.env.NODE_ENV === 'development'
const isCI = process.env.CI

describe.skipIf(isCI)('local only tests', () => {})
describe.runIf(isDev)('dev tests', () => {})
```

## Combining Filters

```bash
# File pattern + test name + changed
vitest user -t "login" --changed

# Related files + run mode
vitest related src/auth.ts --run
```

## List Tests Without Running

```bash
vitest list                 # Show all test names
vitest list -t "user"       # Filter by name
vitest list --filesOnly     # Show only file paths
vitest list --json          # JSON output
```

## Key Points

- Use `-t` for test name pattern filtering
- `--changed` runs only tests affected by changes
- `--related` runs tests importing specific files
- Tags provide semantic test grouping
- Use `.only` for debugging, but configure CI to reject it
- Watch mode has interactive filtering

<!-- 
Source references:
- https://vitest.dev/guide/filtering.html
- https://vitest.dev/guide/cli.html
-->
