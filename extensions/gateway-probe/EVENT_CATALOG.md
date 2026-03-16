# Gateway Probe Event Catalog

`gateway-probe` emits a single normalized event envelope with:

- `probeId`, `probeName`, `labels`
- `eventType`, `source`, `severity`, `occurredAt`
- optional `agentId`, `sessionId`, `sessionKey`, `traceId`, `spanId`
- a redacted `payload`

The plugin intentionally avoids streaming or delta-style events. It keeps only
terminal or abnormal events so that one conversation turn produces a small,
reviewable number of records.

## Session events

- `audit.session.started`
- `audit.session.ended`
- `audit.gateway.started`
- `audit.gateway.stopped`

Source: `session_hook`

## Tool and model events

- `audit.tool.call.finished`
- `audit.model.response.usage`
- `realtime.trace.action_span` (terminal model-response companion span only)

Source: `session_hook`

## Log-derived abnormal events

- `ops.subsystem.error`
- `security.ws.unauthorized`
- `security.http.tool_invoke.failed`
- `security.http.malformed_or_reset`
- `security.device.role_escalation`

Source: `app_log`

## Diagnostic abnormal / terminal events

- `realtime.message.processed`
- `realtime.webhook.error`
- `realtime.session.stuck`
- `realtime.tool.loop`

Source: `diagnostic`

## Privacy notes

- string payload fields are passed through `redactSensitiveText`
- nested payloads are truncated for size and depth
- host IPs are not attached automatically; add them explicitly through `labels` if needed
