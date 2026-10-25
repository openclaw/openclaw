# Config watcher recovery measurement

Acceptance rule, registered before measurement:

- Flow: isolated source Gateway, synthetic config and one real WebSocket client,
  driven by `idle-gateway-measure.ts --entry src/entry.ts --minutes 1
  --settle-seconds 3 --config-reloads 0`. No operator state is read.
- Harness repair: three fresh baseline Gateway runs with GC tracing enabled must
  have identical reload counts and zero invalid-execArgv watcher failures. Keep
  cold startup, settling and warm steady counts separate. Verify GC output remains.
- Recovery: force one watcher-worker failure after initial readiness, using a
  benchmark-only preload. Count notifications and reload passes before/after.
  A successful recovery must notify once, and an edit during the outage must be
  adopted by the replacement's initial scan. Preserve bounded retry, polling
  fallback, retirement and shutdown behavior, including one final notification
  when recovery is disabled.
- Metrics: frozen v3.1.4 SQL observer statement/request/MAIN counts per phase and
  per operation; warm MAIN must not increase. The target is two recovery reload
  notifications reduced to one, with the corresponding reload SQL removed.
- Timing is not an acceptance metric for this correctness repair. Count/profile
  runs are exempt from the timing lock; do not infer latency from the loaded host.
  If reporting wall-clock or CPU A/B performance, acquire the timing lock, wait
  for load <24, and use at least five alternating samples per arm, reporting
  median/p95/range separately for cold and warm; a 20% regression stops acceptance.

The existing file-adapter tests cover real file observation and deterministic
watcher-health failure delivery. Extend that suite for single-notification crash
recovery and a change during downtime; do not add a production test hook.

On a loaded host, `--ready-timeout-seconds 600` extends only the setup deadline
(default 180 seconds). It does not change the settling or measurement window.
