---
summary: "Overblik over logging: fillogs, konsoloutput, CLI-tail og Control UI"
read_when:
  - Du har brug for et begyndervenligt overblik over logging
  - Du vil konfigurere logniveauer eller -formater
  - Du fejlsøger og har brug for hurtigt at finde logs
title: "Logging"
---

# Logging

OpenClaw logger to steder:

- **Fillogs** (JSON-linjer) skrevet af Gateway.
- **Konsoloutput** vist i terminaler og Control UI.

Denne side forklarer, hvor logs ligger, hvordan du læser dem, og hvordan du
konfigurerer logniveauer og -formater.

## Hvor logs ligger

Som standard skriver Gateway en roterende logfil under:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

Datoen bruger gateway-værtens lokale tidszone.

Du kan tilsidesætte dette i `~/.openclaw/openclaw.json`:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## Sådan læser du logs

### CLI: live tail (anbefalet)

Brug CLI’en til at tail’e gateway-logfilen via RPC:

```bash
openclaw logs --follow
```

Outputtilstande:

- **TTY-sessioner**: pæne, farvelagte, strukturerede loglinjer.
- **Ikke-TTY-sessioner**: ren tekst.
- `--json`: linjeopdelt JSON (én loghændelse pr. linje).
- `--plain`: gennemtving ren tekst i TTY-sessioner.
- `--no-color`: deaktiver ANSI-farver.

I JSON-tilstand udsender CLI’en `type`-taggede objekter:

- `meta`: stream-metadata (fil, cursor, størrelse)
- `log`: parset logpost
- `notice`: hints om trunkering/rotation
- `raw`: uparset loglinje

Hvis Gateway ikke kan nås, udskriver CLI’en et kort hint om at køre:

```bash
openclaw doctor
```

### Control UI (web)

Kontrol-UI'ens **Logs**-fanebladet haler den samme fil ved hjælp af `logs.tail`.
Se [/web/control-ui](/web/control-ui) for hvordan man åbner den.

### Kun kanal-logs

For at filtrere kanalaktivitet (WhatsApp/Telegram/etc.), brug:

```bash
openclaw channels logs --channel whatsapp
```

## Logformater

### Fillogs (JSONL)

Hver linje i logfilen er et JSON objekt. CLI og Control UI parse disse
poster for at gengive struktureret output (tid, niveau, delsystem, besked).

### Konsoloutput

Konsollogs er **TTY-aware** og formateret for læsbarhed:

- Undersystempræfikser (f.eks. `gateway/kanaler/whatsapp`)
- Niveaufarver (info/warn/error)
- Valgfri kompakt- eller JSON-tilstand

Konsolformatering styres af `logging.consoleStyle`.

## Konfiguration af logging

Al loggingkonfiguration ligger under `logging` i `~/.openclaw/openclaw.json`.

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

### Logniveauer

- `logging.level`: niveau for **fillogs** (JSONL).
- `logging.consoleLevel`: **konsol**-detaljeniveau.

`--verbose` påvirker kun konsoloutput; det ændrer ikke fillogniveauer.

### Konsolstile

`logging.consoleStyle`:

- `pretty`: menneskevenlig, farvelagt, med tidsstempler.
- `compact`: strammere output (bedst til lange sessioner).
- `json`: JSON pr. linje (til logprocessorer).

### Redigering (redaction)

Værktøjsresuméer kan maskere følsomme tokens, før de rammer konsollen:

- `logging.redactSensitive`: `off` | `tools` (standard: `tools`)
- `logging.redactPatterns`: liste af regex-strenge til at tilsidesætte standardsættet

Redigering påvirker **kun konsoloutput** og ændrer ikke fillogs.

## Diagnostik + OpenTelemetry

Diagnostik er strukturerede, maskinlæsbare begivenheder for model kører **og**
message-flow telemetri (webhooks, kø, session state). De erstatter **ikke**
logfiler; de findes for at fodre målinger, spor og andre eksportører.

Diagnostikhændelser udsendes in-process, men eksportører tilkobles kun, når
diagnostik + eksportør-plugin’et er aktiveret.

### OpenTelemetry vs OTLP

- **OpenTelemetry (OTel)**: datamodellen + SDK’er til traces, metrics og logs.
- **OTLP**: wire-protokollen, der bruges til at eksportere OTel-data til en collector/backend.
- OpenClaw eksporterer via **OTLP/HTTP (protobuf)** i dag.

### Eksporterede signaler

- **Metrics**: tællere + histogrammer (tokenforbrug, meddelelsesflow, køhåndtering).
- **Traces**: spans for modelbrug + webhook-/meddelelsesbehandling.
- **Logs**: eksporteres over OTLP, når `diagnostics.otel.logs` er aktiveret. Log
  lydstyrke kan være høj; husk `logging.level` og eksportør filtre i tankerne.

### Katalog over diagnostikhændelser

Modelbrug:

- `model.usage`: tokens, omkostning, varighed, kontekst, udbyder/model/kanal, session-id’er.

Meddelelsesflow:

