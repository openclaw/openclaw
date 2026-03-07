# Integration Status — FD / CUTMV / Remotion

Branch: `feature/fd-cutmv-remotion-integration`
Date: 2026-03-07
Commits: 13 | Files: 1,055 | Lines: +156,023

---

## What Was Imported

| Source | Destination | Files | Description |
|--------|-------------|-------|-------------|
| `docs/fd/`, `agents/`, `fd/workspace/` | Same paths | ~180 | Documentation, agent workspaces, knowledge base |
| `FD-Claw/data/` | `data/brands/`, `data/datasets/` | ~95 | Brand assets, motion specs, copy datasets, schemas |
| `FD-Claw/scripts/` | `scripts/fd/` | ~20 | Cluster ops, healthcheck, failover, bootstrap |
| `FD-Claw/gateway/`, `config/fd/` | Same paths | ~10 | Gateway config, runtime YAML |
| `my-video/` | `packages/remotion-engine/` | 114 | Remotion video engine (src, scripts, tools, public assets) |
| `FD-Claw/` | `fd/` | 533 | Python subsystem (packages, services, tests, migrations) |

## What Is Working

- **pnpm workspace discovery**: `@openclaw/remotion-engine@0.1.0` is discovered and listed by `pnpm ls -r`
- **Remotion path wiring**: All 20 files rewired from old `brands/cutmv/` paths to `data/datasets/cutmv/`. Zero old path references remain.
- **Composition generator**: `npx tsx tools/generate-compositions.ts` successfully generates 55 compositions with correct paths
- **FD Docker context**: Dockerfile, docker-compose.yml, and Makefile all use repo-root context correctly
- **Data layer**: 56 motion specs, 25 brand assets, 14 copy datasets all committed and addressable
- **Secret scan**: No API keys, tokens, or credentials in tracked files
- **.gitignore coverage**: fd/.venv, fd/data/*.db, remotion out/, __pycache__, .pyc, .DS_Store, *.egg-info all excluded

## What Needs Manual Setup

### Python 3.11+ (required for fd/)
The M1 controller has Python 3.9.6. The FD Python subsystem (`fd/pyproject.toml`) requires `>=3.11`.
```bash
# Install Python 3.11+ (via Homebrew, pyenv, or system package)
brew install python@3.11  # or python@3.12

# Then bootstrap:
cd fd
python3.11 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest -q
```

### Remotion node_modules (required for packages/remotion-engine/)
```bash
cd /path/to/openclaw
corepack pnpm install   # installs all workspace deps including remotion-engine
cd packages/remotion-engine
pnpm studio             # launch Remotion Studio
pnpm lint               # ESLint + TypeScript check
```

### Cluster Nodes
Cluster targets (`claw-m4`, `claw-i7`) have their own git clones. After merging:
```bash
make cluster-update      # git pull + migrate on all nodes
make cluster-status      # verify
```

## Remaining Risks

### 1. Remotion TypeScript compilation (medium)
`pnpm install` + `pnpm lint` in `packages/remotion-engine/` has not been run. May surface:
- Missing type definitions for motion spec JSON imports
- Tailwind CSS 4.0 integration issues with Remotion 4.0.421
- React 19.2.3 type compatibility

### 2. FD Python test suite (medium)
`pytest` has not been run. May surface:
- Import path issues (packages expecting different module structure)
- Missing test fixtures or database seeds
- Dependencies that need system packages (e.g., SQLite headers)

### 3. Docker build (low)
`docker build -f fd/Dockerfile ..` has not been tested. The Dockerfile references:
- `COPY fd/pyproject.toml ./` — should work with repo-root context
- `COPY config/fd/ ./config/` — depends on config/fd/ existing (it does)

### 4. Cluster remote paths (low)
Makefile cluster targets reference `$(REMOTE_APP_DIR)/scripts/remote_bootstrap.sh`. On cluster nodes, the deployment structure may differ from the monorepo layout. These paths are deployment-specific and only matter when running `make cluster-bootstrap` or `make cluster-update`.

### 5. Duplicate workspace docs (informational)
`fd/workspace/` and `docs/fd/` share 2 filenames (README.md, SECURITY.md). These serve different audiences and are not true duplicates, but could cause confusion.

## Branch Commit Log

```
10ef8f6f7 Fix FD runtime paths for monorepo layout
e9a12ba88 Rewire remotion-engine paths to monorepo data/ locations
812e69db7 Add FD Python infrastructure as self-contained subsystem under fd/
0ad1bc76e Add Remotion engine package and missing brand motion specs
c122ae89e Add gateway config and FD runtime YAML configuration
8f68ab18e Add FD-Claw operational scripts under scripts/fd/
1604605bb Scope IDENTITY.md and USER.md gitignore rules to root only
fbceab6ff Add CUTMV brand data, motion specs, copy datasets, and schemas
22b4b26b3 Add Full Digital brand assets and datasets
642cc3de6 Add FD workspace and knowledge base under fd/workspace/
e6321cc01 Add Full Digital and CUTMV agent workspaces
170777513 Add Full Digital / CUTMV documentation layer under docs/fd/
944b9d43d Add migration foundation for FD/CUTMV/Remotion integration
```
