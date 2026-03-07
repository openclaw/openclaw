# Notion DB Bootstrap Strategy (OpenClaw)

## Goal

OpenClaw can create required Notion databases under a single known parent page
when missing, then verify schema compliance and heal drift under schema-lock
discipline.

## Parent placement

- Root parent page id is provided via NOTION_PAGE_DB_ROOT_ID.
- Optionally OpenClaw creates a child page:
  "OpenClaw Databases"
  and creates databases under that page for neat organization and future migration.

## Naming conventions

Databases are named:
- "OpenClaw — Skills Backlog"

This enables search + easy export/migration.

## Schema ownership

- DB properties are OpenClaw-owned.
- Humans do not modify schema directly.
- Drift healing only runs when:
  write_lock=false AND allow_schema_writes=true.

## Idempotency

Bootstrap is safe to run multiple times:
- If DB exists, it does nothing.
- If DB missing, it creates it.
- After create, verifier runs to confirm compliance.
