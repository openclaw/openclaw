# Migration Context: Full Digital + CUTMV + Remotion Integration

## Overview

This document records the consolidation of Full Digital and CUTMV infrastructure
into the forked OpenClaw repository, performed on branch
`feature/fd-cutmv-remotion-integration`.

## Source Repositories

| Source | URL | Role |
|--------|-----|------|
| openclaw | https://github.com/datysonjr/openclaw.git | Destination repo (fork of official OpenClaw) |
| FD-Claw | https://github.com/datysonjr/FD-Claw.git | Full Digital / CUTMV infrastructure (Python/FastAPI) |
| my-video | Local: /Users/da/my-video | Remotion engine, brand AI datasets, motion specs |
| remotion | https://github.com/datysonjr/remotion.git | Official Remotion fork (external reference only) |

## Integration Rules

1. OpenClaw remains the runtime base — core files are never overwritten
2. FD-Claw (Python) is integrated as a self-contained subsystem under `fd/`
3. Brand data and datasets are organized under `data/`
4. Remotion engine code becomes a TypeScript package under `packages/remotion-engine/`
5. The upstream Remotion fork stays external (npm dependency, not copied wholesale)
6. All integration is additive and namespaced
7. No blind overwrites of root configuration files

## Key Technical Context

- **OpenClaw**: TypeScript / Node.js / pnpm monorepo (~1M LOC)
- **FD-Claw**: Python 3.11 / FastAPI / SQLite (~62K LOC) — a consumer/orchestrator of OpenClaw
- **my-video**: TypeScript / Remotion 4.0 with custom motion engine + brand AI datasets
- **remotion fork**: Upstream Remotion monorepo (110+ packages) — minimal customization

## Business Context

- Full Digital is the parent creative-tech / automation ecosystem
- CUTMV is a music-video and media automation product
- Remotion is a key part of the content generation and rendering pipeline
- The 3-node cluster (M1 Mac Studio, M4 Mac Mini, i7 MacBook Pro) runs the automation

## Destination Architecture

See ARCHITECTURE_PROPOSAL.md (committed separately) for the full target directory tree.

### New directories added to openclaw (all additive, no collisions):

- `agents/` — 7 FD agent workspaces (SOUL.md files)
- `data/` — brand configs, datasets, motion specs, copy libraries
- `fd/` — self-contained Python infrastructure (FastAPI services, domain models)
- `gateway/` — OpenClaw gateway config and agent bindings
- `config/` — runtime YAML configuration
- `docs/fd/` — FD-Claw documentation (architecture, guides, runbooks)
- `docs/migration/` — migration records (this file)
- `packages/remotion-engine/` — custom Remotion motion engine
- `scripts/fd/` — FD-Claw operational scripts

## What Is NOT Merged

| Item | Reason |
|------|--------|
| remotion fork (entire repo) | Upstream Remotion — use as npm dependency |
| my-video out/ (72M) | Rendered video outputs — build artifacts |
| my-video brand-ai frames/ (327M) | Frame dumps — regenerable |
| my-video node_modules/ | Package dependencies |
| FD-Claw .github/ | OpenClaw has its own CI/CD |
