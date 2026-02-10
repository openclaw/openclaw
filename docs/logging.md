---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Logging overview: file logs, console output, CLI tailing, and the Control UI"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need a beginner-friendly overview of logging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to configure log levels or formats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are troubleshooting and need to find logs quickly（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Logging"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Logging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw logs in two places:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **File logs** (JSON lines) written by the Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Console output** shown in terminals and the Control UI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This page explains where logs live, how to read them, and how to configure log（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
levels and formats.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Where logs live（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, the Gateway writes a rolling log file under:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`/tmp/openclaw/openclaw-YYYY-MM-DD.log`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The date uses the gateway host's local timezone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can override this in `~/.openclaw/openclaw.json`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "logging": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "file": "/path/to/openclaw.log"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How to read logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### CLI: live tail (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the CLI to tail the gateway log file via RPC:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Output modes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **TTY sessions**: pretty, colorized, structured log lines.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Non-TTY sessions**: plain text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`: line-delimited JSON (one log event per line).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--plain`: force plain text in TTY sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--no-color`: disable ANSI colors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In JSON mode, the CLI emits `type`-tagged objects:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `meta`: stream metadata (file, cursor, size)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `log`: parsed log entry（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `notice`: truncation / rotation hints（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `raw`: unparsed log line（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the Gateway is unreachable, the CLI prints a short hint to run:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Control UI (web)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Control UI’s **Logs** tab tails the same file using `logs.tail`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [/web/control-ui](/web/control-ui) for how to open it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Channel-only logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To filter channel activity (WhatsApp/Telegram/etc), use:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels logs --channel whatsapp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Log formats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### File logs (JSONL)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each line in the log file is a JSON object. The CLI and Control UI parse these（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
entries to render structured output (time, level, subsystem, message).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Console output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Console logs are **TTY-aware** and formatted for readability:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Subsystem prefixes (e.g. `gateway/channels/whatsapp`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Level coloring (info/warn/error)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional compact or JSON mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Console formatting is controlled by `logging.consoleStyle`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuring logging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All logging configuration lives under `logging` in `~/.openclaw/openclaw.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "logging": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "level": "info",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "file": "/tmp/openclaw/openclaw-YYYY-MM-DD.log",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "consoleLevel": "info",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "consoleStyle": "pretty",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "redactSensitive": "tools",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "redactPatterns": ["sk-.*"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Log levels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `logging.level`: **file logs** (JSONL) level.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `logging.consoleLevel`: **console** verbosity level.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`--verbose` only affects console output; it does not change file log levels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Console styles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`logging.consoleStyle`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pretty`: human-friendly, colored, with timestamps.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `compact`: tighter output (best for long sessions).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `json`: JSON per line (for log processors).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Redaction（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tool summaries can redact sensitive tokens before they hit the console:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `logging.redactSensitive`: `off` | `tools` (default: `tools`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `logging.redactPatterns`: list of regex strings to override the default set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Redaction affects **console output only** and does not alter file logs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Diagnostics + OpenTelemetry（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Diagnostics are structured, machine-readable events for model runs **and**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message-flow telemetry (webhooks, queueing, session state). They do **not**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
replace logs; they exist to feed metrics, traces, and other exporters.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Diagnostics events are emitted in-process, but exporters only attach when（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
diagnostics + the exporter plugin are enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### OpenTelemetry vs OTLP（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **OpenTelemetry (OTel)**: the data model + SDKs for traces, metrics, and logs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **OTLP**: the wire protocol used to export OTel data to a collector/backend.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenClaw exports via **OTLP/HTTP (protobuf)** today.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Signals exported（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Metrics**: counters + histograms (token usage, message flow, queueing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Traces**: spans for model usage + webhook/message processing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Logs**: exported over OTLP when `diagnostics.otel.logs` is enabled. Log（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  volume can be high; keep `logging.level` and exporter filters in mind.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Diagnostic event catalog（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Model usage:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `model.usage`: tokens, cost, duration, context, provider/model/channel, session ids.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Message flow:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `webhook.received`: webhook ingress per channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `webhook.processed`: webhook handled + duration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `webhook.error`: webhook handler errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message.queued`: message enqueued for processing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message.processed`: outcome + duration + optional error.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Queue + session:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `queue.lane.enqueue`: command queue lane enqueue + depth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `queue.lane.dequeue`: command queue lane dequeue + wait time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `session.state`: session state transition + reason.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `session.stuck`: session stuck warning + age.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `run.attempt`: run retry/attempt metadata.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `diagnostic.heartbeat`: aggregate counters (webhooks/queue/session).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Enable diagnostics (no exporter)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use this if you want diagnostics events available to plugins or custom sinks:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "diagnostics": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "enabled": true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Diagnostics flags (targeted logs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use flags to turn on extra, targeted debug logs without raising `logging.level`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Flags are case-insensitive and support wildcards (e.g. `telegram.*` or `*`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "diagnostics": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "flags": ["telegram.http"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Env override (one-off):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Flag logs go to the standard log file (same as `logging.file`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Output is still redacted according to `logging.redactSensitive`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Full guide: [/diagnostics/flags](/diagnostics/flags).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Export to OpenTelemetry（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Diagnostics can be exported via the `diagnostics-otel` plugin (OTLP/HTTP). This（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
works with any OpenTelemetry collector/backend that accepts OTLP/HTTP.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "plugins": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "allow": ["diagnostics-otel"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "entries": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "diagnostics-otel": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "enabled": true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "diagnostics": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "otel": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "endpoint": "http://otel-collector:4318",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "protocol": "http/protobuf",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "serviceName": "openclaw-gateway",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "traces": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "metrics": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "logs": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "sampleRate": 0.2,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "flushIntervalMs": 60000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You can also enable the plugin with `openclaw plugins enable diagnostics-otel`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `protocol` currently supports `http/protobuf` only. `grpc` is ignored.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Metrics include token usage, cost, context size, run duration, and message-flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  counters/histograms (webhooks, queueing, session state, queue depth/wait).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Traces/metrics can be toggled with `traces` / `metrics` (default: on). Traces（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  include model usage spans plus webhook/message processing spans when enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `headers` when your collector requires auth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Environment variables supported: `OTEL_EXPORTER_OTLP_ENDPOINT`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Exported metrics (names + types)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Model usage:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.tokens` (counter, attrs: `openclaw.token`, `openclaw.channel`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `openclaw.provider`, `openclaw.model`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.cost.usd` (counter, attrs: `openclaw.channel`, `openclaw.provider`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `openclaw.model`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.run.duration_ms` (histogram, attrs: `openclaw.channel`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `openclaw.provider`, `openclaw.model`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.context.tokens` (histogram, attrs: `openclaw.context`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `openclaw.channel`, `openclaw.provider`, `openclaw.model`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Message flow:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.webhook.received` (counter, attrs: `openclaw.channel`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `openclaw.webhook`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.webhook.error` (counter, attrs: `openclaw.channel`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `openclaw.webhook`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.webhook.duration_ms` (histogram, attrs: `openclaw.channel`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `openclaw.webhook`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.message.queued` (counter, attrs: `openclaw.channel`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `openclaw.source`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.message.processed` (counter, attrs: `openclaw.channel`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `openclaw.outcome`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.message.duration_ms` (histogram, attrs: `openclaw.channel`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `openclaw.outcome`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Queues + sessions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.queue.lane.enqueue` (counter, attrs: `openclaw.lane`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.queue.lane.dequeue` (counter, attrs: `openclaw.lane`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.queue.depth` (histogram, attrs: `openclaw.lane` or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `openclaw.channel=heartbeat`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.queue.wait_ms` (histogram, attrs: `openclaw.lane`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.session.state` (counter, attrs: `openclaw.state`, `openclaw.reason`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.session.stuck` (counter, attrs: `openclaw.state`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.session.stuck_age_ms` (histogram, attrs: `openclaw.state`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.run.attempt` (counter, attrs: `openclaw.attempt`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Exported spans (names + key attributes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.model.usage`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw.channel`, `openclaw.provider`, `openclaw.model`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw.sessionKey`, `openclaw.sessionId`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw.tokens.*` (input/output/cache_read/cache_write/total)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.webhook.processed`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.webhook.error`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    `openclaw.error`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.message.processed`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw.channel`, `openclaw.outcome`, `openclaw.chatId`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    `openclaw.messageId`, `openclaw.sessionKey`, `openclaw.sessionId`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    `openclaw.reason`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw.session.stuck`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw.state`, `openclaw.ageMs`, `openclaw.queueDepth`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    `openclaw.sessionKey`, `openclaw.sessionId`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Sampling + flushing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Trace sampling: `diagnostics.otel.sampleRate` (0.0–1.0, root spans only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Metric export interval: `diagnostics.otel.flushIntervalMs` (min 1000ms).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Protocol notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OTLP/HTTP endpoints can be set via `diagnostics.otel.endpoint` or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `OTEL_EXPORTER_OTLP_ENDPOINT`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the endpoint already contains `/v1/traces` or `/v1/metrics`, it is used as-is.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the endpoint already contains `/v1/logs`, it is used as-is for logs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `diagnostics.otel.logs` enables OTLP log export for the main logger output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Log export behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OTLP logs use the same structured records written to `logging.file`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Respect `logging.level` (file log level). Console redaction does **not** apply（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  to OTLP logs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- High-volume installs should prefer OTLP collector sampling/filtering.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting tips（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Gateway not reachable?** Run `openclaw doctor` first.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Logs empty?** Check that the Gateway is running and writing to the file path（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  in `logging.file`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Need more detail?** Set `logging.level` to `debug` or `trace` and retry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
