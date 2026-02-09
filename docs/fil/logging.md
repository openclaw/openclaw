---
summary: "Pangkalahatang-ideya ng logging: mga file log, console output, pag-tail sa CLI, at ang Control UI"
read_when:
  - Kailangan mo ng beginner-friendly na pangkalahatang-ideya ng logging
  - Gusto mong i-configure ang mga log level o format
  - Nagpa‑pag-troubleshoot ka at kailangan mong mabilis na mahanap ang mga log
title: "Logging"
---

# Logging

Nagla-log ang OpenClaw sa dalawang lugar:

- **File logs** (JSON lines) na sinusulat ng Gateway.
- **Console output** na ipinapakita sa mga terminal at sa Control UI.

Ipinapaliwanag ng pahinang ito kung saan matatagpuan ang mga log, paano basahin
ang mga ito, at paano i-configure ang mga log level at format.

## Saan matatagpuan ang mga log

Bilang default, ang Gateway ay nagsusulat ng rolling log file sa ilalim ng:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

Ginagamit ng petsa ang lokal na timezone ng host ng gateway.

Maaari mo itong i-override sa `~/.openclaw/openclaw.json`:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## Paano basahin ang mga log

### CLI: live tail (inirerekomenda)

Gamitin ang CLI para i-tail ang gateway log file sa pamamagitan ng RPC:

```bash
openclaw logs --follow
```

Mga output mode:

- **TTY sessions**: maayos, may kulay, structured na mga linya ng log.
- **Non-TTY sessions**: plain text.
- `--json`: line-delimited JSON (isang log event bawat linya).
- `--plain`: pilitin ang plain text sa mga TTY session.
- `--no-color`: i-disable ang mga ANSI color.

Sa JSON mode, ang CLI ay naglalabas ng mga object na may tag na `type`:

- `meta`: stream metadata (file, cursor, laki)
- `log`: na-parse na log entry
- `notice`: mga hint sa truncation / rotation
- `raw`: hindi na-parse na linya ng log

Kung hindi maabot ang Gateway, ang CLI ay magpi-print ng maikling hint para patakbuhin ang:

```bash
openclaw doctor
```

### Control UI (web)

Ang **Logs** tab ng Control UI ay nagta-tail ng parehong file gamit ang `logs.tail`.
Tingnan ang [/web/control-ui](/web/control-ui) kung paano ito buksan.

### Channel-only logs

Para i-filter ang aktibidad ng channel (WhatsApp/Telegram/etc), gamitin ang:

```bash
openclaw channels logs --channel whatsapp
```

## Mga format ng log

### File logs (JSONL)

Each line in the log file is a JSON object. Ang CLI at Control UI ay nagpa-parse ng mga
entry na ito upang mag-render ng structured output (oras, antas, subsystem, mensahe).

### Console output

Ang mga console log ay **TTY-aware** at naka-format para sa mas madaling basahin:

- Mga prefix ng subsystem (hal. `gateway/channels/whatsapp`)
- Pagkulay ayon sa level (info/warn/error)
- Opsyonal na compact o JSON mode

Kinokontrol ang console formatting ng `logging.consoleStyle`.

## Pag-configure ng logging

Lahat ng logging configuration ay nasa ilalim ng `logging` sa `~/.openclaw/openclaw.json`.

```json
{
  "logging": {
    "level": "info",
    "file": "/tmp/openclaw/openclaw-YYYY-MM-DD.log",
    "consoleLevel": "info",
    "consoleStyle": "pretty",
    "redactSensitive": "tools",
    "redactPatterns": ["sk-.*"]
  }
}
```

### Mga log level

- `logging.level`: antas ng **file logs** (JSONL).
- `logging.consoleLevel`: antas ng verbosity ng **console**.

Ang `--verbose` ay nakakaapekto lamang sa console output; hindi nito binabago ang
mga antas ng file log.

### Mga style ng console

`logging.consoleStyle`:

- `pretty`: madaling basahin ng tao, may kulay, may mga timestamp.
- `compact`: mas siksik na output (pinakamainam para sa mahahabang session).
- `json`: JSON bawat linya (para sa mga log processor).

