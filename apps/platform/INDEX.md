# OpenClaw Workspace Index

Last updated: 2026-02-16

## Active Focus

`apps/dashboard/` — Primary dashboard and current working app

## Workspace Map

| Status | Path | What |
| --- | --- | --- |
| ACTIVE | `apps/dashboard/` | Mission Control dashboard (Next.js 16, 46 API routes, 21 views) |
| SUPPORTING | `packages/core/` | Core OpenClaw engine, runtime, plugins, channels |
| SUPPORTING | `packages/agents/` | Agent orchestration (FastAPI backend + React frontend) |

> [!NOTE]
> `apps/dashboard/` is its own git repo (`abdulrahman-gaith-beep/openclaw-mission-control`). It is excluded from the parent `openclaw-platform` via `.gitignore`.

## Root Files

| File | Purpose |
| --- | --- |
| `README.md` | Quick pointer and project overview |
| `INDEX.md` | This workspace index |
| `AUDIT.md` | Full audit & roadmap (architecture, long-running agents) |
| `SECURITY-AUDIT-2026-02-16.md` | Latest security remediation report |
| `.gitignore` | Build artifact and IDE exclusions |

## Key Entry Points

- Dashboard code: `apps/dashboard/src/`
- API routes (46 endpoints): `apps/dashboard/src/app/api/`
- View components (21 views): `apps/dashboard/src/components/views/`
- Library modules (26 files): `apps/dashboard/src/lib/`
- Dashboard page: `apps/dashboard/src/app/page.tsx` (565 LOC)

## Status Legend

- `ACTIVE` — current primary project in active use
- `SUPPORTING` — present and usable, not the current dashboard focus
