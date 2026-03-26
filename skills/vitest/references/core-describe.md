---
name: describe-api
description: describe/suite for grouping tests into logical blocks
---

# Describe API

Group related tests into suites for organization and shared setup.

## Basic Usage

```ts
import { describe, expect, test } from 'vitest'

describe('Math', () => {
  test('adds numbers', () => {
    expect(1 + 1).toBe(2)
  })

  test('subtracts numbers', () => {
    expect(3 - 1).toBe(2)
  })
})

// Alias: suite
import { suite } from 'vitest'
suite('equivalent to describe', () => {})
```

## Nested Suites

```ts
describe('User', () => {
  describe('when logged in', () => {
    test('shows dashboard', () => {})
    test('can update profile', () => {})
  })

  describe('when logged out', () => {
    test('shows login page', () => {})
  })
})
```

## Suite Options

```ts
// All tests inherit options
describe('slow tests', { timeout: 30_000 }, () => {
  test('test 1', () => {}) // 30s timeout
  test('test 2', () => {}) // 30s timeout
})
```

## Suite Modifiers

### Skip Suites

```ts
describe.skip('skipped suite', () => {
  test('wont run', () => {})
})

// Conditional
describe.skipIf(process.env.CI)('not in CI', () => {})
describe.runIf(!process.env.CI)('only local', () => {})
```

### Focus Suites

```ts
describe.only('only this suite runs', () => {
  test('runs', () => {})
})
```

### Todo Suites

```ts
describe.todo('implement later')
```

### Concurrent Suites

```ts
// All tests run in parallel
describe.concurrent('parallel tests', () => {
  test('test 1', async ({ expect }) => {})
  test('test 2', async ({ expect }) => {})
})
```

### Sequential in Concurrent

```ts
describe.concurrent('parallel', () => {
  test('concurrent 1', async () => {})
  
  describe.sequential('must be sequential', () => {
    test('step 1', async () => {})
    test('step 2', async () => {})
  })
})
```

### Shuffle Tests

```ts
describe.shuffle('random order', () => {
  test('test 1', () => {})
  test('test 2', () => {})
  test('test 3', () => {})
})

// Or with option
describe('random', { shuffle: true }, () => {})
```

## Parameterized Suites

### describe.each

```ts
describe.each([
  { name: 'Chrome', version: 100 },
  { name: 'Firefox', version: 90 },
])('$name browser', ({ name, version }) => {
  test('has version', () => {
    expect(version).toBeGreaterThan(0)
  })
})
```

### describe.for

```ts
describe.for([
  ['Chrome', 100],
  ['Firefox', 90],
])('%s browser', ([name, version]) => {
  test('has version', () => {
    expect(version).toBeGreaterThan(0)
  })
})
```

## Hooks in Suites

```ts
describe('Database', () => {
  let db

  beforeAll(async () => {
    db = await createDb()
  })

  afterAll(async () => {
    await db.close()
  })

  beforeEach(async () => {
    await db.clear()
  })

  test('insert works', async () => {
    await db.insert({ name: 'test' })
    expect(await db.count()).toBe(1)
  })
})
```

## Modifier Combinations

All modifiers can be chained:

```ts
describe.skip.concurrent('skipped concurrent', () => {})
describe.only.shuffle('only and shuffled', () => {})
describe.concurrent.skip('equivalent', () => {})
```

## Key Points

- Top-level tests belong to an implicit file suite
- Nested suites inherit parent's options (timeout, retry, etc.)
- Hooks are scoped to their suite and nested suites
- Use `describe.concurrent` with context's `expect` for snapshots
- Shuffle order depends on `sequence.seed` config

<!-- 
Source references:
- https://vitest.dev/api/describe.html
-->
