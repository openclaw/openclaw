# Durable ingress polling workload

Acceptance registered before measurement:

- Flow: a real isolated Gateway with the bundled iMessage channel, a synthetic
  JSON-RPC bridge, and a local mock model provider. No operator state or services.
- Workload: steady idle, sparse inbound events, delayed retry, and stale-claim
  recovery. Startup is separate from warm steady state.
- Count successful SQL statements, worker requests, and main-thread SQL per minute
  with the frozen campaign observer. Also record ingress-to-delivery latency,
  process CPU, memory, and per-thread CPU profiles.
- Compare baseline and candidate in alternating order, at least five samples per
  arm for timings; report median, p95 and min/max. Keep cold and warm separate.
- Win: idle queue scans and requests approach zero (at most one bounded recovery
  sweep per minute per monitor); fresh admission remains event driven. FIFO,
  at-least-once dispatch, claim-token fencing, delayed retries, and restart recovery
  must remain correct. No added main-thread SQL or warm-turn work.
- Every measured user-facing metric must hold or improve. A 20% regression in any
  timing cell stops acceptance. Timing runs require the campaign timing lock and
  one-minute load below 24; after 60 minutes without qualification, publish count
  and CPU-profile evidence and explicitly leave latency unmeasured.

The implementation must reuse the ingress monitor's durable-admission wake and
retain a bounded slow recovery path. The queue schema and durability are unchanged.
