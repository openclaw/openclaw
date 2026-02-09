---
summary: "Overzicht van logging: bestandslogs, console-uitvoer, CLI-tailing en de Control UI"
read_when:
  - Je hebt een beginnersvriendelijk overzicht van logging nodig
  - Je wilt logniveaus of -formaten configureren
  - Je bent problemen aan het oplossen en wilt logs snel vinden
title: "Logging"
---

# Logging

OpenClaw logt op twee plaatsen:

- **Bestandslogs** (JSON-regels) geschreven door de Gateway.
- **Console-uitvoer** die wordt getoond in terminals en de Control UI.

Deze pagina legt uit waar logs zich bevinden, hoe je ze leest en hoe je
logniveaus en -formaten configureert.

## Waar logs zich bevinden

Standaard schrijft de Gateway een roterend logbestand onder:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

De datum gebruikt de lokale tijdzone van de Gateway-host.

Je kunt dit overschrijven in `~/.openclaw/openclaw.json`:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## Logs lezen

### CLI: live tail (aanbevolen)

Gebruik de CLI om het gateway-logbestand via RPC te tailen:

```bash
openclaw logs --follow
```

Uitvoermodi:

- **TTY-sessies**: mooie, gekleurde, gestructureerde logregels.
- **Niet-TTY-sessies**: platte tekst.
- `--json`: regel-gescheiden JSON (één logevent per regel).
- `--plain`: forceer platte tekst in TTY-sessies.
- `--no-color`: schakel ANSI-kleuren uit.

In JSON-modus zendt de CLI met `type` getagde objecten uit:

- `meta`: stream-metadata (bestand, cursor, grootte)
- `log`: geparseerde logvermelding
- `notice`: hints voor afkappen/rotatie
- `raw`: ongeparseerde logregel

Als de Gateway onbereikbaar is, toont de CLI een korte hint om het volgende uit te voeren:

```bash
openclaw doctor
```

### Control UI (web)

Het tabblad **Logs** in de Control UI tailt hetzelfde bestand met `logs.tail`.
Zie [/web/control-ui](/web/control-ui) voor hoe je deze opent.

### Alleen-kanaal-logs

Om kanaalactiviteit te filteren (WhatsApp/Telegram/etc), gebruik:

```bash
openclaw channels logs --channel whatsapp
```

## Logformaten

### Bestandslogs (JSONL)

Elke regel in het logbestand is een JSON-object. De CLI en Control UI parseren deze
vermeldingen om gestructureerde uitvoer te renderen (tijd, niveau, subsysteem, bericht).

### Console-uitvoer

Consolelogs zijn **TTY-bewust** en geformatteerd voor leesbaarheid:

- Subysteem-prefixen (bijv. `gateway/channels/whatsapp`)
- Niveaokleuring (info/warn/error)
- Optionele compacte of JSON-modus

Console-opmaak wordt geregeld door `logging.consoleStyle`.

## Logging configureren

Alle loggingconfiguratie bevindt zich onder `logging` in `~/.openclaw/openclaw.json`.

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

### Logniveaus

- `logging.level`: niveau voor **bestandslogs** (JSONL).
- `logging.consoleLevel`: **console**-verbosityniveau.

`--verbose` beïnvloedt alleen console-uitvoer; het verandert de niveaus van bestandslogs niet.

### Consolestijlen

`logging.consoleStyle`:

- `pretty`: mensvriendelijk, gekleurd, met tijdstempels.
- `compact`: strakkere uitvoer (het beste voor lange sessies).
- `json`: JSON per regel (voor logprocessors).

### Redactie

Tool-samenvattingen kunnen gevoelige tokens redigeren voordat ze de console bereiken:

- `logging.redactSensitive`: `off` | `tools` (standaard: `tools`)
- `logging.redactPatterns`: lijst met regex-strings om de standaardset te overschrijven

Redactie beïnvloedt **alleen console-uitvoer** en wijzigt bestandslogs niet.

## Diagnostiek + OpenTelemetry

Diagnostiek zijn gestructureerde, machineleesbare events voor modelruns **en**
telemetrie van berichtstromen (webhooks, wachtrijen, sessiestatus). Ze **vervangen**
logs niet; ze bestaan om metrics, traces en andere exporters te voeden.

Diagnostische events worden in-process uitgezonden, maar exporters koppelen alleen
wanneer diagnostiek + de exporter-plugin zijn ingeschakeld.

### OpenTelemetry vs OTLP

- **OpenTelemetry (OTel)**: het datamodel + SDK's voor traces, metrics en logs.
- **OTLP**: het wire-protocol dat wordt gebruikt om OTel-data naar een collector/backend te exporteren.
- OpenClaw exporteert momenteel via **OTLP/HTTP (protobuf)**.

### Geëxporteerde signalen

- **Metrics**: counters + histogrammen (tokengebruik, berichtstroom, wachtrijen).
- **Traces**: spans voor modelgebruik + verwerking van webhooks/berichten.
- **Logs**: geëxporteerd via OTLP wanneer `diagnostics.otel.logs` is ingeschakeld. Logvolume
  kan hoog zijn; houd rekening met `logging.level` en exporterfilters.

### Catalogus van diagnostische events

