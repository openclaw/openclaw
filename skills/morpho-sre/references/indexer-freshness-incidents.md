# Recurring Indexer Freshness Incidents

> Loaded on demand from morpho-sre skill. See SKILL.md for hard rules and routing.

Investigation guide for recurring indexer freshness/latency incidents. Start with `references/indexer-freshness-playbook.md` for the detailed playbook. Use `incident-dossier-arbitrum-indexing-throughput-backpressure-2026-03-13.md` as the first prior for repeated Arbitrum freshness alerts.

## Triggers

- Grafana `MorphoIndexerDelay`
- BetterStack `Indexing latency`
- Repeated `indexer-<chain>-morpho-sh` lag alerts
- `check-indexing-latency` / `headBlock` freshness drift

## Alert Consolidation

- Treat Grafana block-gap alerts and BetterStack heartbeat failures as the same incident family when chain + workload match.
- Same workload fires 3+ times in 24h:
  - Stop treating each alert as a fresh transient
  - Answer as one ongoing RCA
  - Lead with `primary trigger`, `local amplifier`, `still-open checks`

## Mandatory Order

1. Compare DB latest block or public `headBlock` against live RPC head
2. Compare processed blocks per window against chain-head growth
3. Check `eth_getLogs` / block-not-found / not-yet-available retries
4. Check eRPC head age / upstream failure rate
5. Check queue / state-materialization backlog
6. Check explicit resources, node pressure, and per-chain overrides

## Required Answer Shape

Reply with conclusions only in ALL communications — no investigation steps, intermediate reasoning, or tool output summaries.

- `primary trigger`
- `local amplifier`
- `monitoring blind spot` when internal lag metrics disagree with DB-vs-RPC freshness
- `still-open checks`

## Anti-Patterns

- Do not keep repeating only `pod healthy`, `0 restarts`, or `same image healthy elsewhere` once those are already established.
- If a human asks `DB or RPC/eRPC or queue/backpressure?`:
  - Answer each checked branch explicitly
  - Say which branch is ruled out, still-open, or leading
  - Do not go silent
- Never leak progress chatter, tool JSON, exec-approval warnings, or command-construction failures into the thread reply.
