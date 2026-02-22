# Runbook: SQLite Migration Operations

## Purpose
Apply additive schema changes safely with rollback guidance.

## Preconditions
1. Migration is additive-only.
2. Backup completed before production apply.
3. Migration id is unique and ordered.

## Backup
1. Stop write-heavy operations.
2. Backup DB files:
   - `cp data/mission-control.db data/mission-control.db.bak.$(date +%Y%m%d%H%M%S)`

## Apply
1. Deploy build containing migration runner.
2. Start app once to trigger startup migrations.
3. Validate:
   - required columns/indexes exist
   - `schema_migrations` contains new migration id

## Rollback strategy
- Prefer application rollback + DB restore from backup when migration impact is non-trivial.
- For additive-only non-destructive migrations, rollback often means:
  1. revert app code to prior version
  2. keep added columns unused until follow-up cleanup

## Verification
1. `npm run test:api-contract`
2. Task/missions read + create + update sanity checks
3. `npm run test:chat-e2e` for chat persistence compatibility
