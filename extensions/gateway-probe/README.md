# Gateway Probe (plugin)

Observe existing OpenClaw gateway activity and normalize it into a compact event
stream for audit and operational visibility.

This plugin is intentionally small and conservative:

- disabled by default
- observe-only: it never blocks or rewrites tool or model behavior
- avoids high-frequency streaming or delta-style event output
- no network egress unless you explicitly enable Kafka output
- no new inbound listener or external control-plane dependency

## Enable

Bundled plugins are disabled by default. Enable this one:

```bash
openclaw plugins enable gateway-probe
```

Restart the Gateway after enabling.

## Event Volume Policy

`gateway-probe` keeps event volume intentionally low:

- no chat-delta or token-delta events
- tool events are emitted only after a tool call finishes
- model events are emitted only on terminal model output / usage
- diagnostics keep only low-frequency terminal or abnormal events

This keeps one conversation turn from exploding into many streaming events.

## What it captures

`gateway-probe` listens to existing plugin hooks, diagnostics, and structured app
logs, then emits normalized events such as:

- session start and stop
- completed tool calls
- terminal model usage events
- low-frequency abnormal diagnostics such as `webhook.error`, `session.stuck`, and `tool.loop`
- selected gateway error and security log events already present in app logs

For the event names and source mapping, see `extensions/gateway-probe/EVENT_CATALOG.md`.

## Supported Event Types

Current event types emitted by this plugin:

- `audit.session.started`
- `audit.session.ended`
- `audit.gateway.started`
- `audit.gateway.stopped`
- `audit.tool.call.finished`
- `audit.model.response.usage`
- `realtime.trace.action_span`
- `realtime.message.processed`
- `realtime.webhook.error`
- `realtime.session.stuck`
- `realtime.tool.loop`
- `ops.subsystem.error`
- `security.ws.unauthorized`
- `security.http.tool_invoke.failed`
- `security.http.malformed_or_reset`
- `security.device.role_escalation`

## Configuration

Configure under `plugins.entries.gateway-probe.config`.

```jsonc
{
  "plugins": {
    "entries": {
      "gateway-probe": {
        "enabled": true,
        "config": {
          "probe": {
            "probeId": "",
            "name": "gateway-prod-01",
          },
          "labels": {
            "env": "prod",
          },
          "kafka": {
            "enabled": true,
            "brokers": ["kafka-1:9092", "kafka-2:9092"],
            "topic": "openclaw.gateway.probe.events",
            "clientId": "openclaw-gateway-probe",
          },
        },
      },
    },
  },
}
```

Notes:

- `probe.probeId` defaults to a persisted local UUID under the state dir.
- `labels.hostname` is added automatically.
- Kafka publishing is disabled by default; enable it only after brokers and topic are ready.

## Environment overrides

```bash
export OPENCLAW_PROBE_ID=""
export OPENCLAW_PROBE_NAME="gateway-prod-01"
export OPENCLAW_PROBE_LABELS='{"env":"prod"}'

export OPENCLAW_PROBE_KAFKA_ENABLED="true"
export OPENCLAW_PROBE_KAFKA_BROKERS="kafka-1:9092,kafka-2:9092"
export OPENCLAW_PROBE_KAFKA_TOPIC="openclaw.gateway.probe.events"
export OPENCLAW_PROBE_KAFKA_CLIENT_ID="openclaw-gateway-probe"
```

## Verification

1. Enable the plugin and restart the gateway.
2. Confirm startup logs include `gateway-probe: started`.
3. Trigger one simple run and one tool call.
4. Confirm you do not see streaming token or delta-style events.
5. If Kafka is enabled, confirm a small number of terminal events land in your configured topic.

## Scope Boundary

`gateway-probe` does not:

- expose an OTLP or HTTP ingest endpoint
- emit chat-delta or token-delta events
- perform high-risk or policy-style tool detection
- block or redact tool results
- require the separate `platform/` stack
