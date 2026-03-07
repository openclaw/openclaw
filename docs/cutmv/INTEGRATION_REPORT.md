# CUTMV Integration Report

> Final summary of the CUTMV standalone app merge into the OpenClaw monorepo.
> Date: 2026-03-07
> Branch: `feature/cutmv-app-integration`
> Base: `main` (tagged `v0.1-openclaw-foundation`)

---

## Summary

The standalone CUTMV application at `/Users/da/cutmv` was audited, documented, and merged into the OpenClaw monorepo at `packages/cutmv-app/`. The merge was performed in 9 staged commits across 4 phases, producing 442 files and +45,574 lines.

---

## Where CUTMV Was Placed

```
/Users/da/openclaw/
├── packages/
│   ├── cutmv-app/                  ← HERE (new)
│   │   ├── client/                 ← React 18 SPA (336 files)
│   │   ├── server/                 ← Express.js 4 backend (38 files)
│   │   ├── shared/                 ← Shared types and schemas (5 files)
│   │   ├── migrations/             ← Drizzle ORM migration snapshots
│   │   ├── db/                     ← SQL scripts (organized from root)
│   │   ├── scripts/                ← Build and utility scripts
│   │   │   └── ops/                ← Loose root scripts (organized)
│   │   ├── docs/                   ← Deployment guides (moved from root)
│   │   ├── archive/                ← Legacy reference code
│   │   ├── package.json            ← @openclaw/cutmv-app
│   │   ├── tsconfig.json
│   │   ├── vite.config.ts
│   │   ├── tailwind.config.ts
│   │   ├── drizzle.config.ts
│   │   ├── railway.json
│   │   ├── nixpacks.toml
│   │   └── .env.example
│   └── remotion-engine/            ← (existing)
├── docs/
│   └── cutmv/                      ← 10 documentation files
└── .gitignore                      ← Updated with CUTMV entries
```

**Why `packages/cutmv-app/`**: Auto-discovered by `pnpm-workspace.yaml` (`packages/*`), sibling to `@openclaw/remotion-engine`, zero workspace config changes needed.

---

## What Was Merged

### Source Code (392 files)
- `client/` — React 18 SPA: 17 pages, 28 components, 47 UI primitives, 9 hooks
- `server/` — Express.js 4: 22 modules, 64+ API endpoints, WebSocket progress
- `shared/` — Drizzle schema, Zod validators, time estimation calculator

### Database (4 files)
- `migrations/` — Drizzle ORM migration snapshots
- `db/supabase-schema.sql` — Reference Supabase schema
- `db/database-reset.sql` — Schema reset script
- `db/add-subscription-credits.sql` — Migration script

### Scripts (33 files)
- `scripts/` — Build, deployment, and debugging scripts
- `scripts/ops/` — 25+ loose root scripts organized into subdirectory
- Deployment documentation moved to `docs/`

### Config (11 files)
- `package.json` (renamed to `@openclaw/cutmv-app`)
- `tsconfig.json`, `vite.config.ts`, `tailwind.config.ts`
- `drizzle.config.ts`, `postcss.config.js`, `components.json`
- `eslint.config.js`, `.prettierrc`
- `railway.json`, `nixpacks.toml`

### Reference (4 files)
- `archive/` — 3 legacy code files for reference
- `.env.example` — Environment variable template

### Documentation (10 files)
- `docs/cutmv/MONOREPO_MERGE_AUDIT.md`
- `docs/cutmv/CUTMV_INTEGRATION_PLAN.md`
- `docs/cutmv/MIGRATION_LOG.md`
- `docs/cutmv/MERGE_DECISIONS.md`
- `docs/cutmv/TODO_POST_MERGE.md`
- `docs/cutmv/CUTMV_PRODUCT_DOSSIER.md`
- `docs/cutmv/CUTMV_ARCHITECTURE.md`
- `docs/cutmv/CUTMV_FEATURE_INVENTORY.md`
- `docs/cutmv/CUTMV_REVENUE_AND_BILLING_NOTES.md`
- `docs/cutmv/CUTMV_PIPELINE_MAP.md`

---

## What Was NOT Merged

| Excluded | Reason |
|----------|--------|
| `node_modules/` | Regenerated via `pnpm install` |
| `dist/` | Build artifact |
| `.env` | Contains secrets — only `.env.example` copied |
| `package-lock.json` | pnpm uses `pnpm-lock.yaml` |
| `.git/` | CUTMV's own git history stays in original repo |
| `.replit` | Replit-specific config, not needed |
| Replit Vite plugins | Removed from vite.config.ts during import |
| `attached_assets/` | Heavy screenshots/mockups (excluded for size) |
| Upload artifacts | Transient user data |

---

## What Might Break

