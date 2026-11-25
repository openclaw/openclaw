# Model prompt statistics measurements

Run the size owner with synthetic messages, independently of provider latency:

```sh
node --expose-gc --import ./scripts/tsx.mjs scripts/perf/model-prompt-stats-measure.ts \
  --messages 500 --calls 1000 --ownership mutable
```

Repeat with `--ownership content` and `--ownership message` for immutable payload
roots. Use `--owner <baseline-module>` to compare a preserved owner implementation
with the candidate. That module's imports must resolve to the same dependencies.
Counterbalance launch order and keep allocation profiling separate from
`--mode timing`, which reports CPU, natural GC and event-loop samples without GC
tracing. Every run checks the sizes against native JSON serialization.

For a loaded Gateway, generate separate synthetic fixtures for each build using
`team-shape-fixture.ts`. Enable the bundled `diagnostics-otel` plugin with
`diagnostics.otel.enabled: true`, `traces: true`, and a loopback OTLP collector.
Keep content capture disabled. Traces consume prompt sizes; metrics-only OTel
and Prometheus subscriptions do not request them.

Use `transcript-broadcast-measure.ts --scenario memory-soak` with the built dist
entry, 10,000 fixture sessions, 40 synthetic plugins, `--clients 64 --exact-clients 8`,
concurrent mock turns, `--stress-tools --mixed-rpc --list-filter-churn`,
`--list-interval-ms 2000`, and `--duration-ms 600000 --retained-profile-ms 0 --diagnostics`.
Disabling the retained profile prevents overlapping heap samplers; diagnostics
collects the full-run GC and event-loop measurements. Reserve separate loopback ports
for the Gateway, its adjacent dashboard port, mock provider and collector. For
retained histories, first run the same history options with `--seed-history`;
the measurement must use the same mock-provider port as the seed.

`--dashboard-rpc` optionally adds GitHub and workboard widgets. Report failed
runs separately; if changing the workload, start a fresh matched comparison.

During each run, take matched allocation samples at elapsed minutes three and
seven, using the isolated fixture's configuration and state directory:

```sh
OPENCLAW_STATE_DIR="$STATE" OPENCLAW_CONFIG_PATH="$STATE/openclaw.json" \
  node dist/entry.js gateway call diagnostics.heapProfile --port "$PORT" \
  --timeout 60000 --json \
  --params '{"durationMs":30000,"samplingIntervalBytes":32768,"includeCollected":true}'
```

Report these as two sampled windows within the load run, not continuous
allocation measurement. Keep profiler overhead in the full-run timing/GC
results. The harness's `--allocations` mode also enables V8 GC tracing; use a
separate pass when collecting that mode's promotion measurements. Report tail
sample counts, GC time per minute, main-thread CPU, RSS and heap alongside the
allocation rate and prompt-stat allocation stacks.
