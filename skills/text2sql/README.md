# Text2SQL skill

Read-only natural-language queries over a PostgreSQL database.

## Where to put DB config (same as other OpenClaw skills)

The script reads **`DATABASE_URL`** from the environment. Store it the same way as other skills:

| How you run it                             | Where to set `DATABASE_URL`                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| **OpenClaw agent (skill runs the script)** | **`~/.openclaw/openclaw.json`** under `skills.entries.text2sql.env.DATABASE_URL` (recommended; keeps credentials out of the repo). |
| **Or**                                     | **`~/.openclaw/.env`** — add a line `DATABASE_URL=postgresql://...` so the gateway has it.                                         |
| **CLI from repo (you testing)**            | Export in the same terminal, or a `.env` in the repo root and load it (see Testing below).                                         |

Example in `~/.openclaw/openclaw.json`:

```json5
{
  skills: {
    entries: {
      text2sql: {
        enabled: true,
        env: {
          DATABASE_URL: "postgresql://user:password@host:5432/dbname",
        },
      },
    },
  },
}
```

The script does **not** load `.env` itself; the process that runs the script must have `DATABASE_URL` in its environment.

## Setup

1. **Set `DATABASE_URL`** (see table above). Example value:

   ```bash
   export DATABASE_URL="postgresql://user:password@host:5432/dbname"
   ```

2. **Use a read-only user (recommended):** Create a PostgreSQL role with only `SELECT` (and `USAGE` on the schema) so the database itself rejects any write. Example:

   ```sql
   CREATE ROLE read_only_user LOGIN PASSWORD '...';
   GRANT USAGE ON SCHEMA public TO read_only_user;
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO read_only_user;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO read_only_user;
   ```

   Then set `DATABASE_URL` to use `read_only_user`. The script also rejects non-SELECT SQL before sending it to the DB.

## Testing (CLI from repo)

From the repo root, with `DATABASE_URL` set in the same shell:

```bash
# Option A: export in this terminal
export DATABASE_URL="postgresql://user:password@host:5432/dbname"

# Option B: use a .env file in repo root (do not commit it)
# echo 'DATABASE_URL=postgresql://user:password@host:5432/dbname' > .env
# Then load and run (bash/zsh):
# set -a && source .env && set +a

# List tables
node --import tsx skills/text2sql/scripts/query.ts list_tables

# Table schema (replace my_table with a real table name from list_tables)
node --import tsx skills/text2sql/scripts/query.ts schema --table my_table

# One sample row
node --import tsx skills/text2sql/scripts/query.ts sample --table my_table

# Run a SELECT (output CSV)
node --import tsx skills/text2sql/scripts/query.ts query --sql "SELECT id, name FROM my_table LIMIT 10"
```

If `bun` is on your PATH you can replace `node --import tsx` with `bun`. If you use a `.env` file, add `.env` to `.gitignore` so you do not commit secrets.
