---
summary: "Översikt över loggning: filloggar, konsolutdata, CLI‑tailing och Control UI"
read_when:
  - Du behöver en nybörjarvänlig översikt över loggning
  - Du vill konfigurera loggnivåer eller format
  - Du felsöker och behöver hitta loggar snabbt
title: "Loggning"
---

# Loggning

OpenClaw loggar på två ställen:

- **Filloggar** (JSON‑rader) som skrivs av Gateway.
- **Konsolutdata** som visas i terminaler och Control UI.

Den här sidan förklarar var loggar finns, hur du läser dem och hur du
konfigurerar loggnivåer och format.

## Var loggar finns

Som standard skriver Gateway en rullande loggfil under:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

Datumet använder gateway‑värdens lokala tidszon.

Du kan åsidosätta detta i `~/.openclaw/openclaw.json`:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## Hur man läser loggar

### CLI: live tail (rekommenderas)

Använd CLI:t för att taila gateway‑loggfilen via RPC:

```bash
openclaw logs --follow
```

Utdatalägen:

- **TTY‑sessioner**: snygga, färglagda, strukturerade loggrader.
- **Icke‑TTY‑sessioner**: ren text.
- `--json`: radavgränsad JSON (en logghändelse per rad).
- `--plain`: tvinga ren text i TTY‑sessioner.
- `--no-color`: inaktivera ANSI‑färger.

I JSON‑läge skickar CLI:t `type`‑taggade objekt:

- `meta`: strömmetadata (fil, markör, storlek)
- `log`: tolkad loggpost
- `notice`: tips om trunkering/rotation
- `raw`: otolkad loggrad

Om Gateway inte går att nå skriver CLI:t en kort ledtråd om att köra:

```bash
openclaw doctor
```

### Control UI (webb)

Control UI: s **Loggar** fliken svansar samma fil med `logs.tail`.
Se [/web/control-ui](/web/control-ui) för hur man öppnar den.

### Kanal‑endast‑loggar

För att filtrera kanalaktivitet (WhatsApp/Telegram/etc), använd:

```bash
openclaw channels logs --channel whatsapp
```

## Loggformat

### Filloggar (JSONL)

Varje rad i loggfilen är ett JSON-objekt. CLI och Control UI tolkar dessa
poster för att återge strukturerad utdata (tid, nivå, delsystem, meddelande).

### Konsolutdata

Konsolloggar är **TTY‑medvetna** och formaterade för läsbarhet:

- Prefix för delsystem (t.ex. 'gateway/channels/whatsapp')
- Nivåfärgning (info/warn/error)
- Valfritt kompakt‑ eller JSON‑läge

Konsolformatering styrs av `logging.consoleStyle`.

## Konfigurera loggning

All loggningskonfiguration finns under `logging` i `~/.openclaw/openclaw.json`.

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

### Loggnivåer

- `logging.level`: nivå för **filloggar** (JSONL).
- `logging.consoleLevel`: detaljeringsnivå för **konsol**.

`--verbose` påverkar endast konsolutdata; den ändrar inte nivåerna för filloggar.

### Konsolstilar

`logging.consoleStyle`:

- `pretty`: lättläst, färgad, med tidsstämplar.
- `compact`: tätare utdata (bäst för långa sessioner).
- `json`: JSON per rad (för loggprocessorer).

### Maskering

Verktygssammanfattningar kan maskera känsliga tokens innan de når konsolen:

- `logging.redactSensitive`: `off` | `tools` (standard: `tools`)
- `logging.redactPatterns`: lista med regex‑strängar för att åsidosätta standarduppsättningen

Maskering påverkar **endast konsolutdata** och ändrar inte filloggar.

## Diagnostik + OpenTelemetry

Diagnostik är strukturerad, maskinläsbara händelser för modellkörningar **och**
meddelandeflödestelemetri (webbkrokar, köer, sessionsläge). De ersätter **inte**
stockar; de finns för att mata mätvärden, spår och andra exportörer.

Diagnostikhändelser emitteras i processen, men exportörer kopplas endast på när
diagnostik **och** exportörspluginen är aktiverade.

### OpenTelemetry vs OTLP

- **OpenTelemetry (OTel)**: datamodellen + SDK:er för spår, mätvärden och loggar.
- **OTLP**: wire‑protokollet som används för att exportera OTel‑data till en
  collector/backend.
- OpenClaw exporterar via **OTLP/HTTP (protobuf)** i dagsläget.

### Exporterade signaler

- **Mätvärden**: räknare + histogram (tokenanvändning, meddelandeflöde, köhantering).
- **Spår**: spann för modell‑användning + webhook-/meddelandebearbetning.
- **Loggar**: exporteras över OTLP när `diagnostics.otel.logs` är aktiverat. Log
  volym kan vara hög; tänk på `logging.level` och exportörens filter.

### Katalog över diagnostikhändelser

Modellanvändning:

- `model.usage`: tokens, kostnad, varaktighet, kontext, leverantör/modell/kanal, sessions‑ID:n.

Meddelandeflöde:

- `webhook.received`: webhook‑ingång per kanal.
- `webhook.processed`: webhook hanterad + varaktighet.
- `webhook.error`: fel i webhook‑hanterare.
- `message.queued`: meddelande kölagt för bearbetning.
- `message.processed`: utfall + varaktighet + valfritt fel.

Kö + session:

- `queue.lane.enqueue`: köläggning i kommandokö‑lane + djup.
- `queue.lane.dequeue`: uttag från kommandokö‑lane + väntetid.
- `session.state`: övergång i sessionstillstånd + orsak.
- `session.stuck`: varning om fast session + ålder.
- `run.attempt`: metadata för körningsförsök/omförsök.
- `diagnostic.heartbeat`: aggregerade räknare (webhooks/kö/session).

### Aktivera diagnostik (ingen exportör)

Använd detta om du vill ha diagnostikhändelser tillgängliga för plugins eller
egna sinks:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### Diagnostikflaggor (riktade loggar)

Använd flaggor för att slå på extra, riktade debug-loggar utan att höja `logging.level`.
Flaggor är skiftlägesokänsliga och stöder jokertecken (t.ex. `telegram.*` eller `*`).

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Miljöåsidossättning (engångs):

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Noteringar:

- Flagglagda loggar går till standardloggfilen (samma som `logging.file`).
- Utdata maskeras fortfarande enligt `logging.redactSensitive`.
- Fullständig guide: [/diagnostics/flags](/diagnostics/flags).

### Exportera till OpenTelemetry

Diagnostik kan exporteras via pluginen `diagnostics-otel` (OTLP / HTTP). Detta
fungerar med alla OpenTelemetry collector/backend som accepterar OTLP/HTTP.

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

Noteringar:

- Du kan också aktivera pluginet med `openclaw plugins enable diagnostics-otel`.
- `protocol` stöder för närvarande endast `http/protobuf`. `grpc` ignoreras.
- Mätvärden inkluderar tokenanvändning, kostnad, kontextstorlek, körningstid samt
  räknare/histogram för meddelandeflöde (webhooks, köhantering, sessionstillstånd,
  ködjup/väntetid).
- Traces/metrics kan växlas med `traces` / `metrics` (standard: on). Spår
  inkluderar modellanvändningsområden plus webbhook/meddelandehantering när aktiverad.
- Sätt `headers` när din collector kräver autentisering.
- Miljövariabler som stöds: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`.

### Exporterade mätvärden (namn + typer)

Modellanvändning:

- `openclaw.tokens` (räknare, attribut: `openclaw.token`, `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (räknare, attribut: `openclaw.channel`, `openclaw.provider`,
  `openclaw.model`)
- `openclaw.run.duration_ms` (histogram, attribut: `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (histogram, attribut: `openclaw.context`,
  `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

Meddelandeflöde:

- `openclaw.webhook.received` (räknare, attribut: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.error` (räknare, attribut: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (histogram, attribut: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.message.queued` (räknare, attribut: `openclaw.channel`,
  `openclaw.source`)
- `openclaw.message.processed` (räknare, attribut: `openclaw.channel`,
  `openclaw.outcome`)
- `openclaw.message.duration_ms` (histogram, attribut: `openclaw.channel`,
  `openclaw.outcome`)

Köer + sessioner:

- `openclaw.queue.lane.enqueue` (räknare, attribut: `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (räknare, attribut: `openclaw.lane`)
- `openclaw.queue.depth` (histogram, attribut: `openclaw.lane` eller
  `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (histogram, attribut: `openclaw.lane`)
- `openclaw.session.state` (räknare, attribut: `openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (räknare, attribut: `openclaw.state`)
- `openclaw.session.stuck_age_ms` (histogram, attribut: `openclaw.state`)
- `openclaw.run.attempt` (räknare, attribut: `openclaw.attempt`)

### Exporterade spann (namn + nyckelattribut)

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

### Sampling + flushning

- Spårsampling: `diagnostics.otel.sampleRate` (0,0–1,0, endast root‑spann).
- Exportintervall för mätvärden: `diagnostics.otel.flushIntervalMs` (minst 1000 ms).

### Protokollnoteringar

- OTLP/HTTP‑slutpunkter kan ställas in via `diagnostics.otel.endpoint` eller
  `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Om slutpunkten redan innehåller `/v1/traces` eller `/v1/metrics` används
  den som den är.
- Om slutpunkten redan innehåller `/v1/logs` används den som den är för
  loggar.
- `diagnostics.otel.logs` aktiverar OTLP‑loggexport för huvudloggarens utdata.

### Beteende för loggexport

- OTLP‑loggar använder samma strukturerade poster som skrivs till
  `logging.file`.
- Respektera `logging.level` (filloggnivå). Konsolens redaction applicerar **inte**
  till OTLP-loggar.
- Installationer med hög volym bör föredra sampling/filtrering i OTLP‑collector.

## Felsökningstips

- **Gateway går inte att nå?** Kör `openclaw doctor` först.
- **Loggar tomma?** Kontrollera att Gateway körs och skriver till filsökvägen i
  `logging.file`.
- **Behöver du mer detalj?** Sätt `logging.level` till `debug` eller
  `trace` och försök igen.
