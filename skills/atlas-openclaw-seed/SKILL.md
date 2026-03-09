---
name: atlas-openclaw-seed
description: Seed Atlas from an existing OpenClaw workspace and configure OpenClaw+Atlas to work together. Use when the user asks to bootstrap/seed/index Atlas from OpenClaw MEMORY.md or memory/*.md, ingest OpenClaw contacts, run bootstrap-openclaw-intake, promote OpenClaw memory into Atlas, or set a clean Atlas tools.allow surface in OpenClaw.
---

# Atlas OpenClaw Seed

Seed a fresh Atlas database from an existing OpenClaw workspace (Markdown memory + optional contact ingest), and set OpenClaw’s `tools.allow` to the clean direct Atlas surface.

## Quick start (one command)

Run a dry-run first (default):

```bash
# From the skill directory:
python3 scripts/seed_atlas_from_openclaw.py \
  --space primary \
  --plan-reduction \
  --ingest-contacts
```

Write curated promotions + ingest contacts:

```bash
# From the skill directory:
python3 scripts/seed_atlas_from_openclaw.py \
  --space primary \
  --write \
  --ingest-contacts
```

Notes:

- The script auto-discovers:
  - OpenAtlas install path from `openclaw config get plugins.installs.atlas.installPath`
  - Atlas DB URL from `DATABASE_URL_ATLAS` or `openclaw config get plugins.entries.atlas.config.databaseUrl`
  - OpenClaw workspace root from `openclaw config get agents.defaults.workspace`

## Workflow

### 1) Confirm prerequisites

- Atlas plugin enabled + DB URL set in OpenClaw config.
- A fresh DB is ideal for first seed.

### 2) Seed curated memory + (optional) contacts

Use the wrapper script above.

If you need to run the underlying command directly:

```bash
export DATABASE_URL_ATLAS='<ATLAS_DB_URL>'
cd /ABS/PATH/TO/openatlas
npm run bootstrap-openclaw-intake -- --workspace-root '<OPENCLAW_WORKSPACE_ROOT>' --space primary --write-promotions --ingest-contacts
```

### 3) Configure OpenClaw tool surface (clean direct Atlas surface)

Recommended clean surface is documented in:

- `references/atlas-direct-surface.md`

Operational guidance:

- **Production default:** allow read-only tools.
- **Seeding/verification:** temporarily allow write tools, then revert to read-only.

### 4) Verify

- `atlas_ping`
- `atlas_counts(space="primary")`
- `atlas_tool_catalog(surface="all")`:
  - Confirm required tools exist
  - Confirm the forbidden tools (query/mutate/state/kv/deals/ingest) are **not registered**

### 5) Native memory + Atlas working together (recommended posture)

- Keep **native OpenClaw memory** enabled for broad retrieval over:
  - `memory/` files
  - `sessions` history
- Use **Atlas** for curated durable memory + workflow tasks.

Do **not** bulk-ingest raw chat/session history into Atlas by default. Instead:

- retrieve with native memory
- promote durable items into Atlas (facts/memories/decisions/tasks)

## Automation (recommended)

Create an OpenClaw cron job that seeds Atlas **only if the target space is empty**.

Policy:

- This avoids duplicate writes.
- It makes "new DB" onboarding basically automatic.

Suggested schedule: hourly until seeded, then you can disable the job.

Implementation approach:

- cron job runs `atlas_counts(space="primary")`
- if empty, it runs the seed wrapper with `--write --ingest-contacts`
- if not empty, it outputs `NO_REPLY`
