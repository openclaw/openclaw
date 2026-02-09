---
summary: "Protokollierungsüberblick: Dateiprotokolle, Konsolenausgabe, CLI-Tailing und die Control UI"
read_when:
  - Sie benötigen einen einsteigerfreundlichen Überblick zur Protokollierung
  - Sie möchten Protokollierungsstufen oder -formate konfigurieren
  - Sie beheben Fehler und müssen Protokolle schnell finden
title: "Logging"
---

# Logging

OpenClaw protokolliert an zwei Stellen:

- **Dateiprotokolle** (JSON-Zeilen), die vom Gateway geschrieben werden.
- **Konsolenausgabe**, die in Terminals und der Control UI angezeigt wird.

Diese Seite erläutert, wo Protokolle liegen, wie man sie liest und wie man
Protokollierungsstufen und -formate konfiguriert.

## Wo Logs leben

Standardmäßig schreibt das Gateway eine rotierende Protokolldatei unter:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

Das Datum verwendet die lokale Zeitzone des Gateway-Hosts.

Sie können dies in `~/.openclaw/openclaw.json` überschreiben:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## Protokolle lesen

### CLI: Live-Tail (empfohlen)

Verwenden Sie die CLI, um die Gateway-Protokolldatei per RPC zu verfolgen:

```bash
openclaw logs --follow
```

Ausgabemodus:

- **TTY-Sitzungen**: ansprechend, farbig, strukturierte Protokollzeilen.
- **Nicht-TTY-Sitzungen**: Klartext.
- `--json`: zeilengetrenntes JSON (ein Protokollereignis pro Zeile).
- `--plain`: Klartext in TTY-Sitzungen erzwingen.
- `--no-color`: ANSI-Farben deaktivieren.

Im JSON-Modus gibt die CLI `type`-getaggte Objekte aus:

- `meta`: Stream-Metadaten (Datei, Cursor, Größe)
- `log`: geparster Protokolleintrag
- `notice`: Hinweise zu Trunkierung/Rotation
- `raw`: nicht geparste Protokollzeile

Wenn das Gateway nicht erreichbar ist, gibt die CLI einen kurzen Hinweis aus, auszuführen:

```bash
openclaw doctor
```

### Control UI (Web)

Der **Logs**-Tab der Control UI verfolgt dieselbe Datei mithilfe von `logs.tail`.
Siehe [/web/control-ui](/web/control-ui), um zu erfahren, wie Sie sie öffnen.

### Nur-Kanal-Protokolle

Um Kanalaktivitäten (WhatsApp/Telegram/etc.) zu filtern, verwenden Sie:

```bash
openclaw channels logs --channel whatsapp
```

## Protokollformate

### Dateiprotokolle (JSONL)

Jede Zeile in der Protokolldatei ist ein JSON-Objekt. Die CLI und die Control UI
parsen diese Einträge, um strukturierte Ausgaben darzustellen (Zeit, Stufe,
Subsystem, Nachricht).

### Konsolenausgabe

Konsolenprotokolle sind **TTY-aware** und für gute Lesbarkeit formatiert:

- Subsystem-Präfixe (z. B. `gateway/channels/whatsapp`)
- Stufen-Farbgebung (info/warn/error)
- Optionaler kompakter oder JSON-Modus

Die Konsolenformatierung wird über `logging.consoleStyle` gesteuert.

## Protokollierung konfigurieren

Die gesamte Protokollierungskonfiguration befindet sich unter `logging` in `~/.openclaw/openclaw.json`.

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

### Log-Level

- `logging.level`: Stufe der **Dateiprotokolle** (JSONL).
- `logging.consoleLevel`: **Konsolen**-Ausführlichkeitsstufe.

`--verbose` wirkt sich nur auf die Konsolenausgabe aus; die Stufen der Dateiprotokolle werden nicht geändert.

### Konsolenstile

`logging.consoleStyle`:

- `pretty`: benutzerfreundlich, farbig, mit Zeitstempeln.
- `compact`: kompaktere Ausgabe (ideal für lange Sitzungen).
- `json`: JSON pro Zeile (für Log-Prozessoren).

