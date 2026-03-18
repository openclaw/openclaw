---
name: sre-db-evidence
description: "Use when investigating wrong/stale data values, APY spikes, replica lag, recovery conflicts, pg_stat queries, SQL questions, or any postgres-related issue in Morpho databases. Drives db-evidence.sh and DB-first investigation."
metadata: { "openclaw": { "emoji": "🗄️" } }
---

# SRE DB Evidence

Companion skill to `morpho-sre`. Load `morpho-sre` for hard rules, paths, and knowledge surfaces.

Reply with conclusions only in ALL communications — Slack, DMs, PR comments, Linear comments, every output surface. No investigation steps, intermediate reasoning, or tool output summaries. All investigation work happens silently; only the final summary is sent.

## When to Use

- Wrong or stale data values in API responses
- APY spikes or sign flips
- SQL/table questions
- Replica lag, replay lag, recovery conflicts
- Any prompt mentioning `postgres`, `pg_stat`, `pg_`, `replica`, `query`, or `table`
- DB row counts, listing, filtering requests in Slack threads

## DB-First Mandatory Order

When any trigger above matches, follow this order strictly:

1. Resolve DB target (via `lib-db-target.sh` or `db-evidence.sh`)
2. Schema probe
3. One live data query
4. One PG internal query (`pg_stat_replication`, `pg_stat_activity`, etc.)
5. Only then rank hypotheses or dig through repo/code

Never conclude from replay/code inspection alone when the live DB path has not been checked.

## db-evidence.sh Usage

Path: `/home/node/.openclaw/skills/morpho-sre/scripts/db-evidence.sh`

### Modes

```bash
# Summary: connection info, DB size, table stats, replication status
db-evidence.sh --namespace morpho-prd --target indexer --mode summary

# Schema: column types, indexes, constraints for target tables
db-evidence.sh --namespace morpho-prd --target indexer --mode schema

# Data: sample rows, recent writes, value distributions
db-evidence.sh --namespace morpho-prd --target indexer --mode data

# Replica: replication slots, lag bytes, replay position, recovery conflicts
db-evidence.sh --namespace morpho-prd --target indexer --mode replica
```

### Common Targets

- `indexer` -- Morpho Blue indexer DB
- `blue-api` -- Blue API application DB
- Use `--target <name>` where `<name>` matches the workload/service name in the namespace

## lib-db-target.sh

Path: `/home/node/.openclaw/skills/morpho-sre/scripts/lib-db-target.sh`

Resolves DB connection parameters from Kubernetes secrets for a given namespace and target. Used internally by `db-evidence.sh` but can be sourced directly for ad hoc queries:

```bash
# Source the library to get DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
. /home/node/.openclaw/skills/morpho-sre/scripts/lib-db-target.sh
resolve_db_target --namespace morpho-prd --target indexer
```

## DB Query Guardrail (Slack Threads)

For any Slack request about DB rows/counts/listing/filtering, stale/wrong data, APY spikes, replica lag, recovery conflicts, `pg_stat*`, or SQL:

- Run one successful schema check
- Run one successful data query
- Run one successful PG internal query
- No SQL-only conceptual replies

Preferred path: use `db-evidence.sh`; use ad hoc SQL only when the wrapper cannot express the needed query.

### Mandatory Response Evidence Line

Every DB-related reply must include:

```
db=<host:port/dbname> schema_check=<ok|failed> query_check=<ok|failed> rows=<n>
```

### If Live Query Cannot Run

- Include exact failing command + exact error text
- Include next unblock step
- Never claim "no DB access" without attempting connectivity + credential lookup

## Required Answer Evidence

Every DB investigation reply must include:

- The `evidence_line` (host:port/dbname, schema check, query check, row count)
- One business-data fact (actual value from the DB that answers the question)
- One PG-internal fact (replication lag, active queries, lock contention, etc.)

## Prior-Incident Guardrail

- Use similar incident dossiers as priors only
- Do not collapse immediately to the last known root cause
- Keep at least two live alternatives in play until evidence narrows them
- For APY/wrong-value incidents, consider: formula, cache, presentation, price/rewards, and routing/data-consistency until checked

## In-Cluster Preference

- Use `db-evidence.sh` before Vault or ad hoc `kubectl` secret reads
- If the DB secret resolves to a short service host, prefer the namespace-qualified host returned by the helper
- If `kubectl` inside the pod is broken because of a copied kubeconfig, ignore that kubeconfig and use serviceaccount auth

## Detailed Playbook

See `morpho-sre/references/db-first-incidents.md` for the full DB-first incident playbook including:

- Target resolution logic
- Secret extraction patterns
- Common PG diagnostic queries
- Replication troubleshooting steps
- Data consistency checks

Also see `morpho-sre/references/db-data-incident-playbook.md` for stale/wrong-value, replica, replay-lag, and read-consistency incident patterns.
