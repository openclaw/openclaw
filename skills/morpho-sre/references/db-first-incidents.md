# DB-First Data Incidents

> Loaded on demand from morpho-sre skill. See SKILL.md for hard rules and routing.

Combined reference for DB-first data incident investigation and the DB query guardrail enforced in Slack threads. Use this when investigating wrong/stale values, APY spikes, replica lag, or any SQL/table-level ask.

## Triggers

- Wrong values
- Stale values
- APY spikes or sign flips
- SQL/table asks
- Replica lag / replay lag / recovery conflicts
- Prompts mentioning `postgres`, `pg_stat`, `pg_`, `replica`, `query`, or `table`

## Mandatory Order

1. Resolve DB target
2. Schema probe
3. One live data query
4. One PG internal query
5. Only then rank hypotheses or dig through repo/code

## Prior-Incident Guardrail

- Use similar incident dossiers as priors only
- Do not collapse immediately to the last known root cause
- Keep at least two live alternatives in play until evidence narrows them
- For APY/wrong-value incidents, still consider formula, cache, presentation, price/rewards, and routing/data-consistency until checked

## In-Cluster Preference

- Use `db-evidence.sh` before Vault or ad hoc `kubectl` secret reads
- If the DB secret resolves to a short service host, prefer the namespace-qualified host returned by the helper
- If `kubectl` inside the pod is broken because of a copied kubeconfig, ignore that kubeconfig and use serviceaccount auth

## Preferred Collector

```bash
/home/node/.openclaw/skills/morpho-sre/db-evidence.sh \
  --namespace morpho-prd \
  --target indexer \
  --mode summary

/home/node/.openclaw/skills/morpho-sre/db-evidence.sh \
  --namespace morpho-prd \
  --target indexer \
  --mode schema

/home/node/.openclaw/skills/morpho-sre/db-evidence.sh \
  --namespace morpho-prd \
  --target indexer \
  --mode data

/home/node/.openclaw/skills/morpho-sre/db-evidence.sh \
  --namespace morpho-prd \
  --target indexer \
  --mode replica
```

## Required Answer Evidence

- Include the `evidence_line`
- Include one business-data fact
- Include one PG-internal fact
- Do not conclude from replay/code inspection alone when the live DB path has not been checked yet.

## DB Query Guardrail (Slack Threads)

This guardrail applies to any Slack thread request about DB rows/counts/listing/filtering, stale/wrong data, APY spikes, replica lag, recovery conflicts, `pg_stat*`, or SQL.

### Mandatory Checks

- Run one successful schema check
- Run one successful data query
- Run one successful PG internal query
- No SQL-only conceptual replies

### Preferred Path

Use `db-evidence.sh`; use ad hoc SQL only when the wrapper cannot express the needed query.

### Mandatory Response Evidence Line

```
db=<host:port/dbname> schema_check=<ok|failed> query_check=<ok|failed> rows=<n>
```

### If Live Query Cannot Run

- Include exact failing command + exact error text
- Include next unblock step
- Never claim "no DB access" without attempting connectivity + credential lookup
