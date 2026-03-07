# Runbook — FD / CUTMV / Remotion Integration

Quick-reference for developers working with the integrated monorepo.

---

## Repository Layout

```
openclaw/
├── packages/remotion-engine/     # Remotion video engine (TypeScript)
│   ├── src/                      # React components, engine, compositions
│   ├── scripts/                  # Batch spec tools, upgrades, validators
│   ├── tools/                    # generate-compositions.ts, make-variants.ts
│   └── public/cutmv/             # Static assets (fonts, patterns, overlays)
├── fd/                           # FD Python subsystem (fully isolated)
│   ├── packages/                 # Python packages (app, api, db, jobs, llm, ...)
│   ├── services/                 # Service modules (agencyu, pipeline, ...)
│   ├── tests/                    # pytest test suite
│   ├── db/migrations/            # SQLite migration SQL files
│   ├── Dockerfile                # Uses repo-root Docker context
│   ├── docker-compose.yml        # Maps context: .. for config/fd/ access
│   ├── Makefile                  # Local + cluster operations
│   └── pyproject.toml            # Python >=3.11, setuptools
├── data/
│   ├── brands/                   # Brand identity assets (logos, colors, fonts)
│   ├── datasets/cutmv/
│   │   ├── motion/specs/         # 56 motion spec JSON files
│   │   ├── copy/                 # Copy/script datasets
│   │   └── static/               # Static brand assets
│   └── schemas/                  # JSON schemas for validation
├── docs/fd/                      # FD/CUTMV documentation
├── agents/                       # Agent workspaces (fulldigital, cutmv)
├── scripts/fd/                   # Cluster ops scripts
├── gateway/                      # Gateway configuration
└── config/fd/                    # Runtime YAML configuration
```

## Quick Start: Remotion Engine

```bash
# From repo root
corepack pnpm install

# Launch Remotion Studio
cd packages/remotion-engine
pnpm studio

# Regenerate compositions from motion specs
pnpm gen

# Lint + typecheck
pnpm lint

# Validate all specs
pnpm validate
```

### Adding a New Motion Spec

1. Create the spec JSON in `data/datasets/cutmv/motion/specs/`
2. Run `cd packages/remotion-engine && pnpm gen` to regenerate compositions
3. Verify in Remotion Studio: `pnpm studio`

### Path Resolution

All paths from `packages/remotion-engine/` to data files use:
- From package root: `../../data/datasets/cutmv/motion/specs/`
- From `src/`: `../../../data/datasets/cutmv/motion/specs/`
- From `scripts/` (via `__dirname`): `../../../data/datasets/cutmv/motion/specs/`

## Quick Start: FD Python Subsystem

```bash
# Requires Python 3.11+
cd fd
python3.11 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -e ".[dev]"

# Run migrations
make db-init

# Seed data
make seed

# Start dev server
make dev

# Run tests
pytest -q

# Lint
ruff check .
```

### Docker

```bash
# From fd/ directory
make docker-build    # builds with repo-root context
make docker-up       # docker compose up
make docker-down     # stop

# Or manually from repo root
docker build -f fd/Dockerfile -t openclaw-fd:dev .
```

## Cluster Operations

All cluster commands run from `fd/` on the M1 controller (10.0.0.145).

```bash
# Verify SSH to cluster nodes
make cluster-check

# First-time setup (each node needs git clone first)
make cluster-bootstrap

# Update all nodes (git pull + migrate)
make cluster-update

# Service management
make cluster-start     # start app + worker in tmux
make cluster-stop      # stop tmux sessions
make cluster-restart   # stop + start
make cluster-status    # git hash, migrations, service status
make cluster-logs      # tail live logs
```

### Gateway

```bash
make gateway-start     # starts on M4
make gateway-stop
make healthcheck       # full cluster health check
make warm-models       # pre-warm Ollama models
make failover          # check M1, failover to M4 if needed
```

## Key Files Reference

| File | Purpose |
|------|---------|
| `packages/remotion-engine/package.json` | Remotion engine npm package definition |
| `packages/remotion-engine/tools/generate-compositions.ts` | Generates Compositions.generated.tsx from specs |
| `packages/remotion-engine/src/Compositions.generated.tsx` | Auto-generated composition registry (55 entries) |
| `packages/remotion-engine/remotion.config.ts` | Remotion bundler configuration |
| `fd/pyproject.toml` | Python package definition and dependencies |
| `fd/Makefile` | All FD operations (local + cluster) |
| `fd/Dockerfile` | Python app container (repo-root context) |
| `config/fd/settings.yml` | Runtime configuration |
| `data/datasets/cutmv/motion/specs/` | Motion spec JSON files |
| `data/schemas/` | JSON validation schemas |

## Troubleshooting

### "Module not found" in Remotion
- Run `corepack pnpm install` from repo root
- Ensure `pnpm-workspace.yaml` includes `packages/*`

### FD Python import errors
- Ensure you're in the `fd/.venv` virtualenv
- Run `pip install -e "."` to install the package in editable mode
- Check Python version: must be >=3.11

### Docker build fails with "COPY failed"
- Docker context must be the repo root, not `fd/`
- Use `make docker-build` from `fd/` (it passes `..` as context)
- Or: `docker build -f fd/Dockerfile .` from repo root

### Cluster SSH fails
- Verify SSH aliases in `~/.ssh/config`: `claw-m4`, `claw-i7`
- Test: `ssh -o ConnectTimeout=5 claw-m4 'echo OK'`

### Old path references
- Search: `git grep 'brands/cutmv' -- packages/remotion-engine/`
- Should return zero results. If not, run path rewiring again.
