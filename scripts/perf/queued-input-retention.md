# Queued-input retention

Use an already-built isolated Gateway and synthetic state. This diagnostic drives
four sessions concurrently, holds each primary mock-provider turn, queues one
followup and two steering inputs per session, and verifies terminal completion
and exactly-once transcript consumption. Primary turns execute a tool call.

Run from the tooling checkout against the base build, then the candidate build.
Use a fresh state directory and unused loopback ports >= 40000 for every run.
For N use `rounds=10`; for 2N use `rounds=20`. The harness also performs one warmup
round: there are 132 and 252 queued inputs respectively, and 176 and 336 total
primary/queued inputs including warmup.

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer # macOS only
state="$PWD/.local/queued-retention/base-n"
entry="/absolute/path/to/base/dist/entry.js"
rounds=10
port=43131
mock_port=43132

node --import ./scripts/tsx.mjs scripts/perf/team-shape-fixture.ts \
  --state-dir "$state" --sessions 100 --runs 0 --approvals 0 --cron 0 \
  --projects 1 --transcript-mib 1 --port "$port"

node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
  --state-dir "$state" --entry "$entry" --port "$port" --mock-port "$mock_port" \
  --scenario chat.send --clients 4 --runs 4 --sessions 100 --plugins 0 \
  --rounds "$rounds" --duration-ms 1 --warmup-ms 0 --round-interval-ms 1 \
  --chunks 1 --chunk-interval-ms 1 --prompt-kib 8 --retained-profile-ms 0 \
  --reset-every-rounds 0 --diagnostics --stress-tools --chat-active-hold-ms 250 \
  --gateway-preload "$PWD/scripts/perf/queued-input-retention-preload.mjs"
```

`controller-census.jsonl` observes the actual built controller singleton. At
settlement, effects, operations, mailbox entries, and claims should all be zero.
Dedupe records intentionally remain for five minutes. Compare their representation:
`consumed` means they retain the old input object; `identity-only` means only the
immutable dedupe identity remains. The TTL and record count must stay unchanged.

`queued-settled.heapsnapshot` is a standard V8 snapshot taken after all verified
rounds. `queued-settled-memory.json` reports post-snapshot heap/RSS and capture
time. Inspect snapshots locally. Count admitted objects by their
`operationalRunInstance` property plus the `gatewayContextBindingOwner` symbol;
count binding slots by that symbol edge, and effects by `phase`, `handoffs`,
`validated`, and `ref`. Count `resolveReader`, `get key`, and `isActive` closures
separately. Follow strong retainers, excluding weak edges, from a completed
admitted object to the root; the old dedupe path passes through
`sessionControllers → mailbox.recentSources → input`.

Compare the N→2N retained-object slope on each revision. Transcript and other
legitimate history growth can increase total heap, so report heap alongside
object counts and retainer paths. This is focused lifecycle proof, not a
Team-shaped throughput comparison. The `chat.send` harness uses one observing
WebSocket client; snapshot/GC pauses contaminate its timing diagnostics. Use the
canonical Team-shaped stress harness separately when whole-Gateway timing is
required. Keep each run shorter than the dedupe TTL, or record expirations rather
than attributing them to the fix.
