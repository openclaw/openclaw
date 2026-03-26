---
name: vite-features
description: Vite-specific import patterns and runtime features
---

# Vite Features

## Glob Import

Import multiple modules matching a pattern:

```ts
const modules = import.meta.glob('./dir/*.ts')
// { './dir/foo.ts': () => import('./dir/foo.ts'), ... }

for (const path in modules) {
  modules[path]().then((mod) => {
    console.log(path, mod)
  })
}
```

### Eager Loading

```ts
const modules = import.meta.glob('./dir/*.ts', { eager: true })
// Modules loaded immediately, no dynamic import
```

### Named Imports

```ts
const modules = import.meta.glob('./dir/*.ts', { import: 'setup' })
// Only imports the 'setup' export from each module

const defaults = import.meta.glob('./dir/*.ts', { import: 'default', eager: true })
```

### Multiple Patterns

```ts
const modules = import.meta.glob(['./dir/*.ts', './another/*.ts'])
```

### Negative Patterns

```ts
const modules = import.meta.glob(['./dir/*.ts', '!**/ignored.ts'])
```

### Custom Queries

```ts
const svgRaw = import.meta.glob('./icons/*.svg', { query: '?raw', import: 'default' })
const svgUrls = import.meta.glob('./icons/*.svg', { query: '?url', import: 'default' })
```

## Asset Import Queries

### URL Import

```ts
import imgUrl from './img.png'
// Returns resolved URL: '/src/img.png' (dev) or '/assets/img.2d8efhg.png' (build)
```

### Explicit URL

```ts
import workletUrl from './worklet.js?url'
```

### Raw String

```ts
import shaderCode from './shader.glsl?raw'
```

### Inline/No-Inline

```ts
import inlined from './small.png?inline'    // Force base64 inline
import notInlined from './large.png?no-inline'  // Force separate file
```

### Web Workers

```ts
import Worker from './worker.ts?worker'
const worker = new Worker()

// Or inline:
import InlineWorker from './worker.ts?worker&inline'
```

Preferred pattern using constructor:

```ts
const worker = new Worker(new URL('./worker.ts', import.meta.url), {
  type: 'module',
})
```

## Environment Variables

### Built-in Constants

```ts
import.meta.env.MODE      // 'development' | 'production' | custom
import.meta.env.BASE_URL  // Base URL from config
import.meta.env.PROD      // true in production
import.meta.env.DEV       // true in development
import.meta.env.SSR       // true when running in server
```

### Custom Variables

Only `VITE_` prefixed vars exposed to client:

```
# .env
VITE_API_URL=https://api.example.com
DB_PASSWORD=secret  # NOT exposed to client
```

```ts
console.log(import.meta.env.VITE_API_URL) // works
console.log(import.meta.env.DB_PASSWORD)  // undefined
```

### Mode-specific Files

```
.env                # always loaded
.env.local          # always loaded, gitignored
.env.[mode]         # only in specified mode
.env.[mode].local   # only in specified mode, gitignored
```

### TypeScript Support

```ts
// vite-env.d.ts
interface ImportMetaEnv {
  readonly VITE_API_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
```

### HTML Replacement

```html
<p>Running in %MODE%</p>
<script>window.API = "%VITE_API_URL%"</script>
```

## CSS Modules

Any `.module.css` file treated as CSS module:

```ts
import styles from './component.module.css'
element.className = styles.button
```

With camelCase conversion:

```ts
// .my-class -> myClass (if css.modules.localsConvention configured)
import { myClass } from './component.module.css'
```

## JSON Import

```ts
import pkg from './package.json'
import { version } from './package.json'  // Named import with tree-shaking
```

## HMR API

```ts
if (import.meta.hot) {
  import.meta.hot.accept((newModule) => {
    // Handle update
  })
  
  import.meta.hot.dispose((data) => {
    // Cleanup before module is replaced
  })
  
  import.meta.hot.invalidate()  // Force full reload
}
```

<!--
Source references:
- https://vite.dev/guide/features
- https://vite.dev/guide/env-and-mode
- https://vite.dev/guide/assets
- https://vite.dev/guide/api-hmr
-->
