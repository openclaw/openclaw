---
name: vitest-configuration
description: Configure Vitest with vite.config.ts or vitest.config.ts
---

# Configuration

Vitest reads configuration from `vitest.config.ts` or `vite.config.ts`. It shares the same config format as Vite.

## Basic Setup

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // test options
  },
})
```

## Using with Existing Vite Config

Add Vitest types reference and use the `test` property:

```ts
// vite.config.ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
  },
})
```

## Merging Configs

If you have separate config files, use `mergeConfig`:

```ts
// vitest.config.ts
import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: 'jsdom',
  },
}))
```

## Common Options

```ts
defineConfig({
  test: {
    // Enable global APIs (describe, it, expect) without imports
    globals: true,
    
    // Test environment: 'node', 'jsdom', 'happy-dom'
    environment: 'node',
    
    // Setup files to run before each test file
    setupFiles: ['./tests/setup.ts'],
    
    // Include patterns for test files
    include: ['**/*.{test,spec}.{js,ts,jsx,tsx}'],
    
    // Exclude patterns
    exclude: ['**/node_modules/**', '**/dist/**'],
    
    // Test timeout in ms
    testTimeout: 5000,
    
    // Hook timeout in ms
    hookTimeout: 10000,
    
    // Enable watch mode by default
    watch: true,
    
    // Coverage configuration
    coverage: {
      provider: 'v8', // or 'istanbul'
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
    },
    
    // Run tests in isolation (each file in separate process)
    isolate: true,
    
    // Pool for running tests: 'threads', 'forks', 'vmThreads'
    pool: 'threads',
    
    // Number of threads/processes
    poolOptions: {
      threads: {
        maxThreads: 4,
        minThreads: 1,
      },
    },
    
    // Automatically clear mocks between tests
    clearMocks: true,
    
    // Restore mocks between tests
    restoreMocks: true,
    
    // Retry failed tests
    retry: 0,
    
    // Stop after first failure
    bail: 0,
  },
})
```

## Conditional Configuration

Use `mode` or `process.env.VITEST` for test-specific config:

```ts
export default defineConfig(({ mode }) => ({
  plugins: mode === 'test' ? [] : [myPlugin()],
  test: {
    // test options
  },
}))
```

## Projects (Monorepos)

Run different configurations in the same Vitest process:

```ts
defineConfig({
  test: {
    projects: [
      'packages/*',
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'jsdom',
        },
      },
    ],
  },
})
```

## Key Points

- Vitest uses Vite's transformation pipeline - same `resolve.alias`, plugins work
- `vitest.config.ts` takes priority over `vite.config.ts`
- Use `--config` flag to specify a custom config path
- `process.env.VITEST` is set to `true` when running tests
- Test config uses `test` property, rest is Vite config

<!-- 
Source references:
- https://vitest.dev/guide/#configuring-vitest
- https://vitest.dev/config/
-->
