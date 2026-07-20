---
summary: "CLI reference for querying AI safety and quality taxonomy events"
read_when:
  - You want to inspect which safety events the Gateway has recorded
  - You need to filter events by type, severity, or session
  - You need a bounded, cursor-paged export of AI safety telemetry
title: "AI safety events"
---

# `openclaw safety`

Query the Gateway's AI safety event history — a durable, metadata-only log of
safety-relevant decisions and policy signals emitted by the core runtime and
opted-in plugins.

The store retains up to 10 000 events in newest-first order. Events older than
the capacity are evicted automatically. No message content is stored: records
capture taxonomy type, severity, session id, agent id, channel, and an optional
short operator message.

```bash
openclaw safety events
openclaw safety events --type ai_safety.refusal --since 1h
openclaw safety events --severity high --limit 50
openclaw safety events --session "agent:main:main" --json
openclaw safety events --cursor <nextCursor>
```

## Filters

- `--type <type>`: exact event type, e.g. `ai_safety.refusal`
- `--session <id>`: filter by session id
- `--since <duration>`: only show events within this window — `1h`, `30m`, `2d`,
  `600s`, `250ms` (client-side post-filter on `recordedAt`)
- `--severity <level>`: `info`, `low`, `medium`, `high`, or `critical`
- `--limit <count>`: page size from 1 to 500; default `100`
- `--cursor <sequence>`: continue a previous newest-first query
- `--json`: print the bounded page as JSON

## Event taxonomy

Five event families are emitted by the core runtime:

| Type                                  | Severity        | When                                                                   |
| ------------------------------------- | --------------- | ---------------------------------------------------------------------- |
| `ai_safety.prompt_injection.signal`   | low – high      | Heuristic prompt-injection signal detected in inbound content          |
| `ai_safety.tool_policy.decision`      | info – high     | Tool call evaluated against policy; approved, rate-limited, or blocked |
| `ai_safety.external_content.consumed` | info            | External content (web, API, file) ingested into context                |
| `ai_safety.memory_context.selected`   | info            | Memory context selected for injection                                  |
| `ai_safety.eval.result`               | info – critical | Automated quality evaluation result                                    |

`ai_safety.user_feedback.received` is a reserved family for explicit user feedback signals; the production boundary emitter is not wired in this PR and will be added in a follow-up.

Plugins may emit additional types by declaring `safetyEventTypes` in their
manifest and calling `ctx.safetyDiagnostics.emit()` from a registered service.
Only declared types are accepted; undeclared types are rejected at the host
boundary.

## JSON output

`--json` returns a bounded page:

```json
{
  "events": [
    {
      "sequence": 42,
      "type": "ai_safety.external_content.consumed",
      "severity": "info",
      "sessionId": "agent:main:main",
      "agentId": "main",
      "channel": "webchat",
      "message": "External content consumed",
      "recordedAt": 1784484884547
    }
  ],
  "nextCursor": "41"
}
```

Pass `nextCursor` to `--cursor` to page without reordering records that arrive
during paging.

## Gateway RPC

`safety.events.list` requires `operator.read` and accepts the same filters:

```bash
openclaw gateway call safety.events.list \
  --params '{"eventType":"ai_safety.refusal","limit":50}'
```

`safety.events.summary` returns bucketed counts by type and severity:

```bash
openclaw gateway call safety.events.summary \
  --params '{"windowMs":3600000,"buckets":12}'
```

## Related

- [Audit records](/cli/audit)
- [Gateway protocol](/gateway/protocol)
- [Diagnostics](/gateway/diagnostics)
