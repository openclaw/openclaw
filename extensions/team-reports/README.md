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

Reports use UTC windows, remain in the plugin-owned SQLite store, and are
served behind Gateway authentication at `/plugins/team-reports/` by default.
Source collection and report generation run in a worker. Collected events flow in
batches of at most 100 into connection-owned SQLite scratch tables; aggregation
reads bounded payload batches and keeps only the report's evidence limits.
SQLite lock waits and source parsing stay off the Gateway event loop. Plugin
shutdown drains admitted worker and database work before closing the connection.
Boot catch-up reuses accepted closed days when retrying a partially failed run;
manual generation still refreshes the requested day.
The Control UI tab opens at `/reports` (prefixed by the Control UI base path).
Model summary calls are optional; set `summaries.enabled: false` for deterministic text.

Failed activity collection preserves the previous daily report, per-person
counts, and overlapping weekly/monthly reports during that generation. If no
report exists yet, those periods stay unpublished. Inspect the failed
run's source warnings with `openclaw team-reports status --json`, then regenerate
the affected day after access or connectivity recovers. Later healthy runs use
accepted historical reports under the usual partial-coverage policy.

See the [Team Reports guide](https://docs.openclaw.ai/plugins/team-reports)
for setup, configuration, attribution rules, exports, and troubleshooting.
