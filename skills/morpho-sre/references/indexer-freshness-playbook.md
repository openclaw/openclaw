# Indexer Freshness Playbook

Use for Grafana `MorphoIndexerDelay`, BetterStack `Indexing latency`, and repeated `indexer-<chain>-morpho-sh` freshness alerts.

## Goal

- Collapse repeated freshness alerts into one RCA.
- Separate `pod healthy` from `data fresh`.
- Distinguish `upstream RPC/eRPC issue` vs `local throughput/backpressure`.

## First Checks

1. DB latest block or public `headBlock` vs live RPC head
2. processed blocks per window vs chain-head growth
3. `eth_getLogs` / `block not found` / `not yet available on the node`
4. eRPC head age / upstream failure rate
5. queue or state-materialization backlog
6. explicit resources, node pressure, per-chain overrides

## Branches

- `DB/public head behind live RPC; pod healthy; RPC failures low`
  - likely local throughput / write-path / queue backlog
- `DB/public head behind live RPC; repeated eth_getLogs availability errors`
  - likely upstream RPC/eRPC trigger
  - still check local amplifier before stopping
- `internal lag metric says 0 but DB/public head is stale`
  - monitoring blind spot; say it explicitly
- `same workload repeats 3+ times in 24h`
  - recurring incident; stop calling it transient unless a new trigger is proven

## Amplifiers To Check

- missing CPU / memory requests or limits
- node near reservation ceiling
- chain-specific overrides missing on a hot chain
- queue fanout or hourly backlog jobs
- DB write latency / HAProxy pressure

## Answer Shape

- `*Incident:*` recurring freshness lag on `<workload>`
- `*Evidence:*` DB/public head vs live RPC, processed-vs-head rate, RPC/eRPC facts, queue/resource facts
- `*Likely cause:*` `primary trigger` + `local amplifier`
- `*Mitigation:*` reversible next step + rollback
- `*Validate:*` freshness under threshold, alert family quiet for 24h
- `*Next:*` one discriminating next check if still open

## Do Not Do

- do not stop at `pod healthy`
- do not treat Grafana and BetterStack as separate incidents when workload matches
- do not leak tool JSON, draft progress, or approval warnings into Slack
