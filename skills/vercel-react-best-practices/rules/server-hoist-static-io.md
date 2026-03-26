---
title: Hoist Static I/O to Module Level
impact: HIGH
impactDescription: avoids repeated file/network I/O per request
tags: server, io, performance, next.js, route-handlers, og-image
---

## Hoist Static I/O to Module Level

**Impact: HIGH (avoids repeated file/network I/O per request)**

When loading static assets (fonts, logos, images, config files) in route handlers or server functions, hoist the I/O operation to module level. Module-level code runs once when the module is first imported, not on every request. This eliminates redundant file system reads or network fetches that would otherwise run on every invocation.

**Incorrect: reads font file on every request**

```typescript
// app/api/og/route.tsx
import { ImageResponse } from 'next/og'

export async function GET(request: Request) {
  // Runs on EVERY request - expensive!
  const fontData = await fetch(
    new URL('./fonts/Inter.ttf', import.meta.url)
  ).then(res => res.arrayBuffer())

  const logoData = await fetch(
    new URL('./images/logo.png', import.meta.url)
  ).then(res => res.arrayBuffer())

  return new ImageResponse(
    <div style={{ fontFamily: 'Inter' }}>
      <img src={logoData} />
      Hello World
    </div>,
    { fonts: [{ name: 'Inter', data: fontData }] }
  )
}
```

**Correct: loads once at module initialization**

```typescript
// app/api/og/route.tsx
import { ImageResponse } from 'next/og'

// Module-level: runs ONCE when module is first imported
const fontData = fetch(
  new URL('./fonts/Inter.ttf', import.meta.url)
).then(res => res.arrayBuffer())

const logoData = fetch(
  new URL('./images/logo.png', import.meta.url)
).then(res => res.arrayBuffer())

export async function GET(request: Request) {
  // Await the already-started promises
  const [font, logo] = await Promise.all([fontData, logoData])

  return new ImageResponse(
    <div style={{ fontFamily: 'Inter' }}>
      <img src={logo} />
      Hello World
    </div>,
    { fonts: [{ name: 'Inter', data: font }] }
  )
}
```

**Alternative: synchronous file reads with Node.js fs**

```typescript
// app/api/og/route.tsx
import { ImageResponse } from 'next/og'
import { readFileSync } from 'fs'
import { join } from 'path'

// Synchronous read at module level - blocks only during module init
const fontData = readFileSync(
  join(process.cwd(), 'public/fonts/Inter.ttf')
)

const logoData = readFileSync(
  join(process.cwd(), 'public/images/logo.png')
)

export async function GET(request: Request) {
  return new ImageResponse(
    <div style={{ fontFamily: 'Inter' }}>
      <img src={logoData} />
      Hello World
    </div>,
    { fonts: [{ name: 'Inter', data: fontData }] }
  )
}
```

**General Node.js example: loading config or templates**

```typescript
// Incorrect: reads config on every call
export async function processRequest(data: Data) {
  const config = JSON.parse(await fs.readFile("./config.json", "utf-8"));
  const template = await fs.readFile("./template.html", "utf-8");

  return render(template, data, config);
}

// Correct: loads once at module level
const configPromise = fs.readFile("./config.json", "utf-8").then(JSON.parse);
const templatePromise = fs.readFile("./template.html", "utf-8");

export async function processRequest(data: Data) {
  const [config, template] = await Promise.all([configPromise, templatePromise]);

  return render(template, data, config);
}
```

**When to use this pattern:**

- Loading fonts for OG image generation
- Loading static logos, icons, or watermarks
- Reading configuration files that don't change at runtime
- Loading email templates or other static templates
- Any static asset that's the same across all requests

**When NOT to use this pattern:**

- Assets that vary per request or user
- Files that may change during runtime (use caching with TTL instead)
- Large files that would consume too much memory if kept loaded
- Sensitive data that shouldn't persist in memory

**With Vercel's [Fluid Compute](https://vercel.com/docs/fluid-compute):** Module-level caching is especially effective because multiple concurrent requests share the same function instance. The static assets stay loaded in memory across requests without cold start penalties.

**In traditional serverless:** Each cold start re-executes module-level code, but subsequent warm invocations reuse the loaded assets until the instance is recycled.
