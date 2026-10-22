# Metric store allocation measurement

Run on an approved benchmark host from the repository root:

```sh
node --expose-gc --import ./scripts/tsx.mjs \
  extensions/diagnostics-prometheus/src/metric-store.benchmark.test-support.ts \
  --iterations 100000 --start-at <future-epoch-ms> --output /path/to/result.json
```

The three warm allocation phases measure counter/gauge/histogram observations with fresh,
alternately ordered labels, the real worker-request recorder, and rendering a
fixed scrape with escaped labels. V8 allocation sampling includes objects
collected by minor and major GC at a 4 KiB interval. Results contain allocated
bytes per operation, process CPU, elapsed time, and observed GC. The JSON file
also includes the fixed scrape digest; `<output>.prom` holds its exact bytes for
`cmp` between revisions. A fourth phase records post-GC retained heap for a
2,048-series mixed fixture with optional label shapes, then resets the same
strongly reachable store and records the remaining heap delta.

Compare baseline and candidate under the host's exclusive measurement lock with
separate source directories and the same `--start-at`. Each phase starts 15
seconds after the previous scheduled phase; missing a start fails the run. Run
at least five concurrent pairs on separate 16-core halves, swapping CPU halves
between pairs. Record outside CPU load and compare candidate-minus-baseline
within each pair. This measures the plugin store and recorder, not Gateway
throughput or the diagnostics dispatcher.
