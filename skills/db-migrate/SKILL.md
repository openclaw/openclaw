---
name: db-migrate
description: "Safely modify the database schema of a running clawy app. Use when: (1) adding, removing, or altering columns in an existing app table, (2) migrating data between schemas, (3) adding new tables to a running app, (4) renaming columns or tables with data preservation, (5) any schema change on an app that already has data. NOT for: initial schema creation during deploy (use app-deploy), debugging (use app-debug), or removing apps (use app-destroy)."
---

# DB Migrate

Safely modify the database schema of a running clawy app. Schema changes on live data need care — backup first, migrate incrementally, always have a rollback plan.

## Principles

- **Always backup before migrating** — a failed migration on live data is unrecoverable without a backup
- **One change at a time** — don't bundle ALTER TABLE statements; if one fails, the others may leave the schema in an inconsistent state
- **Test the migration** — apply to a test copy first when possible
- **Keep init.sql in sync** — after a successful migration, update `~/apps/<app-name>/init.sql` so fresh installs match

## Step 1: Backup

```bash
source ~/.clawy/.secrets/postgres.env
pg_dump -h 127.0.0.1 -U clawy <app-name> > ~/apps/<app-name>/backup_$(date +%Y%m%d_%H%M%S).sql
```

Verify the backup:
```bash
ls -lh ~/apps/<app-name>/backup_*.sql | tail -1
```

## Step 2: Write the Migration

Create a migration file at `~/apps/<app-name>/migrations/<timestamp>_<description>.sql`:

```sql
-- Migration: add_priority_column
-- Date: 2026-04-26
-- Rollback: ALTER TABLE items DROP COLUMN priority;

ALTER TABLE items ADD COLUMN priority INTEGER DEFAULT 0;
```

### Common Migration Patterns

**Add a column:**
```sql
ALTER TABLE <table> ADD COLUMN <column> <type> DEFAULT <value>;
```

**Remove a column:**
```sql
ALTER TABLE <table> DROP COLUMN <column>;
```

**Rename a column:**
```sql
ALTER TABLE <table> RENAME COLUMN <old> TO <new>;
```

**Change a column type:**
```sql
ALTER TABLE <table> ALTER COLUMN <column> TYPE <new_type>;
-- If types are incompatible, add USING:
ALTER TABLE <table> ALTER COLUMN <column> TYPE INTEGER USING <column>::integer;
```

**Add a constraint:**
```sql
ALTER TABLE <table> ADD CONSTRAINT <name> CHECK (<condition>);
```

**Add a new table:**
```sql
CREATE TABLE <table> (
  id SERIAL PRIMARY KEY,
  -- columns
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Data migration:**
```sql
-- Backfill a new column from existing data
UPDATE items SET priority = CASE
  WHEN status = 'urgent' THEN 3
  WHEN status = 'normal' THEN 1
  ELSE 0
END;
```

## Step 3: Apply the Migration

```bash
PGPASSWORD=clawy_db_2026 psql -h 127.0.0.1 -U clawy -d <app-name> -f ~/apps/<app-name>/migrations/<migration-file>.sql
```

**Always use `-h 127.0.0.1`** — bare `psql -U clawy` uses socket peer auth and will fail.

Check the result:
```bash
PGPASSWORD=clawy_db_2026 psql -h 127.0.0.1 -U clawy -d <app-name> -c '\d <table>'
```

## Step 4: Update init.sql

After a successful migration, update `~/apps/<app-name>/init.sql` to reflect the new schema. This ensures:
- Fresh `clawy app create` installs get the latest schema
- Future developers see the current state

## Step 5: Rollback (if needed)

If the migration broke something:

```bash
# Restore from backup (nuclear option)
PGPASSWORD=clawy_db_2026 psql -h 127.0.0.1 -U clawy -d <app-name> -f ~/apps/<app-name>/backup_<timestamp>.sql

# Or run the rollback SQL from the migration file's comment
PGPASSWORD=clawy_db_2026 psql -h 127.0.0.1 -U clawy -d <app-name> -c "ALTER TABLE <table> DROP COLUMN <column>;"
```

## Safety Rules

- **Never DROP a table with data without explicit user confirmation**
- **Never truncate data without explicit user confirmation**
- **Always include a rollback comment in migration files**
- **Test destructive migrations on a copy first:**
  ```bash
  PGPASSWORD=clawy_db_2026 createdb -h 127.0.0.1 -U clawy <app-name>_test
  pg_dump -h 127.0.0.1 -U clawy <app-name> | PGPASSWORD=clawy_db_2026 psql -h 127.0.0.1 -U clawy -d <app-name>_test
  # Apply migration to _test database first
  PGPASSWORD=clawy_db_2026 psql -h 127.0.0.1 -U clawy -d <app-name>_test -f <migration-file>.sql
  ```
- **Drop the test copy when done:**
  ```bash
  PGPASSWORD=clawy_db_2026 psql -h 127.0.0.1 -U clawy -c "DROP DATABASE IF EXISTS \"<app-name>_test\";"
  ```
