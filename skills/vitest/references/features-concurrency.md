---
name: concurrency-parallelism
description: Concurrent tests, parallel execution, and sharding
---

# Concurrency & Parallelism

## File Parallelism

By default, Vitest runs test files in parallel across workers:

```ts
defineConfig({
  test: {
    // Run files in parallel (default: true)
    fileParallelism: true,
    
    // Number of worker threads
    maxWorkers: 4,
    minWorkers: 1,
    
    // Pool type: 'threads', 'forks', 'vmThreads'
    pool: 'threads',
  },
})
```

## Concurrent Tests

Run tests within a file in parallel:

```ts
// Individual concurrent tests
test.concurrent('test 1', async ({ expect }) => {
  expect(await fetch1()).toBe('result')
})

test.concurrent('test 2', async ({ expect }) => {
  expect(await fetch2()).toBe('result')
})

// All tests in suite concurrent
describe.concurrent('parallel suite', () => {
  test('test 1', async ({ expect }) => {})
  test('test 2', async ({ expect }) => {})
})
```

**Important:** Use `{ expect }` from context for concurrent tests.

## Sequential in Concurrent Context

Force sequential execution:

```ts
describe.concurrent('mostly parallel', () => {
  test('parallel 1', async () => {})
  test('parallel 2', async () => {})
  
  test.sequential('must run alone 1', async () => {})
  test.sequential('must run alone 2', async () => {})
})

// Or entire suite
describe.sequential('sequential suite', () => {
  test('first', () => {})
  test('second', () => {})
})
```

## Max Concurrency

Limit concurrent tests:

```ts
defineConfig({
  test: {
    maxConcurrency: 5, // Max concurrent tests per file
  },
})
```

## Isolation

Each file runs in isolated environment by default:

```ts
defineConfig({
  test: {
    // Disable isolation for faster runs (less safe)
    isolate: false,
  },
})
```

## Sharding

Split tests across machines:

```bash
# Machine 1
vitest run --shard=1/3

# Machine 2
vitest run --shard=2/3

# Machine 3
vitest run --shard=3/3
```

### CI Example (GitHub Actions)

```yaml
jobs:
  test:
    strategy:
      matrix:
        shard: [1, 2, 3]
    steps:
      - run: vitest run --shard=${{ matrix.shard }}/3 --reporter=blob
      
  merge:
    needs: test
    steps:
      - run: vitest --merge-reports --reporter=junit
```

### Merge Reports

```bash
# Each shard outputs blob
vitest run --shard=1/3 --reporter=blob --coverage
vitest run --shard=2/3 --reporter=blob --coverage

# Merge all blobs
vitest --merge-reports --reporter=json --coverage
```

## Test Sequence

Control test order:

```ts
defineConfig({
  test: {
    sequence: {
      // Run tests in random order
      shuffle: true,
      
      // Seed for reproducible shuffle
      seed: 12345,
      
      // Hook execution order
      hooks: 'stack', // 'stack', 'list', 'parallel'
      
      // All tests concurrent by default
      concurrent: true,
    },
  },
})
```

## Shuffle Tests

Randomize to catch hidden dependencies:

```ts
// Via CLI
vitest --sequence.shuffle

// Per suite
describe.shuffle('random order', () => {
  test('test 1', () => {})
  test('test 2', () => {})
  test('test 3', () => {})
})
```

## Pool Options

### Threads (Default)

```ts
defineConfig({
  test: {
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: 8,
        minThreads: 2,
        isolate: true,
      },
    },
  },
})
```

### Forks

Better isolation, slower:

```ts
defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 4,
        isolate: true,
      },
    },
  },
})
```

### VM Threads

Full VM isolation per file:

```ts
defineConfig({
  test: {
    pool: 'vmThreads',
  },
})
```

## Bail on Failure

Stop after first failure:

```bash
vitest --bail 1    # Stop after 1 failure
vitest --bail      # Stop on first failure (same as --bail 1)
```

## Key Points

- Files run in parallel by default
- Use `.concurrent` for parallel tests within file
- Always use context's `expect` in concurrent tests
- Sharding splits tests across CI machines
- Use `--merge-reports` to combine sharded results
- Shuffle tests to find hidden dependencies

<!-- 
Source references:
- https://vitest.dev/guide/features.html#running-tests-concurrently
- https://vitest.dev/guide/improving-performance.html
-->
