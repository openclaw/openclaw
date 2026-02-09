---
summary: "„Diagnose-Flags für gezielte Debug-Logs“"
read_when:
  - Sie benötigen gezielte Debug-Logs, ohne globale Logging-Level zu erhöhen
  - Sie müssen subsystem-spezifische Logs für den Support erfassen
title: "„Diagnose-Flags“"
---

# Diagnose-Flags

Diagnose-Flags ermöglichen es Ihnen, gezielte Debug-Logs zu aktivieren, ohne überall ausführliches Logging einzuschalten. Flags sind optional (Opt-in) und haben keine Wirkung, sofern ein Subsystem sie nicht prüft.

## So funktioniert es

- Flags sind Zeichenketten (ohne Beachtung der Groß-/Kleinschreibung).
- Sie können Flags in der Konfiguration oder per Umgebungsvariablen-Override aktivieren.
- Wildcards werden unterstützt:
  - `telegram.*` entspricht `telegram.http`
  - `*` aktiviert alle Flags

## Aktivieren über die Konfiguration

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Mehrere Flags:

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

Starten Sie das Gateway nach dem Ändern der Flags neu.

## Env-Override (einmalig)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Alle Flags deaktivieren:

```bash
OPENCLAW_DIAGNOSTICS=0
```

## Wohin die Logs geschrieben werden

Flags schreiben Logs in die standardmäßige Diagnose-Logdatei. Standardmäßig:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

Wenn Sie `logging.file` setzen, wird stattdessen dieser Pfad verwendet. Die Logs liegen im JSONL-Format vor (ein JSON-Objekt pro Zeile). Die Maskierung greift weiterhin gemäß `logging.redactSensitive`.

## Logs extrahieren

Wählen Sie die neueste Logdatei:

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

Nach Telegram-HTTP-Diagnosen filtern:

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

Oder beim Reproduzieren fortlaufend anzeigen (tail):

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

Für entfernte Gateways können Sie außerdem `openclaw logs --follow` verwenden (siehe [/cli/logs](/cli/logs)).

## Hinweise

- Wenn `logging.level` höher gesetzt ist als `warn`, können diese Logs unterdrückt werden. Der Standardwert `info` ist in Ordnung.
- Flags können bedenkenlos aktiviert bleiben; sie beeinflussen lediglich das Log-Volumen des jeweiligen Subsystems.
- Verwenden Sie [/logging](/logging), um Log-Ziele, -Level und Maskierung zu ändern.