### Redaction

Werkzeugzusammenfassungen können sensible Tokens schwärzen, bevor sie die Konsole erreichen:

- `logging.redactSensitive`: `off` | `tools` (Standard: `tools`)
- `logging.redactPatterns`: Liste von Regex-Zeichenfolgen zur Überschreibung des Standardsatzes

Die Schwärzung betrifft **nur die Konsolenausgabe** und verändert keine Dateiprotokolle.

## Diagnostik + OpenTelemetry

Diagnostik sind strukturierte, maschinenlesbare Ereignisse für Modellläufe **und**
Telemetrie des Nachrichtenflusses (Webhooks, Warteschlangen, Sitzungszustand). Sie
ersetzen Protokolle **nicht**; sie dienen der Bereitstellung von Metriken, Traces
und anderen Exportern.

Diagnostikereignisse werden im Prozess erzeugt, Exporter werden jedoch nur
angebunden, wenn Diagnostik **und** das Exporter-Plugin aktiviert sind.

### OpenTelemetry vs. OTLP

- **OpenTelemetry (OTel)**: das Datenmodell + SDKs für Traces, Metriken und Logs.
- **OTLP**: das Drahtprotokoll zum Export von OTel-Daten an einen Collector/Backend.
- OpenClaw exportiert derzeit über **OTLP/HTTP (protobuf)**.

### Exportierte Signale

- **Metriken**: Zähler + Histogramme (Token-Nutzung, Nachrichtenfluss, Warteschlangen).
- **Traces**: Spans für Modellnutzung + Webhook-/Nachrichtenverarbeitung.
- **Logs**: Export über OTLP, wenn `diagnostics.otel.logs` aktiviert ist. Das Log-Volumen
  kann hoch sein; beachten Sie `logging.level` und Exporter-Filter.

### Katalog der Diagnostikereignisse

Modellnutzung:

- `model.usage`: Tokens, Kosten, Dauer, Kontext, Anbieter/Modell/Kanal, Sitzungs-IDs.

Nachrichtenfluss:

- `webhook.received`: Webhook-Eingang pro Kanal.
- `webhook.processed`: Webhook verarbeitet + Dauer.
- `webhook.error`: Fehler im Webhook-Handler.
- `message.queued`: Nachricht zur Verarbeitung in die Warteschlange gestellt.
- `message.processed`: Ergebnis + Dauer + optionaler Fehler.

Warteschlangen + Sitzungen:

- `queue.lane.enqueue`: Enqueue einer Befehlswarteschlangen-Spur + Tiefe.
- `queue.lane.dequeue`: Dequeue einer Befehlswarteschlangen-Spur + Wartezeit.
- `session.state`: Zustandsübergang der Sitzung + Grund.
- `session.stuck`: Warnung „Sitzung hängt“ + Alter.
- `run.attempt`: Metadaten zu Lauf-Wiederholungen/-Versuchen.
- `diagnostic.heartbeat`: Aggregierte Zähler (Webhooks/Warteschlange/Sitzung).

### Diagnostik aktivieren (ohne Exporter)

Verwenden Sie dies, wenn Sie Diagnostikereignisse für Plugins oder benutzerdefinierte Senken verfügbar machen möchten:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### Diagnostik-Flags (gezielte Logs)

Verwenden Sie Flags, um zusätzliche, gezielte Debug-Logs zu aktivieren, ohne `logging.level` anzuheben.
Flags sind nicht case-sensitiv und unterstützen Wildcards (z. B. `telegram.*` oder `*`).

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Env-Override (einmalig):

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Hinweise:

- Flag-Logs gehen in die Standard-Protokolldatei (gleich wie `logging.file`).
- Die Ausgabe wird weiterhin gemäß `logging.redactSensitive` geschwärzt.
- Vollständige Anleitung: [/diagnostics/flags](/diagnostics/flags).

### Export zu OpenTelemetry

Diagnostik kann über das `diagnostics-otel`-Plugin (OTLP/HTTP) exportiert werden. Dies
funktioniert mit jedem OpenTelemetry-Collector/Backend, das OTLP/HTTP akzeptiert.

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

Hinweise:

- Sie können das Plugin auch mit `openclaw plugins enable diagnostics-otel` aktivieren.
- `protocol` unterstützt derzeit nur `http/protobuf`. `grpc` wird ignoriert.
- Metriken umfassen Token-Nutzung, Kosten, Kontextgröße, Laufdauer sowie Zähler/Histogramme
  zum Nachrichtenfluss (Webhooks, Warteschlangen, Sitzungszustand, Warteschlangentiefe/-wartezeit).
- Traces/Metriken können mit `traces` / `metrics` umgeschaltet werden (Standard: an). Traces
  enthalten Modellnutzungs-Spans sowie Webhook-/Nachrichtenverarbeitungs-Spans, wenn aktiviert.
- Setzen Sie `headers`, wenn Ihr Collector Authentifizierung erfordert.
- Unterstützte Umgebungsvariablen: `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`.

### Exportierte Metriken (Namen + Typen)

Modellnutzung:

- `openclaw.tokens` (Zähler, Attribute: `openclaw.token`, `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (Zähler, Attribute: `openclaw.channel`, `openclaw.provider`,
  `openclaw.model`)
- `openclaw.run.duration_ms` (Histogramm, Attribute: `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (Histogramm, Attribute: `openclaw.context`,
  `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

Nachrichtenfluss:

- `openclaw.webhook.received` (Zähler, Attribute: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.error` (Zähler, Attribute: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (Histogramm, Attribute: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.message.queued` (Zähler, Attribute: `openclaw.channel`,
  `openclaw.source`)
- `openclaw.message.processed` (Zähler, Attribute: `openclaw.channel`,
  `openclaw.outcome`)
- `openclaw.message.duration_ms` (Histogramm, Attribute: `openclaw.channel`,
  `openclaw.outcome`)

Warteschlangen + Sitzungen:

- `openclaw.queue.lane.enqueue` (Zähler, Attribute: `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (Zähler, Attribute: `openclaw.lane`)
- `openclaw.queue.depth` (Histogramm, Attribute: `openclaw.lane` oder
  `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (Histogramm, Attribute: `openclaw.lane`)
- `openclaw.session.state` (Zähler, Attribute: `openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (Zähler, Attribute: `openclaw.state`)
- `openclaw.session.stuck_age_ms` (Histogramm, Attribute: `openclaw.state`)
- `openclaw.run.attempt` (Zähler, Attribute: `openclaw.attempt`)

### Exportierte Spans (Namen + Schlüsselattribute)

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

### Sampling + Flushen

- Trace-Sampling: `diagnostics.otel.sampleRate` (0,0–1,0, nur Root-Spans).
- Metrik-Exportintervall: `diagnostics.otel.flushIntervalMs` (min. 1000 ms).

### Protokollhinweise

- OTLP/HTTP-Endpunkte können über `diagnostics.otel.endpoint` oder
  `OTEL_EXPORTER_OTLP_ENDPOINT` gesetzt werden.
- Wenn der Endpunkt bereits `/v1/traces` oder `/v1/metrics` enthält, wird er unverändert verwendet.
- Wenn der Endpunkt bereits `/v1/logs` enthält, wird er unverändert für Logs verwendet.
- `diagnostics.otel.logs` aktiviert den OTLP-Log-Export für die Hauptlogger-Ausgabe.

### Verhalten beim Log-Export

- OTLP-Logs verwenden dieselben strukturierten Datensätze, die in `logging.file` geschrieben werden.
- Beachten Sie `logging.level` (Datei-Protokollstufe). Die Konsolenschwärzung gilt **nicht**
  für OTLP-Logs.
- Installationen mit hohem Volumen sollten OTLP-Collector-Sampling/-Filterung bevorzugen.

## Tipps zur Fehlerbehebung

- **Gateway nicht erreichbar?** Führen Sie zuerst `openclaw doctor` aus.
- **Protokolle leer?** Prüfen Sie, dass das Gateway läuft und in den Dateipfad
  aus `logging.file` schreibt.
- **Mehr Details nötig?** Setzen Sie `logging.level` auf `debug` oder `trace` und versuchen Sie es erneut.
