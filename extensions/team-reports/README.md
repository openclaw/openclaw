# Team Reports

Official external OpenClaw plugin for daily, weekly, and monthly GitHub activity reports
with optional Discord discussion, model-written summaries, and a **Reports**
tab in the Control UI. Installed on demand (`openclaw plugins install @openclaw/team-reports`);
source checkouts load it from `extensions/team-reports`. Disabled by default.

Configure `plugins.entries.team-reports.config` with a GitHub token or
SecretRef, at least one organization, and team or inline identity entries.
Configuration changes automatically reload the running plugin. Use
`openclaw plugins reload team-reports` after editing plugin code or if the
plugin remains unavailable after fixing its configuration.

```sh
openclaw team-reports status --json
openclaw team-reports generate --intraday
openclaw team-reports list --json
```

Reports use UTC windows, remain in the plugin-owned database, and are
served behind Gateway authentication at `/plugins/team-reports/` by default.
Source collection and report generation run in a worker. Collected events flow in
batches of at most 100 into connection-owned scratch tables; aggregation
reads bounded payload batches and keeps only the report's evidence limits.
Database work and source parsing stay off the Gateway event loop. Plugin
shutdown drains admitted worker and database work before closing the connection.
SQLite is the default. The host's experimental PostgreSQL configuration also
supports Team Reports, including database port and matched backup/restore.
Collected activity is temporary and is discarded when its connection closes;
saved reports, person-day counts, and run history are durable.
Storage initializes in the service background; Reports requests await readiness,
and shutdown joins initialization before closing storage. Initialization failures
appear in plugin service health without delaying unrelated Gateway connections.
Startup does not trigger collection. The first scheduled run catches up yesterday,
reusing accepted closed days when retrying a partially failed run; manual generation
still refreshes the requested day. Automatic collection waits at least five minutes
after service start, and intraday runs keep their aligned UTC boundaries.
Set `schedule.enabled: false` to stop automatic collection and catch-up while keeping
stored reports, work sessions, and explicit `generate` commands available. Status
then reports `scheduleEnabled: false` with no scheduled runs. The default is `true`.
The Control UI tab opens at `/reports` (prefixed by the Control UI base path).
Model summary calls are optional; set `summaries.enabled: false` for text without a model.

Failed activity collection preserves the previous daily report, per-person
counts, and overlapping weekly/monthly reports during that generation. If no
report exists yet, those periods stay unpublished. Inspect the failed
run's source warnings with `openclaw team-reports status --json`, then regenerate
the affected day after access or connectivity recovers. Later healthy runs use
accepted historical reports under the usual partial-coverage policy.

See the [Team Reports guide](https://docs.openclaw.ai/plugins/team-reports)
for setup, configuration, attribution rules, exports, and troubleshooting.

## Fixture benchmark

From a source checkout root, measure report collection without live API calls:

```sh
node --expose-gc --import ./scripts/tsx.mjs extensions/team-reports/src/report-run.benchmark.test-support.ts --worker
```

The performance check uses 2,000 issues, 1,000 commits, and 1,500 messages. It reports
main-thread heap growth and synchronous callback duration, including worker startup,
and verifies report counts. Omit `--worker` to measure the streaming collector's
calling isolate separately; database aggregation still runs in its worker.
