---
name: vite-config
description: Vite configuration patterns using vite.config.ts
---

# Vite Configuration

## Basic Setup

```ts
// vite.config.ts
import { defineConfig } from 'vite'

export default defineConfig({
  // config options
})
```

Vite auto-resolves `vite.config.ts` from project root. Supports ES modules syntax regardless of `package.json` type.

## Conditional Config

Export a function to access command and mode:

```ts
export default defineConfig(({ command, mode, isSsrBuild, isPreview }) => {
  if (command === 'serve') {
    return { /* dev config */ }
  } else {
    return { /* build config */ }
  }
})
```

- `command`: `'serve'` during dev, `'build'` for production
- `mode`: `'development'` or `'production'` (or custom via `--mode`)

## Async Config

```ts
export default defineConfig(async ({ command, mode }) => {
  const data = await fetchSomething()
  return { /* config */ }
})
```

## Using Environment Variables in Config

`.env` files are loaded **after** config resolution. Use `loadEnv` to access them in config:

```ts
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  // Load env files from cwd, include all vars (empty prefix)
  const env = loadEnv(mode, process.cwd(), '')
  
  return {
    define: {
      __APP_ENV__: JSON.stringify(env.APP_ENV),
    },
    server: {
      port: env.APP_PORT ? Number(env.APP_PORT) : 5173,
    },
  }
})
```

## Key Config Options

### resolve.alias

```ts
export default defineConfig({
  resolve: {
    alias: {
      '@': '/src',
      '~': '/src',
    },
  },
})
```

### define (Global Constants)

```ts
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify('1.0.0'),
    __API_URL__: 'window.__backend_api_url',
  },
})
```

Values must be JSON-serializable or single identifiers. Non-strings auto-wrapped with `JSON.stringify`.

### plugins

```ts
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
})
```

Plugins array is flattened; falsy values ignored.

### server.proxy

```ts
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
```

### build.target

Default: Baseline Widely Available browsers. Customize:

```ts
export default defineConfig({
  build: {
    target: 'esnext', // or 'es2020', ['chrome90', 'firefox88']
  },
})
```

## TypeScript Intellisense

For plain JS config files:

```js
/** @type {import('vite').UserConfig} */
export default {
  // ...
}
```

Or use `satisfies`:

```ts
import type { UserConfig } from 'vite'

export default {
  // ...
} satisfies UserConfig
```

<!--
Source references:
- https://vite.dev/config/
- https://vite.dev/guide/
-->
