# Incident Dossier: Blue API DB Replication Failure (2025-12-05)

Distilled from a first-party Notion postmortem. See `notion-postmortem-index.md`.

## Summary

- Service: Blue API read replicas
- Env: prod
- Severity: stale-data incident
- Window: about 4h
- What broke: read replicas stopped replaying WAL after emergency scaling raised
  primary PostgreSQL parameters above replica values.

## Fingerprints

- stale API data, up to 4h old
- replication lag peaked around 28 GB / about 4h
- processor primary hit `too many clients`
- warnings:
  `hot standby is not possible because of insufficient parameter settings`
- log signal:
  `recovery has paused`

## Likely Cause

- Primary:
  `max_connections` and later `max_worker_processes` were lower on replicas than
  primary
- Contributing:
  emergency processor scaling changed primary capacity without replica sync
- Contributing:
  team lacked awareness that several PG params must be `>=` on replicas

## Fix Pattern

- inspect PostgreSQL logs for standby parameter mismatch warnings
- compare primary vs replica values for replication-critical parameters
- raise replica values to match or exceed primary
- verify lag recovery

## Validation

- WAL replay resumes
- replication lag steadily drops
- stale-data symptoms disappear
- `pg_stat_replication` healthy again

## Prevention

- automate primary/replica parameter synchronization
- alert on replay pause and excessive lag
- treat emergency scaling on primary as a replica-compatibility review trigger

## References

- `notion-postmortem-index.md`
