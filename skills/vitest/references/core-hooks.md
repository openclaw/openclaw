---
name: lifecycle-hooks
description: beforeEach, afterEach, beforeAll, afterAll, and around hooks
---

# Lifecycle Hooks

## Basic Hooks

```ts
import { afterAll, afterEach, beforeAll, beforeEach, test } from 'vitest'

beforeAll(async () => {
  // Runs once before all tests in file/suite
  await setupDatabase()
})

afterAll(async () => {
  // Runs once after all tests in file/suite
  await teardownDatabase()
})

beforeEach(async () => {
  // Runs before each test
  await clearTestData()
})

afterEach(async () => {
  // Runs after each test
  await cleanupMocks()
})
```

## Cleanup Return Pattern

Return cleanup function from `before*` hooks:

```ts
beforeAll(async () => {
  const server = await startServer()
  
  // Returned function runs as afterAll
  return async () => {
    await server.close()
  }
})

beforeEach(async () => {
  const connection = await connect()
  
  // Runs as afterEach
  return () => connection.close()
})
```

## Scoped Hooks

Hooks apply to current suite and nested suites:

```ts
describe('outer', () => {
  beforeEach(() => console.log('outer before'))
  
  test('test 1', () => {}) // outer before → test
  
  describe('inner', () => {
    beforeEach(() => console.log('inner before'))
    
    test('test 2', () => {}) // outer before → inner before → test
  })
})
```

## Hook Timeout

```ts
beforeAll(async () => {
  await slowSetup()
}, 30_000) // 30 second timeout
```

## Around Hooks

Wrap tests with setup/teardown context:

```ts
import { aroundEach, test } from 'vitest'

// Wrap each test in database transaction
aroundEach(async (runTest) => {
  await db.beginTransaction()
  await runTest() // Must be called!
  await db.rollback()
})

test('insert user', async () => {
  await db.insert({ name: 'Alice' })
  // Automatically rolled back after test
})
```

### aroundAll

Wrap entire suite:

```ts
import { aroundAll, test } from 'vitest'

aroundAll(async (runSuite) => {
  console.log('before all tests')
  await runSuite() // Must be called!
  console.log('after all tests')
})
```

### Multiple Around Hooks

Nested like onion layers:

```ts
aroundEach(async (runTest) => {
  console.log('outer before')
  await runTest()
  console.log('outer after')
})

aroundEach(async (runTest) => {
  console.log('inner before')
  await runTest()
  console.log('inner after')
})

// Order: outer before → inner before → test → inner after → outer after
```

## Test Hooks

Inside test body:

```ts
import { onTestFailed, onTestFinished, test } from 'vitest'

test('with cleanup', () => {
  const db = connect()
  
  // Runs after test finishes (pass or fail)
  onTestFinished(() => db.close())
  
  // Only runs if test fails
  onTestFailed(({ task }) => {
    console.log('Failed:', task.result?.errors)
  })
  
  db.query('SELECT * FROM users')
})
```

### Reusable Cleanup Pattern

```ts
function useTestDb() {
  const db = connect()
  onTestFinished(() => db.close())
  return db
}

test('query users', () => {
  const db = useTestDb()
  expect(db.query('SELECT * FROM users')).toBeDefined()
})

test('query orders', () => {
  const db = useTestDb() // Fresh connection, auto-closed
  expect(db.query('SELECT * FROM orders')).toBeDefined()
})
```

## Concurrent Test Hooks

For concurrent tests, use context's hooks:

```ts
test.concurrent('concurrent', ({ onTestFinished }) => {
  const resource = allocate()
  onTestFinished(() => resource.release())
})
```

## Extended Test Hooks

With `test.extend`, hooks are type-aware:

```ts
const test = base.extend<{ db: Database }>({
  db: async ({}, use) => {
    const db = await createDb()
    await use(db)
    await db.close()
  },
})

// These hooks know about `db` fixture
test.beforeEach(({ db }) => {
  db.seed()
})

test.afterEach(({ db }) => {
  db.clear()
})
```

## Hook Execution Order

Default order (stack):
1. `beforeAll` (in order)
2. `beforeEach` (in order)
3. Test
4. `afterEach` (reverse order)
5. `afterAll` (reverse order)

Configure with `sequence.hooks`:

```ts
defineConfig({
  test: {
    sequence: {
      hooks: 'list', // 'stack' (default), 'list', 'parallel'
    },
  },
})
```

## Key Points

- Hooks are not called during type checking
- Return cleanup function from `before*` to avoid `after*` duplication
- `aroundEach`/`aroundAll` must call `runTest()`/`runSuite()`
- `onTestFinished` always runs, even if test fails
- Use context hooks for concurrent tests

<!-- 
Source references:
- https://vitest.dev/api/hooks.html
-->
