---
name: mocking
description: Mock functions, modules, timers, and dates with vi utilities
---

# Mocking

## Mock Functions

```ts
import { expect, vi } from 'vitest'

// Create mock function
const fn = vi.fn()
fn('hello')

expect(fn).toHaveBeenCalled()
expect(fn).toHaveBeenCalledWith('hello')

// With implementation
const add = vi.fn((a, b) => a + b)
expect(add(1, 2)).toBe(3)

// Mock return values
fn.mockReturnValue(42)
fn.mockReturnValueOnce(1).mockReturnValueOnce(2)
fn.mockResolvedValue({ data: true })
fn.mockRejectedValue(new Error('fail'))

// Mock implementation
fn.mockImplementation((x) => x * 2)
fn.mockImplementationOnce(() => 'first call')
```

## Spying on Objects

```ts
const cart = {
  getTotal: () => 100,
}

const spy = vi.spyOn(cart, 'getTotal')
cart.getTotal()

expect(spy).toHaveBeenCalled()

// Mock implementation
spy.mockReturnValue(200)
expect(cart.getTotal()).toBe(200)

// Restore original
spy.mockRestore()
```

## Module Mocking

```ts
// vi.mock is hoisted to top of file
vi.mock('./api', () => ({
  fetchUser: vi.fn(() => ({ id: 1, name: 'Mock' })),
}))

import { fetchUser } from './api'

test('mocked module', () => {
  expect(fetchUser()).toEqual({ id: 1, name: 'Mock' })
})
```

### Partial Mock

```ts
vi.mock('./utils', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    specificFunction: vi.fn(),
  }
})
```

### Auto-mock with Spy

```ts
// Keep implementation but spy on calls
vi.mock('./calculator', { spy: true })

import { add } from './calculator'

test('spy on module', () => {
  const result = add(1, 2) // Real implementation
  expect(result).toBe(3)
  expect(add).toHaveBeenCalledWith(1, 2)
})
```

### Manual Mocks (__mocks__)

```
src/
  __mocks__/
    axios.ts      # Mocks 'axios'
  api/
    __mocks__/
      client.ts   # Mocks './client'
    client.ts
```

```ts
// Just call vi.mock with no factory
vi.mock('axios')
vi.mock('./api/client')
```

## Dynamic Mocking (vi.doMock)

Not hoisted - use for dynamic imports:

```ts
test('dynamic mock', async () => {
  vi.doMock('./config', () => ({
    apiUrl: 'http://test.local',
  }))
  
  const { apiUrl } = await import('./config')
  expect(apiUrl).toBe('http://test.local')
  
  vi.doUnmock('./config')
})
```

## Mock Timers

```ts
import { afterEach, beforeEach, vi } from 'vitest'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

test('timers', () => {
  const fn = vi.fn()
  setTimeout(fn, 1000)
  
  expect(fn).not.toHaveBeenCalled()
  
  vi.advanceTimersByTime(1000)
  expect(fn).toHaveBeenCalled()
})

// Other timer methods
vi.runAllTimers()           // Run all pending timers
vi.runOnlyPendingTimers()   // Run only currently pending
vi.advanceTimersToNextTimer() // Advance to next timer
```

### Async Timer Methods

```ts
test('async timers', async () => {
  vi.useFakeTimers()
  
  let resolved = false
  setTimeout(() => Promise.resolve().then(() => { resolved = true }), 100)
  
  await vi.advanceTimersByTimeAsync(100)
  expect(resolved).toBe(true)
})
```

## Mock Dates

```ts
vi.setSystemTime(new Date('2024-01-01'))
expect(new Date().getFullYear()).toBe(2024)

vi.useRealTimers() // Restore
```

## Mock Globals

```ts
vi.stubGlobal('fetch', vi.fn(() => 
  Promise.resolve({ json: () => ({ data: 'mock' }) })
))

// Restore
vi.unstubAllGlobals()
```

## Mock Environment Variables

```ts
vi.stubEnv('API_KEY', 'test-key')
expect(import.meta.env.API_KEY).toBe('test-key')

// Restore
vi.unstubAllEnvs()
```

## Clearing Mocks

```ts
const fn = vi.fn()
fn()

fn.mockClear()       // Clear call history
fn.mockReset()       // Clear history + implementation
fn.mockRestore()     // Restore original (for spies)

// Global
vi.clearAllMocks()
vi.resetAllMocks()
vi.restoreAllMocks()
```

## Config Auto-Reset

```ts
// vitest.config.ts
defineConfig({
  test: {
    clearMocks: true,    // Clear before each test
    mockReset: true,     // Reset before each test
    restoreMocks: true,  // Restore after each test
    unstubEnvs: true,    // Restore env vars
    unstubGlobals: true, // Restore globals
  },
})
```

## Hoisted Variables for Mocks

```ts
const mockFn = vi.hoisted(() => vi.fn())

vi.mock('./module', () => ({
  getData: mockFn,
}))

import { getData } from './module'

test('hoisted mock', () => {
  mockFn.mockReturnValue('test')
  expect(getData()).toBe('test')
})
```

## Key Points

- `vi.mock` is hoisted - called before imports
- Use `vi.doMock` for dynamic, non-hoisted mocking
- Always restore mocks to avoid test pollution
- Use `{ spy: true }` to keep implementation but track calls
- `vi.hoisted` lets you reference variables in mock factories

<!-- 
Source references:
- https://vitest.dev/guide/mocking.html
- https://vitest.dev/api/vi.html
-->
