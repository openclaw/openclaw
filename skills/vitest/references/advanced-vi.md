---
name: vi-utilities
description: vi helper for mocking, timers, utilities
---

# Vi Utilities

The `vi` helper provides mocking and utility functions.

```ts
import { vi } from 'vitest'
```

## Mock Functions

```ts
// Create mock
const fn = vi.fn()
const fnWithImpl = vi.fn((x) => x * 2)

// Check if mock
vi.isMockFunction(fn) // true

// Mock methods
fn.mockReturnValue(42)
fn.mockReturnValueOnce(1)
fn.mockResolvedValue(data)
fn.mockRejectedValue(error)
fn.mockImplementation(() => 'result')
fn.mockImplementationOnce(() => 'once')

// Clear/reset
fn.mockClear()    // Clear call history
fn.mockReset()    // Clear history + implementation
fn.mockRestore()  // Restore original (for spies)
```

## Spying

```ts
const obj = { method: () => 'original' }

const spy = vi.spyOn(obj, 'method')
obj.method()

expect(spy).toHaveBeenCalled()

// Mock implementation
spy.mockReturnValue('mocked')

// Spy on getter/setter
vi.spyOn(obj, 'prop', 'get').mockReturnValue('value')
```

## Module Mocking

```ts
// Hoisted to top of file
vi.mock('./module', () => ({
  fn: vi.fn(),
}))

// Partial mock
vi.mock('./module', async (importOriginal) => ({
  ...(await importOriginal()),
  specificFn: vi.fn(),
}))

// Spy mode - keep implementation
vi.mock('./module', { spy: true })

// Import actual module inside mock
const actual = await vi.importActual('./module')

// Import as mock
const mocked = await vi.importMock('./module')
```

## Dynamic Mocking

```ts
// Not hoisted - use with dynamic imports
vi.doMock('./config', () => ({ key: 'value' }))
const config = await import('./config')

// Unmock
vi.doUnmock('./config')
vi.unmock('./module') // Hoisted
```

## Reset Modules

```ts
// Clear module cache
vi.resetModules()

// Wait for dynamic imports
await vi.dynamicImportSettled()
```

## Fake Timers

```ts
vi.useFakeTimers()

setTimeout(() => console.log('done'), 1000)

// Advance time
vi.advanceTimersByTime(1000)
vi.advanceTimersByTimeAsync(1000)  // For async callbacks
vi.advanceTimersToNextTimer()
vi.advanceTimersToNextFrame()      // requestAnimationFrame

// Run all timers
vi.runAllTimers()
vi.runAllTimersAsync()
vi.runOnlyPendingTimers()

// Clear timers
vi.clearAllTimers()

// Check state
vi.getTimerCount()
vi.isFakeTimers()

// Restore
vi.useRealTimers()
```

## Mock Date/Time

```ts
vi.setSystemTime(new Date('2024-01-01'))
expect(new Date().getFullYear()).toBe(2024)

vi.getMockedSystemTime()  // Get mocked date
vi.getRealSystemTime()    // Get real time (ms)
```

## Global/Env Mocking

```ts
// Stub global
vi.stubGlobal('fetch', vi.fn())
vi.unstubAllGlobals()

// Stub environment
vi.stubEnv('API_KEY', 'test')
vi.stubEnv('NODE_ENV', 'test')
vi.unstubAllEnvs()
```

## Hoisted Code

Run code before imports:

```ts
const mock = vi.hoisted(() => vi.fn())

vi.mock('./module', () => ({
  fn: mock, // Can reference hoisted variable
}))
```

## Waiting Utilities

```ts
// Wait for callback to succeed
await vi.waitFor(async () => {
  const el = document.querySelector('.loaded')
  expect(el).toBeTruthy()
}, { timeout: 5000, interval: 100 })

// Wait for truthy value
const element = await vi.waitUntil(
  () => document.querySelector('.loaded'),
  { timeout: 5000 }
)
```

## Mock Object

Mock all methods of an object:

```ts
const original = {
  method: () => 'real',
  nested: { fn: () => 'nested' },
}

const mocked = vi.mockObject(original)
mocked.method()  // undefined (mocked)
mocked.method.mockReturnValue('mocked')

// Spy mode
const spied = vi.mockObject(original, { spy: true })
spied.method()  // 'real'
expect(spied.method).toHaveBeenCalled()
```

## Test Configuration

```ts
vi.setConfig({
  testTimeout: 10_000,
  hookTimeout: 10_000,
})

vi.resetConfig()
```

## Global Mock Management

```ts
vi.clearAllMocks()   // Clear all mock call history
vi.resetAllMocks()   // Reset + clear implementation
vi.restoreAllMocks() // Restore originals (spies)
```

## vi.mocked Type Helper

TypeScript helper for mocked values:

```ts
import { myFn } from './module'
vi.mock('./module')

// Type as mock
vi.mocked(myFn).mockReturnValue('typed')

// Deep mocking
vi.mocked(myModule, { deep: true })

// Partial mock typing
vi.mocked(fn, { partial: true }).mockResolvedValue({ ok: true })
```

## Key Points

- `vi.mock` is hoisted - use `vi.doMock` for dynamic mocking
- `vi.hoisted` lets you reference variables in mock factories
- Use `vi.spyOn` to spy on existing methods
- Fake timers require explicit setup and teardown
- `vi.waitFor` retries until assertion passes

<!-- 
Source references:
- https://vitest.dev/api/vi.html
-->
