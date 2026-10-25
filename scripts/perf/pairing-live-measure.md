# Pairing live traffic reproduction

This workload uses an isolated Gateway, the bundled iMessage plugin with the existing synthetic bridge, and a real foreground node host with its own synthetic state directory. It never opens a user profile. Output belongs in a task-owned directory on the internal disk; archive only aggregate counts and profiles.

## Acceptance rule (before measurements)

Attribute cold startup separately from a warm 130-second window after the first persisted host-stat sample with one paired node advertising its normal command surface (no command invocation) and eight rejected iMessage direct messages at 15-second intervals. The channel uses `allowlist` policy with a configured synthetic sender distinct from those messages. Count SQL statements, worker requests and runtime main-thread statements with the frozen observer. Count successive persisted node surfaces and pairing revisions as changed or unchanged; never report their contents.

A valid deletion removes one `pairing.allowFrom` request and its SELECT per direct message under open/allowlist policy, while pairing-policy DMs retain their current authorization read. The node heartbeat triplet is retained if its observation timestamp and pairing revision change each minute. Preserve immediate pairing revocation and external-writer visibility; no cache, schema or transaction changes.

The initial attribution is counts only, with per-thread CPU profiles; no latency claim. For a candidate, run three alternating baseline/candidate pairs when the campaign's load/disk gate allows, otherwise one pair with explicit attribution. Compare cold and warm separately: zero new runtime MAIN statements, zero added touched-owner work, identical denied-message outcomes and monotonic heartbeat freshness. Any user-facing latency comparison requires the campaign timing lock, load below 24 and at least five interleaved samples per arm; a 20% regression stops the change.

Run after building the current head with the repository's `qaRuntime` build:

```sh
node --import ./scripts/tsx.mjs scripts/perf/pairing-live-measure.mts \
  --out <internal-task-output> \
  --observer <frozen-harness>/observer.cjs
```