### Redaction

Maaaring mag-redact ang mga tool summary ng sensitibong token bago ito umabot sa console:

- `logging.redactSensitive`: `off` | `tools` (default: `tools`)
- `logging.redactPatterns`: listahan ng mga regex string para i-override ang default na set

Ang redaction ay nakakaapekto **sa console output lamang** at hindi binabago ang file logs.

## Diagnostics + OpenTelemetry

Ang Diagnostics ay mga structured, machine-readable na event para sa mga model run **at**
telemetry ng daloy ng mensahe (webhooks, queueing, estado ng session). Hindi nila **pinapalitan**
ang mga log; umiiral sila upang pakainin ang metrics, traces, at iba pang exporter.

Ang mga diagnostics event ay inilalabas in-process, ngunit ang mga exporter ay
kumakabit lamang kapag pinagana ang diagnostics + ang exporter plugin.

### OpenTelemetry vs OTLP

- **OpenTelemetry (OTel)**: ang data model + mga SDK para sa traces, metrics, at logs.
- **OTLP**: ang wire protocol na ginagamit para i-export ang OTel data sa isang collector/backend.
- Ang OpenClaw ay nag-e-export sa pamamagitan ng **OTLP/HTTP (protobuf)** sa kasalukuyan.

### Mga signal na ine-export

- **Metrics**: mga counter + histogram (token usage, message flow, queueing).
- **Traces**: mga span para sa paggamit ng model + pagproseso ng webhook/mensahe.
- **Logs**: ine-export sa OTLP kapag naka-enable ang `diagnostics.otel.logs`. Maaaring mataas ang volume ng log;
  isaalang-alang ang `logging.level` at mga filter ng exporter.

### Catalog ng diagnostic event

Paggamit ng model:

- `model.usage`: tokens, gastos, tagal, context, provider/model/channel, mga session id.

Daloy ng mensahe:

- `webhook.received`: webhook ingress bawat channel.
- `webhook.processed`: webhook na na-handle + tagal.
- `webhook.error`: mga error sa webhook handler.
- `message.queued`: mensaheng na-enqueue para sa pagproseso.
- `message.processed`: kinalabasan + tagal + opsyonal na error.

Queue + session:

- `queue.lane.enqueue`: pag-enqueue ng command queue lane + lalim.
- `queue.lane.dequeue`: pag-dequeue ng command queue lane + oras ng paghihintay.
- `session.state`: paglipat ng estado ng session + dahilan.
- `session.stuck`: babala sa na-stuck na session + edad.
- `run.attempt`: metadata ng run retry/attempt.
- `diagnostic.heartbeat`: pinagsama-samang mga counter (webhooks/queue/session).

### Paganahin ang diagnostics (walang exporter)

Gamitin ito kung gusto mong maging available ang mga diagnostic event sa mga plugin
o custom sink:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### Mga diagnostics flag (targeted logs)

Use flags to turn on extra, targeted debug logs without raising `logging.level`.
Flags are case-insensitive and support wildcards (e.g. `telegram.*` or `*`).

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Env override (one-off):

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Mga tala:

- Ang mga log ng flag ay napupunta sa standard log file (kapareho ng `logging.file`).
- Ang output ay naka-redact pa rin ayon sa `logging.redactSensitive`.
- Buong gabay: [/diagnostics/flags](/diagnostics/flags).

### Export sa OpenTelemetry

Maaaring i-export ang Diagnostics sa pamamagitan ng `diagnostics-otel` plugin (OTLP/HTTP). This
works with any OpenTelemetry collector/backend that accepts OTLP/HTTP.

```json
{
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": {
        "enabled": true
      }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://otel-collector:4318",
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 0.2,
      "flushIntervalMs": 60000
    }
  }
}
```

Mga tala:

- Maaari mo ring paganahin ang plugin gamit ang `openclaw plugins enable diagnostics-otel`.
- `protocol` currently supports `http/protobuf` only. `grpc` ay binabalewala.
- Kasama sa metrics ang token usage, gastos, laki ng context, tagal ng run, at mga counter/histogram
  ng daloy ng mensahe (webhooks, queueing, estado ng session, lalim/oras ng paghihintay ng queue).