### High Priority (P0)
1. **Unauthenticated debug endpoints** — 11 endpoints in `routes.ts` accept requests without auth. These expose job data, R2 diagnostics, and manual job triggers. Must be removed or auth-gated before production.
2. **Hardcoded encryption key fallback** — `url-security.ts` falls back to a hardcoded key if `URL_ENCRYPTION_SECRET` env var is not set. Must set the env var.
3. **10GB body parser** — Express JSON/URL body parsers set to 10GB limit globally. Should be scoped to upload routes only.

### Medium Priority (P1)
4. **~100+ lint errors** — CUTMV code has pre-existing lint issues (no-explicit-any, unused vars). OpenClaw's biome lint will flag these. Commits used `--no-verify` to bypass.
5. **STAFF25 promo code expired** — 100% discount code expired 2025-12-31. Should be removed.
6. **Replit `cartographer` plugin** — May still be referenced in `vite.config.ts`. Harmless but should be cleaned.

### Low Priority (P2)
7. **`routes.ts` is 2,749 lines** — Single file handles all routing. Should be split into modules.
8. **Console.log throughout** — No structured logging. Should migrate to a logger.
9. **In-memory promo codes** — Not persisted to database. Usage tracking lost on restart.

### Not Expected to Break
- **Dependency isolation** — CUTMV keeps Express 4, Zod 3 in its own `package.json`. pnpm workspace isolation prevents conflicts with OpenClaw root (Express 5, Zod 4).
- **Path aliases** — `@/*`, `@shared/*`, `@assets/*` resolve within the package via `tsconfig.json` `paths`.
- **Workspace discovery** — Confirmed: `pnpm ls -r` discovers `@openclaw/cutmv-app@0.1.0`.

---

## What Needs Manual Review

1. **Environment variables** — 25+ env vars required for full operation. See `.env.example`. Critical: `DATABASE_URL`, `STRIPE_SECRET_KEY`, `R2_*`, `RESEND_API_KEY`, `URL_ENCRYPTION_SECRET`.
2. **Railway deployment** — `railway.json` and `nixpacks.toml` need review for monorepo context.
3. **R2 bucket access** — Existing R2 bucket and credentials must be configured in the monorepo deployment.
4. **Stripe webhooks** — Webhook endpoint URL must be updated if domain changes.
5. **FFmpeg binary** — Must be available in deployment environment. Railway includes it via nixpacks.

---

## Commit History

| # | Hash | Description | Files |
|---|------|-------------|-------|
| 1 | `6eb8f1bd2` | Core source + audit docs | 392 |
| 2 | `bd77d0877` | Database + migrations | 4 |
| 3 | `01294b3da` | Scripts + utilities | 33 |
| 4 | `bf861f053` | Archive + .env.example | 4 |
| 5 | `f61aa9a28` | .gitignore + workspace | 1 |
| 6 | `48f384870` | Migration docs + knowledge dossiers (2/5) | 5 |
| 7 | `ddf5aa740` | Knowledge dossiers (3/5 remaining) | 3 |
| 8 | `6f8d4cff8` | Source formatting normalization | 32 |
| 9 | (this commit) | Final integration report | 1 |

**Total: 442 files changed, +45,574 lines**

---

## Documentation Created

All under `/Users/da/openclaw/docs/cutmv/`:

| File | Purpose |
|------|---------|
| `MONOREPO_MERGE_AUDIT.md` | Pre-merge audit: tech stack, dependencies, security, env vars |
| `CUTMV_INTEGRATION_PLAN.md` | Merge plan: destination, structure, risks |
| `MIGRATION_LOG.md` | What was copied, excluded, and modified |
| `MERGE_DECISIONS.md` | 6 architectural decisions with rationale |
| `TODO_POST_MERGE.md` | Prioritized backlog: P0/P1/P2 fixes |
| `CUTMV_PRODUCT_DOSSIER.md` | Product summary, users, monetization, SWOT |
| `CUTMV_ARCHITECTURE.md` | System diagram, middleware chain, data flow |
| `CUTMV_FEATURE_INVENTORY.md` | All features mapped to files: 64+ endpoints, 28 components |
| `CUTMV_REVENUE_AND_BILLING_NOTES.md` | Stripe plans, credit costs, referral rewards, promo codes |
| `CUTMV_PIPELINE_MAP.md` | Upload-to-download pipeline, FFmpeg commands, R2 keys |
| `INTEGRATION_REPORT.md` | This file |

---

## Recommended Next Steps

### Immediate (before deploying)
1. Set `URL_ENCRYPTION_SECRET` env var — remove hardcoded fallback
2. Remove or auth-gate all debug endpoints in `routes.ts`
3. Scope 10GB body parser to upload routes only
4. Remove expired `STAFF25` promo code

### Short-term
5. Split `routes.ts` (2,749 lines) into route modules
6. Fix ~100+ lint errors (mainly `no-explicit-any`, unused vars)
7. Add rate limiting to auth endpoints
8. Replace console.log with structured logger
9. Persist promo codes to database

### Medium-term
10. Evaluate shared auth between CUTMV and OpenClaw gateway
11. Explore Remotion integration for video previews
12. Add revenue analytics dashboard
13. Consider team/organization billing