- `webhook.received`: webhook-indgang pr. kanal.
- `webhook.processed`: webhook håndteret + varighed.
- `webhook.error`: fejl i webhook-handler.
- `message.queued`: besked sat i kø til behandling.
- `message.processed`: resultat + varighed + valgfri fejl.

Kø + session:

- `queue.lane.enqueue`: enqueue på kommandokø-bane + dybde.
- `queue.lane.dequeue`: dequeue fra kommandokø-bane + ventetid.
- `session.state`: overgang i sessionstilstand + årsag.
- `session.stuck`: advarsel om fastlåst session + alder.
- `run.attempt`: metadata for genforsøg/forsøg.
- `diagnostic.heartbeat`: aggregerede tællere (webhooks/kø/session).

### Aktivér diagnostik (ingen eksportør)

Brug dette, hvis du vil have diagnostikhændelser tilgængelige for plugins eller
egne sinks:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### Diagnostikflag (målrettede logs)

Brug flag til at aktivere ekstra, målrettede debug logs uden at hæve `logging.level`.
Flag er case-ufølsomme og understøtter jokertegn (f.eks. `telegram.*` eller `*`).

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Miljøoverride (engangskørsel):

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Noter:

- Flag-logs går til den almindelige logfil (samme som `logging.file`).
- Output redigeres stadig i henhold til `logging.redactSensitive`.
- Fuld guide: [/diagnostics/flags](/diagnostics/flags).

### Eksport til OpenTelemetry

Diagnostik kan eksporteres via `diagnostics-otel` plugin'et (OTLP/HTTP). Dette
virker med enhver OpenTelemetry samler/backend, der accepterer OTLP/HTTP.

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

Noter:

- Du kan også aktivere plugin’et med `openclaw plugins enable diagnostics-otel`.
- `protocol` understøtter i øjeblikket kun `http/protobuf'. `grpc\` ignoreres.
- Metrics inkluderer tokenforbrug, omkostning, kontekststørrelse, kørselsvarighed og
  tællere/histogrammer for meddelelsesflow (webhooks, køhåndtering, sessionstilstand, kødybde/ventetid).
- Traces/metrics kan skiftes med `traces` / `metrics` (standard: on). Traces
  omfatter modelforbrug spænder plus webhook/besked behandling spænder når aktiveret.
- Sæt `headers`, når din collector kræver autentificering.
- Understøttede miljøvariabler: `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`.

### Eksporterede metrics (navne + typer)

Modelbrug:

- `openclaw.tokens` (tæller, attrs: `openclaw.token`, `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (tæller, attrs: `openclaw.channel`, `openclaw.provider`,
  `openclaw.model`)
- `openclaw.run.duration_ms` (histogram, attrs: `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (histogram, attrs: `openclaw.context`,
  `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

Meddelelsesflow:

- `openclaw.webhook.received` (tæller, attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.error` (tæller, attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (histogram, attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.message.queued` (tæller, attrs: `openclaw.channel`,
  `openclaw.source`)
- `openclaw.message.processed` (tæller, attrs: `openclaw.channel`,
  `openclaw.outcome`)
- `openclaw.message.duration_ms` (histogram, attrs: `openclaw.channel`,
  `openclaw.outcome`)

Køer + sessioner:

- `openclaw.queue.lane.enqueue` (tæller, attrs: `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (tæller, attrs: `openclaw.lane`)
- `openclaw.queue.depth` (histogram, attrs: `openclaw.lane` eller
  `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (histogram, attrs: `openclaw.lane`)
- `openclaw.session.state` (tæller, attrs: `openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (tæller, attrs: `openclaw.state`)
- `openclaw.session.stuck_age_ms` (histogram, attrs: `openclaw.state`)
- `openclaw.run.attempt` (tæller, attrs: `openclaw.attempt`)

### Eksporterede spans (navne + nøgleattributter)

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

- Trace-sampling: `diagnostics.otel.sampleRate` (0,0–1,0, kun root-spans).
- Eksportinterval for metrics: `diagnostics.otel.flushIntervalMs` (min. 1000 ms).

### Protokolnoter

- OTLP/HTTP-endpoints kan sættes via `diagnostics.otel.endpoint` eller
  `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Hvis endpointet allerede indeholder `/v1/traces` eller `/v1/metrics`, bruges det som det er.
- Hvis endpointet allerede indeholder `/v1/logs`, bruges det som det er for logs.
- `diagnostics.otel.logs` aktiverer OTLP-logeksport for hovedloggerens output.

### Adfærd for logeksport

- OTLP-logs bruger de samme strukturerede poster, der skrives til `logging.file`.
- Respekt `logging.level` (fillogniveau). Konsol redaktion **ikke** anvende
  på OTLP logs.
- Installationer med høj volumen bør foretrække sampling/filtrering i OTLP-collector.

## Fejlfindingstips

- **Gateway kan ikke nås?** Kør `openclaw doctor` først.
- **Logs er tomme?** Tjek at Gateway kører og skriver til filstien
  i `logging.file`.
- **Brug for flere detaljer?** Sæt `logging.level` til `debug` eller `trace` og prøv igen.