- Traces/metrics can be toggled with `traces` / `metrics` (default: on). Ang mga trace
  ay kinabibilangan ng mga span ng paggamit ng modelo pati na rin ang mga span ng pagproseso ng webhook/mensahe kapag naka-enable.
- Itakda ang `headers` kapag nangangailangan ng auth ang iyong collector.
- Mga sinusuportahang environment variable: `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`.

### Mga na-export na metric (mga pangalan + uri)

Paggamit ng model:

- `openclaw.tokens` (counter, attrs: `openclaw.token`, `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (counter, attrs: `openclaw.channel`, `openclaw.provider`,
  `openclaw.model`)
- `openclaw.run.duration_ms` (histogram, attrs: `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (histogram, attrs: `openclaw.context`,
  `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

Daloy ng mensahe:

- `openclaw.webhook.received` (counter, attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.error` (counter, attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (histogram, attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.message.queued` (counter, attrs: `openclaw.channel`,
  `openclaw.source`)
- `openclaw.message.processed` (counter, attrs: `openclaw.channel`,
  `openclaw.outcome`)
- `openclaw.message.duration_ms` (histogram, attrs: `openclaw.channel`,
  `openclaw.outcome`)

Mga queue + session:

- `openclaw.queue.lane.enqueue` (counter, attrs: `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (counter, attrs: `openclaw.lane`)
- `openclaw.queue.depth` (histogram, attrs: `openclaw.lane` o
  `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (histogram, attrs: `openclaw.lane`)
- `openclaw.session.state` (counter, attrs: `openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (counter, attrs: `openclaw.state`)
- `openclaw.session.stuck_age_ms` (histogram, attrs: `openclaw.state`)
- `openclaw.run.attempt` (counter, attrs: `openclaw.attempt`)

### Mga na-export na span (mga pangalan + pangunahing attribute)

- `openclaw.model.usage`
  - `openclaw.channel`, `openclaw.provider`, `openclaw.model`
  - `openclaw.sessionKey`, `openclaw.sessionId`
  - `openclaw.tokens.*` (input/output/cache_read/cache_write/total)
- `openclaw.webhook.processed`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`,
    `openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`, `openclaw.outcome`, `openclaw.chatId`,
    `openclaw.messageId`, `openclaw.sessionKey`, `openclaw.sessionId`,
    `openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`, `openclaw.ageMs`, `openclaw.queueDepth`,
    `openclaw.sessionKey`, `openclaw.sessionId`

### Sampling + flushing

- Trace sampling: `diagnostics.otel.sampleRate` (0.0–1.0, root spans lamang).
- Metric export interval: `diagnostics.otel.flushIntervalMs` (min 1000ms).

### Mga tala sa protocol

- Maaaring itakda ang mga OTLP/HTTP endpoint sa pamamagitan ng `diagnostics.otel.endpoint` o
  `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Kung ang endpoint ay mayroon nang `/v1/traces` o `/v1/metrics`, gagamitin ito nang direkta.
- Kung ang endpoint ay mayroon nang `/v1/logs`, gagamitin ito nang direkta para sa logs.
- Ang `diagnostics.otel.logs` ay nagpapagana ng OTLP log export para sa pangunahing logger output.

### Pag-uugali ng log export

- Ginagamit ng OTLP logs ang parehong structured record na sinusulat sa `logging.file`.
- Igalang ang `logging.level` (antas ng file log). Console redaction does **not** apply
  to OTLP logs.
- Para sa mga installation na mataas ang volume, mas mainam ang OTLP collector sampling/filtering.

## Mga tip sa pag-troubleshoot

- **Hindi maabot ang Gateway?** Patakbuhin muna ang `openclaw doctor`.
- **Walang laman ang mga log?** Suriin kung tumatakbo ang Gateway at nagsusulat sa file path
  sa `logging.file`.
- **Kailangan ng mas detalyado?** Itakda ang `logging.level` sa `debug` o `trace` at subukang muli.
