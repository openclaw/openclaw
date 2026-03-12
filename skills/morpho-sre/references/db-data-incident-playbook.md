# DB Data Incident Playbook

Use for wrong values, stale values, impossible APYs, missing rows, replica lag, or mixed-read incidents.

## Order

1. Resolve the DB target and routing path.
2. Run one schema check.
3. Run one live business-data query.
4. Run one PostgreSQL internal query pack.
5. Only then inspect deploy/code/math hypotheses.

## Minimum PostgreSQL checks

- `pg_is_in_recovery()`
- replay lag from `pg_last_xact_replay_timestamp()`
- `pg_stat_activity`
- `pg_stat_database_conflicts`
- `pg_stat_statements` when available
- selected `pg_settings`

## Interpretation

- sane historical replay + transient wrong live values usually means read-consistency or routing trouble
- rising `confl_snapshot` means long reads are colliding with replay
- mixed primary/replica pools are unsafe for correctness-sensitive calculations
- if the model changes direction, record the disproved theory explicitly
