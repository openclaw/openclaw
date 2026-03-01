---
summary: "Choose between filesystem and PostgreSQL storage for OpenClaw state"
read_when:
  - You are deploying OpenClaw for the first time and need to choose a storage backend
  - You want to move state from the filesystem to a database or vice versa
  - You are running OpenClaw in a containerized or multi-instance environment
title: "Storage Backend"
---

# Storage backend

OpenClaw persists all mutable state (auth profiles, agent data, cron jobs, pairing info, etc.) through a pluggable datastore layer. You choose the backend via the `OPENCLAW_DATASTORE` environment variable.

## Backends

| Backend                  | Value      | Best for                                         |
| ------------------------ | ---------- | ------------------------------------------------ |
| **Filesystem** (default) | `fs`       | Single-machine installs, personal use, macOS app |
| **PostgreSQL**           | `database` | Docker, multi-instance, cloud deployments, VPS   |

<Note>
If `OPENCLAW_DATASTORE` is not set, OpenClaw defaults to filesystem storage. This is the safe, zero-configuration option.
</Note>

## Filesystem (default)

State is stored as JSON files under `~/.openclaw/` (or `$OPENCLAW_STATE_DIR`). No additional setup required.

```bash
# Explicit (same as the default)
export OPENCLAW_DATASTORE=fs
```

## PostgreSQL

State is stored in a `openclaw_kv` table in PostgreSQL. Requires a connection string.

```bash
export OPENCLAW_DATASTORE=database
export OPENCLAW_STATE_DB_URL=postgresql://user:password@host:5432/openclaw
```

<Warning>
Both variables must be set. Setting `OPENCLAW_DATASTORE=database` without `OPENCLAW_STATE_DB_URL` will cause OpenClaw to refuse to start.
</Warning>

OpenClaw automatically creates the required tables on first boot (via migrations). No manual schema setup is needed.

### When to use PostgreSQL

- **Docker / containers**: filesystem state is lost when containers are recreated unless you mount volumes. A database is more natural.
- **Multiple instances**: if you run more than one gateway process, they can share a single database.
- **Cloud deployments**: managed PostgreSQL (RDS, Cloud SQL, Supabase, Neon, etc.) gives you backups, replication, and point-in-time recovery for free.

### Docker Compose example

```yaml
services:
  openclaw:
    image: openclaw/openclaw:latest
    environment:
      OPENCLAW_DATASTORE: database
      OPENCLAW_STATE_DB_URL: postgresql://openclaw:openclaw@postgres:5432/openclaw
    depends_on:
      postgres:
        condition: service_healthy

  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: openclaw
      POSTGRES_PASSWORD: openclaw
      POSTGRES_DB: openclaw
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U openclaw"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  pgdata:
```

## Switching backends (automatic migration)

OpenClaw automatically migrates state when you switch between backends. No manual export/import is needed.

### Filesystem to database (upgrade)

Set `OPENCLAW_DATASTORE=database` and `OPENCLAW_STATE_DB_URL`. On the next startup, OpenClaw will:

1. Scan your `~/.openclaw/` directory for all JSON files
2. Import them into the `openclaw_kv` table (existing DB rows are never overwritten)
3. Write a sentinel key (`_migration/fs-to-db`) to prevent re-running

<Tip>
Your filesystem files are left untouched. If you switch back, they are still there.
</Tip>

### Database to filesystem (downgrade)

Set `OPENCLAW_DATASTORE=fs` (or unset it) while keeping `OPENCLAW_STATE_DB_URL` configured. On the next startup, OpenClaw will:

1. Connect to PostgreSQL and read all state rows
2. Write each row as a JSON file under `~/.openclaw/` (skipping files that already exist)
3. Write a marker file (`.migrated-from-db`) to prevent re-running

Once the downgrade completes, you can safely remove `OPENCLAW_STATE_DB_URL` from your environment.

### Migration safety

- **Idempotent**: migrations only run once per direction (tracked by sentinel key/marker file)
- **Non-destructive**: `ON CONFLICT DO NOTHING` for upgrades, skip-if-exists for downgrades
- **Concurrent-safe**: multiple processes booting simultaneously won't corrupt data

## Environment variable reference

| Variable                | Values                       | Default       | Description                                 |
| ----------------------- | ---------------------------- | ------------- | ------------------------------------------- |
| `OPENCLAW_DATASTORE`    | `fs`, `database` (or `db`)   | `fs`          | Storage backend to use                      |
| `OPENCLAW_STATE_DB_URL` | PostgreSQL connection string | (none)        | Required when `OPENCLAW_DATASTORE=database` |
| `OPENCLAW_STATE_DIR`    | Directory path               | `~/.openclaw` | Where filesystem backend stores state       |
