# Diagnose JSON Contract

`openclaw diagnose --json` emits an operator-facing snapshot for control-plane triage. The
payload is a stable contract, not a raw dump of local configuration or runtime state.

The current schema is `openclaw-diagnose/v1`. Consumers should check `schemaVersion` before
depending on field names or nested shapes.

Top-level fields:

- `schemaVersion`: the diagnose payload contract version.
- `ok`: true only when plugin contract validation, task audit, and open-incident checks are clean.
- `timestamp`: ISO-8601 generation time.
- `redaction`: explicit guarantees for omitted sensitive material.
- `persistence`: explicit declaration of state written while building the report.
- `status`: redacted gateway summary plus configured channel and agent counts.
- `plugins.contracts`: strict plugin contract validation result.
- `tasks`: task audit summary intended for diagnose output.
- `baselines`: current baseline summary plus recent saved baseline names.
- `probeCache`: recent probe-cache summaries.
- `incidents`: incident ledger counts and recent incident summaries.
- `actions.safe`: follow-up commands that are read-only or diagnostic.
- `actions.unsafe`: repair, restart, update, or mutation commands that are recommendations only.

Redaction guarantees:

- Raw gateway authentication is omitted from `status.gateway`.
- Raw config and raw environment values are not included.
- Token, password, API key, and URL userinfo material must not be emitted in JSON output.
- Persistent incident repair details are redacted before write.

Persistence behavior:

- `diagnose --json` may write a latest baseline snapshot.
- It may refresh probe-cache entries for diagnostic probes.
- It may create a summarized incident ledger entry when checks fail.
- It must not run repair commands, restart the gateway, update plugins, rotate credentials, or start
  live channels. Unsafe actions are listed only so an operator can choose an explicit next step.
