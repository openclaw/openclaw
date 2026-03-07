# CUTMV Integration Plan

## Destination

```
/Users/da/openclaw/packages/cutmv-app/
```

Package name: `@openclaw/cutmv-app`

## Why `packages/cutmv-app/`

1. `packages/*` is already in `pnpm-workspace.yaml` — auto-discovered
2. Sibling to `@openclaw/remotion-engine` — natural workspace dependency
3. `.gitignore` already has `packages/dashboard-next/` patterns
4. Zero workspace config changes needed
5. Self-contained: own package.json, own build system, own dependencies

## Final Structure

```
packages/cutmv-app/
  client/                    # React SPA frontend
    index.html
    public/                  # Static assets
    src/
      pages/                 # Route pages
      components/            # UI components
        ui/                  # shadcn/ui primitives
        referral/            # Referral components
      hooks/                 # Custom hooks
      lib/                   # Utilities
  server/                    # Express.js backend
    index.ts                 # Entry point
    routes.ts                # Main routes (large, split later)
    auth-routes.ts           # Auth endpoints
    auth-service.ts          # Auth logic
    services/                # Business services
    api/                     # API modules
  shared/                    # Shared schemas/types
    schema.ts                # Drizzle schema + Zod validation
  migrations/                # Drizzle migration snapshots
  db/                        # SQL scripts (organized)
  scripts/
    ops/                     # Debug/admin scripts (from root)
  docs/                      # Deployment guides (from root)
  archive/                   # Legacy code reference
  package.json               # @openclaw/cutmv-app
  tsconfig.json              # Path aliases updated
  vite.config.ts             # Vite build config
  tailwind.config.ts
  drizzle.config.ts
  railway.json
  nixpacks.toml
  .env.example
```

## Migration Order

1. Audit docs (this file + MONOREPO_MERGE_AUDIT.md) — before any code changes
2. Core source: client/, server/, shared/ + config files
3. Database: migrations/ + SQL scripts
4. Scripts: organized from root clutter into scripts/ops/
5. Archive + assets: archive/ + .env.example
6. Workspace integration: .gitignore + verification
7. Migration documentation

## Dependency Strategy

CUTMV keeps its own `package.json` with its own dependencies. No merging into root.
This avoids Express 4/5 and Zod 3/4 conflicts entirely.

## Build System

CUTMV keeps its own Vite + esbuild build. No migration to OpenClaw's tsdown.
- `pnpm dev` — Vite dev server (client HMR + Express backend)
- `pnpm build` — Vite client build + esbuild server bundle
- `pnpm start` — `NODE_ENV=production node dist/index.js`

## What Will NOT Be Merged

- `node_modules/` — regenerated
- `dist/` — build artifact
- `.env` — secrets
- `package-lock.json` — pnpm uses pnpm-lock.yaml
- `.git/` — separate repo history
- `.replit` — Replit-specific config
- Replit Vite plugins

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Path aliases break | Medium | Update tsconfig paths during import |
| Express 4 vs 5 | None | Isolated in own package.json |
| Zod 3 vs 4 | None | Isolated in own package.json |
| Debug endpoints exposed | High | Document in TODO_POST_MERGE, fix after |
| Hardcoded encryption key | High | Document, require env var |
| Build system mismatch | Low | CUTMV keeps own Vite build |
| OpenClaw root boot breaks | Low | No root config changes |

## What Already Exists in OpenClaw

CUTMV infrastructure already integrated:
- `packages/remotion-engine/` — Video composition engine
- `data/brands/cutmv/` — Brand identity assets
- `data/datasets/cutmv/` — Motion specs, copy datasets, static assets
- `agents/cutmv-*/` — Agent workspaces (growth, ops, support)
- `gateway/bindings/cutmv.json` — Gateway routing
- `config/fd/` — Runtime YAML with CUTMV config

This merge adds the **application layer** — the actual SaaS product code.
