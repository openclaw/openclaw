---
name: vite
description: Vite build tool configuration, plugin API, SSR, and Vite 8 Rolldown migration. Use when working with Vite projects, vite.config.ts, Vite plugins, or building libraries/SSR apps with Vite.
metadata:
  author: Anthony Fu
  version: "2026.1.31"
  source: Generated from https://github.com/vitejs/vite, scripts at https://github.com/antfu/skills
---

# Vite

> Based on Vite 8 beta (Rolldown-powered). Vite 8 uses Rolldown bundler and Oxc transformer.

Vite is a next-generation frontend build tool with fast dev server (native ESM + HMR) and optimized production builds.

## Preferences

- Use TypeScript: prefer `vite.config.ts`
- Always use ESM, avoid CommonJS

## Core

| Topic | Description | Reference |
|-------|-------------|-----------|
| Configuration | `vite.config.ts`, `defineConfig`, conditional configs, `loadEnv` | [core-config](references/core-config.md) |
| Features | `import.meta.glob`, asset queries (`?raw`, `?url`), `import.meta.env`, HMR API | [core-features](references/core-features.md) |
| Plugin API | Vite-specific hooks, virtual modules, plugin ordering | [core-plugin-api](references/core-plugin-api.md) |

## Build & SSR

| Topic | Description | Reference |
|-------|-------------|-----------|
| Build & SSR | Library mode, SSR middleware mode, `ssrLoadModule`, JavaScript API | [build-and-ssr](references/build-and-ssr.md) |

## Advanced

| Topic | Description | Reference |
|-------|-------------|-----------|
| Environment API | Vite 6+ multi-environment support, custom runtimes | [environment-api](references/environment-api.md) |
| Rolldown Migration | Vite 8 changes: Rolldown bundler, Oxc transformer, config migration | [rolldown-migration](references/rolldown-migration.md) |

## Quick Reference

### CLI Commands

```bash
vite              # Start dev server
vite build        # Production build
vite preview      # Preview production build
vite build --ssr  # SSR build
```

### Common Config

```ts
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [],
  resolve: { alias: { '@': '/src' } },
  server: { port: 3000, proxy: { '/api': 'http://localhost:8080' } },
  build: { target: 'esnext', outDir: 'dist' },
})
```

### Official Plugins

- `@vitejs/plugin-vue` - Vue 3 SFC support
- `@vitejs/plugin-vue-jsx` - Vue 3 JSX
- `@vitejs/plugin-react` - React with Oxc/Babel
- `@vitejs/plugin-react-swc` - React with SWC
- `@vitejs/plugin-legacy` - Legacy browser support
