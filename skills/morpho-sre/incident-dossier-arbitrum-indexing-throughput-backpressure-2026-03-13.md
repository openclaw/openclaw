# Incident Dossier: Arbitrum Indexing Throughput Backpressure (2026-03-13)

## Summary

- Service: Arbitrum indexing freshness / Blue API Arbitrum reads
- Date: 2026-03-13 to 2026-03-15
- Env: prod
- Severity: high
- What broke: Arbitrum-backed API freshness repeatedly drifted by minutes while the indexer pod stayed healthy
- Customer impact: confirmed. Arbitrum market, vault, balance, and APY reads were intermittently stale
- Detection: Grafana `MorphoIndexerDelay`, BetterStack `Indexing latency`, operator follow-ups in `#public-api-monitoring`
- Resolution status: partial. Repeated self-recovery, no durable fix captured yet

## Fingerprints

- workload: `morpho-prd/indexer-arbitrum-morpho-sh`
- chain: `42161`
- repeated lag: hundreds to ~1300 blocks
- pod health: `Running/Ready`, `0` restarts across repeated incidents
- internal blind spot: internal sqd lag metric could read `0` while DB-vs-live freshness was still minutes behind
- upstream hint: intermittent `eth_getLogs` / `block not found` / `latestBlock not yet available on the node`
- local headroom hint: no explicit CPU / memory requests on the Arbitrum indexer deployment
- queue hint: long-running `create-historical-rewards-state-*` work observed on chain `42161`

## Scope

- Services: Arbitrum indexer, BetterStack `check-indexing-latency`, Arbitrum-backed Blue API reads
- Namespace: `morpho-prd`
- Workloads:
  - `indexer-arbitrum-morpho-sh`
  - 42161 processor / scheduler freshness path
- Dependencies:
  - Arbitrum RPC / eRPC
  - indexer DB write path
  - BullMQ queue / state-materialization jobs

## Data / Freshness Evidence

- DB/public freshness fact: DB latest block or public `headBlock` lagged live RPC by up to `1031` blocks / `257s`
- Throughput fact: one 5m sample showed chain head advancing faster than the indexer processed blocks
- Runtime fact: pod remained healthy with `0` restarts and continued block upserts
- Monitoring fact: internal sqd lag metric under-reported this failure mode

## Likely Cause

- Primary: insufficient steady-state headroom on the Arbitrum freshness path
- Trigger: intermittent RPC/eRPC availability mismatches on `eth_getLogs`
- Contributing:
  - missing Arbitrum-specific resource reservations
  - possible 42161 queue / historical rewards backlog
  - possible DB write / HAProxy pressure
- Ruled out:
  - crashloop
  - broad image-wide regression
  - sustained Arbitrum-wide RPC outage

## Fix

- Immediate mitigation: targeted restart only if lag stops shrinking
- Safer durable fix:
  - add explicit Arbitrum indexer resources
  - inspect 42161 queue backlog and processor/scheduler headroom
  - confirm DB write-path pressure
- Rollback:
  - revert per-chain resource override or deployment values change

## Follow-up Tracking

- Bot-side follow-up ticket: `PLA-822`
- Durable infra follow-up: not opened in this dossier yet; keep open until headroom vs queue vs DB owner is assigned
- Temporary mitigation in use: watch catch-up slope; restart only if lag stops shrinking

## Validation

- DB/public head within `30s` of live RPC
- processed blocks per window consistently exceed head growth
- no repeat `IndexerDelay` / `Indexing latency` alerts for 24h
- internal lag metric agrees with DB-vs-RPC freshness

## Pattern Match

- same workload re-fires 3+ times in 24h
- pod stays `Running/Ready` with `0` restarts
- DB/public head is minutes behind live RPC
- internal sqd lag metric disagrees or reads `0`
- `eth_getLogs` availability retries appear without a sustained RPC failure spike
- no explicit Arbitrum-specific headroom override is present

## Prevention

- treat repeated 42161 freshness alerts as one recurring RCA
- compare Grafana block-gap and BetterStack heartbeat together
- surface monitoring blind spots explicitly
- check queue/headroom before concluding `transient backlog`

## References

- Slack: `#public-api-monitoring` recurring Arbitrum freshness threads, March 13-15, 2026
- Related code:
  - `morpho-api/apps/processor/src/jobs/monitoring/monitoring-job.processor.ts`
  - `morpho-api/apps/scheduler/src/jobs/vault-v2s/vault-v2-job.service.ts`
  - `morpho-infra-helm/environments/prd/morpho-indexing/values.yaml`