Modelgebruik:

- `model.usage`: tokens, kosten, duur, context, provider/model/kanaal, sessie-id's.

Berichtstroom:

- `webhook.received`: webhook-ingress per kanaal.
- `webhook.processed`: webhook afgehandeld + duur.
- `webhook.error`: fouten in webhook-handlers.
- `message.queued`: bericht in wachtrij geplaatst voor verwerking.
- `message.processed`: resultaat + duur + optionele fout.

Wachtrij + sessie:

- `queue.lane.enqueue`: enqueue van command-queue-lane + diepte.
- `queue.lane.dequeue`: dequeue van command-queue-lane + wachttijd.
- `session.state`: overgang van sessiestatus + reden.
- `session.stuck`: waarschuwing voor vastgelopen sessie + leeftijd.
- `run.attempt`: metadata voor run retry/poging.
- `diagnostic.heartbeat`: geaggregeerde counters (webhooks/wachtrij/sessie).

### Diagnostiek inschakelen (geen exporter)

Gebruik dit als je diagnostische events beschikbaar wilt maken voor plugins of aangepaste sinks:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### Diagnostische flags (gerichte logs)

Gebruik flags om extra, gerichte debuglogs in te schakelen zonder `logging.level` te verhogen.
Flags zijn hoofdletterongevoelig en ondersteunen wildcards (bijv. `telegram.*` of `*`).

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Env-override (eenmalig):

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Notities:

- Flag-logs gaan naar het standaardlogbestand (hetzelfde als `logging.file`).
- Uitvoer wordt nog steeds geredigeerd volgens `logging.redactSensitive`.
- Volledige gids: [/diagnostics/flags](/diagnostics/flags).

### Exporteren naar OpenTelemetry

Diagnostiek kan worden geëxporteerd via de `diagnostics-otel`-plugin (OTLP/HTTP). Dit
werkt met elke OpenTelemetry-collector/backend die OTLP/HTTP accepteert.

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

Notities:

- Je kunt de plugin ook inschakelen met `openclaw plugins enable diagnostics-otel`.
- `protocol` ondersteunt momenteel alleen `http/protobuf`. `grpc` wordt genegeerd.
- Metrics omvatten tokengebruik, kosten, contextgrootte, runduur en counters/histogrammen
  voor berichtstroom (webhooks, wachtrijen, sessiestatus, wachtrijdiepte/-wachttijd).
- Traces/metrics kunnen worden in- of uitgeschakeld met `traces` / `metrics` (standaard: aan). Traces
  omvatten spans voor modelgebruik plus spans voor verwerking van webhooks/berichten wanneer ingeschakeld.
- Stel `headers` in wanneer je collector authenticatie vereist.
- Ondersteunde omgevingsvariabelen: `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`.

### Geëxporteerde metrics (namen + typen)

Modelgebruik:

- `openclaw.tokens` (counter, attrs: `openclaw.token`, `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (counter, attrs: `openclaw.channel`, `openclaw.provider`,
  `openclaw.model`)
- `openclaw.run.duration_ms` (histogram, attrs: `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (histogram, attrs: `openclaw.context`,
  `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

Berichtstroom:

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

Wachtrijen + sessies:

- `openclaw.queue.lane.enqueue` (counter, attrs: `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (counter, attrs: `openclaw.lane`)
- `openclaw.queue.depth` (histogram, attrs: `openclaw.lane` of
  `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (histogram, attrs: `openclaw.lane`)
- `openclaw.session.state` (counter, attrs: `openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (counter, attrs: `openclaw.state`)
- `openclaw.session.stuck_age_ms` (histogram, attrs: `openclaw.state`)
- `openclaw.run.attempt` (counter, attrs: `openclaw.attempt`)

### Geëxporteerde spans (namen + sleutelattributen)

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

### Sampling + flushen

- Trace-sampling: `diagnostics.otel.sampleRate` (0.0–1.0, alleen root-spans).
- Metric-exportinterval: `diagnostics.otel.flushIntervalMs` (min. 1000 ms).

### Protocolnotities

- OTLP/HTTP-eindpunten kunnen worden ingesteld via `diagnostics.otel.endpoint` of
  `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Als het eindpunt al `/v1/traces` of `/v1/metrics` bevat, wordt het ongewijzigd gebruikt.
- Als het eindpunt al `/v1/logs` bevat, wordt het ongewijzigd gebruikt voor logs.
- `diagnostics.otel.logs` schakelt OTLP-logexport in voor de uitvoer van de hoofdlogger.

### Gedrag van logexport

- OTLP-logs gebruiken dezelfde gestructureerde records die naar `logging.file` worden geschreven.
- Respecteer `logging.level` (niveau van bestandslogs). Consoleredactie is **niet**
  van toepassing op OTLP-logs.
- Installaties met hoog volume moeten OTLP-collector-sampling/filtering verkiezen.

## Tips voor probleemoplossing

- **Gateway niet bereikbaar?** Voer eerst `openclaw doctor` uit.
- **Logs leeg?** Controleer of de Gateway draait en schrijft naar het bestandspad
  in `logging.file`.
- **Meer detail nodig?** Stel `logging.level` in op `debug` of `trace` en probeer opnieuw.
