# CUTMV Migration Log

## Source
`/Users/da/cutmv` (standalone repo)

## Destination
`/Users/da/openclaw/packages/cutmv-app/`

## Date
2026-03-07

## Commits

| # | Hash | Description | Files |
|---|------|-------------|-------|
| 1 | 6eb8f1bd2 | Core source (client, server, shared) + configs + audit docs | 392 |
| 2 | bd77d0877 | Database migrations + SQL scripts | 4 |
| 3 | 01294b3da | Scripts (organized) + deployment docs | 33 |
| 4 | bf861f053 | Archive + .env.example | 4 |
| 5 | f61aa9a28 | .gitignore + workspace verification | 1 |
| 6 | (this commit) | Migration docs + knowledge extraction | — |

## What Was Copied

| Source Path | Destination | Notes |
|-------------|-------------|-------|
| `client/` | `packages/cutmv-app/client/` | React SPA (as-is) |
| `server/` | `packages/cutmv-app/server/` | Express.js backend (as-is) |
| `shared/` | `packages/cutmv-app/shared/` | Drizzle schema + Zod types |
| `migrations/` | `packages/cutmv-app/migrations/` | Drizzle migration snapshots |
| `archive/` | `packages/cutmv-app/archive/` | Legacy code reference |
| `scripts/` | `packages/cutmv-app/scripts/` | Build tools |
| ~25 root scripts | `packages/cutmv-app/scripts/ops/` | Debug/admin/diagnostic scripts |
| ~7 root .md files | `packages/cutmv-app/docs/` | Deployment guides, changelog |
| 3 root .sql files | `packages/cutmv-app/db/` | Schema reset, credit provisioning |
| Root configs | `packages/cutmv-app/` | package.json, tsconfig, vite, etc. |
| `.env.example` | `packages/cutmv-app/.env.example` | Environment template |

## What Was NOT Copied

| Item | Reason |
|------|--------|
| `node_modules/` | Regenerated via `pnpm install` |
| `dist/` | Build artifact |
| `.env` | Secrets |
| `package-lock.json` | pnpm uses `pnpm-lock.yaml` |
| `.git/` | CUTMV has its own repo history |
| `.replit` | Replit-specific config |
| `.lintstagedrc.json` | Replit-specific pre-commit config |
| `.dockerignore` | Railway uses Nixpacks, not Docker |

## Changes Made During Import

1. `package.json`: Renamed from `rest-express` to `@openclaw/cutmv-app`, version set to `0.1.0`, license changed to `UNLICENSED`
2. `.gitignore`: Added CUTMV-specific ignores to monorepo root
3. Loose root scripts organized into `scripts/ops/`
4. Loose root docs organized into `docs/`
5. Loose root SQL files organized into `db/`
