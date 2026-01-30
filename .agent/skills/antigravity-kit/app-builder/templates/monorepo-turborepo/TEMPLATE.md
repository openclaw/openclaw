---
name: monorepo-turborepo
description: Turborepo monorepo template principles. pnpm workspaces, shared packages.
---

# Turborepo Monorepo Template

## Tech Stack

| Component | Technology |
|-----------|------------|
| Build System | Turborepo |
| Package Manager | pnpm |
| Apps | Next.js, Express |
| Packages | Shared UI, Config, Types |
| Language | TypeScript |

---

## Directory Structure

```
project-name/
├── apps/
│   ├── web/             # Next.js app
│   ├── api/             # Express API
│   └── docs/            # Documentation
├── packages/
│   ├── ui/              # Shared components
│   ├── config/          # ESLint, TS, Tailwind
│   ├── types/           # Shared types
│   └── utils/           # Shared utilities
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

---

## Key Concepts

| Concept | Description |
|---------|-------------|
| Workspaces | pnpm-workspace.yaml |
| Pipeline | turbo.json task graph |
| Caching | Remote/local task caching |
| Dependencies | `workspace:*` protocol |

---

## Turbo Pipeline

| Task | Depends On |
|------|------------|
| build | ^build (dependencies first) |
| dev | cache: false, persistent |
| lint | ^build |
| test | ^build |

---

## Setup Steps

1. Create root directory
2. `pnpm init`
3. Create pnpm-workspace.yaml
4. Create turbo.json
5. Add apps and packages
6. `pnpm install`
7. `pnpm dev`

---

## Common Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Run all apps |
| `pnpm build` | Build all |
| `pnpm --filter @name/web dev` | Run specific app |
| `pnpm --filter @name/web add axios` | Add dep to app |

---

## Best Practices

- Shared configs in packages/config
- Shared types in packages/types
- Internal packages with `workspace:*`
- Use Turbo remote caching for CI
