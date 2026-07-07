---
summary: "CLI reference for metadata-only agent run and tool action audit records"
read_when:
  - You need to answer who ran an agent or tool, when it ran, and how it ended
  - You need a bounded, redaction-safe activity export
title: "Audit records"
---

# `openclaw audit`

Query the Gateway's metadata-only audit ledger for agent runs and tool actions.

Recording is on by default; set [`audit.enabled: false`](/gateway/configuration-reference#audit)
to stop new writes. Existing records stay queryable until they expire (30 days).
The ledger is separate from conversation transcripts: it records identity,
ordering, provenance, action, status, and normalized error codes, but never
stores prompts, messages, tool arguments, tool results, command output, or raw
error text.

The Gateway writes records to the shared OpenClaw state database through a
bounded background writer. Queries never return records older than 30 days,
and the ledger is capped at 100,000 rows. Expired rows are deleted during
Gateway startup, hourly maintenance, and later writes.

```bash
openclaw audit
openclaw audit --agent main --status failed
openclaw audit --session "agent:main:main" --after 2026-07-01T00:00:00Z
openclaw audit --run 8c69f72e-8b11-4c54-98d5-1a3dd67450c3
openclaw audit --kind tool_action --limit 50 --json
```

## Filters

- `--agent <id>`: exact agent id
- `--session <key>`: exact session key
- `--run <id>`: exact run id
- `--kind <kind>`: `agent_run` or `tool_action`
- `--status <status>`: `started`, `succeeded`, `failed`, `cancelled`,
  `timed_out`, `blocked`, or `unknown`
- `--after <timestamp>` / `--before <timestamp>`: inclusive ISO timestamp or
  Unix milliseconds
- `--limit <count>`: page size from 1 to 500; default `100`
- `--cursor <sequence>`: continue a previous newest-first query
- `--json`: print the bounded page as JSON

Text output shows time, kind, status, agent, run, and action. Tool actions also
show the tool name. JSON output is a safe bounded export of the same metadata
and includes `nextCursor` when another page exists. Pass that value to
`--cursor` to continue without reordering records that arrive during paging.

## Recorded events

The Gateway projects existing agent event streams into four actions:

- `agent.run.started`
- `agent.run.finished`
- `tool.action.started`
- `tool.action.finished`

Every record has a stable event id, a monotonically increasing ledger sequence,
the original run event sequence, lifecycle timestamp when the runtime provides
one (otherwise observation time), agent/run provenance, actor, and a
`redaction: "metadata_only"` marker. Terminal records distinguish success,
failure, cancellation, timeout, and policy blocks with closed status and error
codes. `unknown` is an explicit non-success result when an upstream runtime
does not expose an authoritative terminal outcome. Tool call ids are exported
only as stable one-way fingerprints. Tool names must match the compact
model-facing name contract; other values become `unknown`. Session ids, session
keys, run ids, and retained tool names are operator metadata; protect exports
as operational records.

The audit ledger does not replace transcripts, task history, cron run history,
or logs. It provides a small cross-run index for operator questions without
copying conversation content into another store.

## Gateway RPC

`audit.list` requires `operator.read` and accepts the same filters. Example:

```bash
openclaw gateway call audit.list --params '{"agentId":"main","status":"failed","limit":50}'
```

The result is `{ "events": AuditEvent[], "nextCursor"?: string }`. Results are
newest first and limited to 500 records per request.

## Related

- [Gateway protocol](/gateway/protocol#audit-ledger-rpc)
- [Sessions](/cli/sessions)
- [Tasks](/cli/tasks)
- [Cron jobs](/automation/cron-jobs)
