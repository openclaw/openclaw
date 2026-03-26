---
name: test-environments
description: Configure environments like jsdom, happy-dom for browser APIs
---

# Test Environments

## Available Environments

- `node` (default) - Node.js environment
- `jsdom` - Browser-like with DOM APIs
- `happy-dom` - Faster alternative to jsdom
- `edge-runtime` - Vercel Edge Runtime

## Configuration

```ts
// vitest.config.ts
defineConfig({
  test: {
    environment: 'jsdom',
    
    // Environment-specific options
    environmentOptions: {
      jsdom: {
        url: 'http://localhost',
      },
    },
  },
})
```

## Installing Environment Packages

```bash
# jsdom
npm i -D jsdom

# happy-dom (faster, fewer APIs)
npm i -D happy-dom
```

## Per-File Environment

Use magic comment at top of file:

```ts
// @vitest-environment jsdom

import { expect, test } from 'vitest'

test('DOM test', () => {
  const div = document.createElement('div')
  expect(div).toBeInstanceOf(HTMLDivElement)
})
```

## jsdom Environment

Full browser environment simulation:

```ts
// @vitest-environment jsdom

test('DOM manipulation', () => {
  document.body.innerHTML = '<div id="app"></div>'
  
  const app = document.getElementById('app')
  app.textContent = 'Hello'
  
  expect(app.textContent).toBe('Hello')
})

test('window APIs', () => {
  expect(window.location.href).toBeDefined()
  expect(localStorage).toBeDefined()
})
```

### jsdom Options

```ts
defineConfig({
  test: {
    environmentOptions: {
      jsdom: {
        url: 'http://localhost:3000',
        html: '<!DOCTYPE html><html><body></body></html>',
        userAgent: 'custom-agent',
        resources: 'usable',
      },
    },
  },
})
```

## happy-dom Environment

Faster but fewer APIs:

```ts
// @vitest-environment happy-dom

test('basic DOM', () => {
  const el = document.createElement('div')
  el.className = 'test'
  expect(el.className).toBe('test')
})
```

## Multiple Environments per Project

Use projects for different environments:

```ts
defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'dom',
          include: ['tests/dom/**/*.test.ts'],
          environment: 'jsdom',
        },
      },
    ],
  },
})
```

## Custom Environment

Create custom environment package:

```ts
// vitest-environment-custom/index.ts
import type { Environment } from 'vitest/runtime'

export default <Environment>{
  name: 'custom',
  viteEnvironment: 'ssr', // or 'client'
  
  setup() {
    // Setup global state
    globalThis.myGlobal = 'value'
    
    return {
      teardown() {
        delete globalThis.myGlobal
      },
    }
  },
}
```

Use with:

```ts
defineConfig({
  test: {
    environment: 'custom',
  },
})
```

## Environment with VM

For full isolation:

```ts
export default <Environment>{
  name: 'isolated',
  viteEnvironment: 'ssr',
  
  async setupVM() {
    const vm = await import('node:vm')
    const context = vm.createContext()
    
    return {
      getVmContext() {
        return context
      },
      teardown() {},
    }
  },
  
  setup() {
    return { teardown() {} }
  },
}
```

## Browser Mode (Separate from Environments)

For real browser testing, use Vitest Browser Mode:

```ts
defineConfig({
  test: {
    browser: {
      enabled: true,
      name: 'chromium', // or 'firefox', 'webkit'
      provider: 'playwright',
    },
  },
})
```

## CSS and Assets

In jsdom/happy-dom, configure CSS handling:

```ts
defineConfig({
  test: {
    css: true, // Process CSS
    
    // Or with options
    css: {
      include: /\.module\.css$/,
      modules: {
        classNameStrategy: 'non-scoped',
      },
    },
  },
})
```

## Fixing External Dependencies

If external deps fail with CSS/asset errors:

```ts
defineConfig({
  test: {
    server: {
      deps: {
        inline: ['problematic-package'],
      },
    },
  },
})
```

## Key Points

- Default is `node` - no browser APIs
- Use `jsdom` for full browser simulation
- Use `happy-dom` for faster tests with basic DOM
- Per-file environment via `// @vitest-environment` comment
- Use projects for multiple environment configurations
- Browser Mode is for real browser testing, not environment

<!-- 
Source references:
- https://vitest.dev/guide/environment.html
-->
