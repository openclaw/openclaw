---
summary: "Logging-Oberflächen, Dateilogs, WS-Log-Stile und Konsolenformatierung"
read_when:
  - Ändern der Logging-Ausgabe oder -Formate
  - Debugging der CLI- oder Gateway-Ausgabe
title: "Logging"
---

# Logging

Für einen benutzerorientierten Überblick (CLI + Control UI + Konfiguration) siehe [/logging](/logging).

OpenClaw hat zwei Log-„Oberflächen“:

- **Konsolenausgabe** (das, was Sie im Terminal / in der Debug-UI sehen).
- **Dateilogs** (JSON-Zeilen), die vom Gateway-Logger geschrieben werden.

## Dateibasierter Logger

- Die standardmäßige rotierende Logdatei liegt unter `/tmp/openclaw/` (eine Datei pro Tag): `openclaw-YYYY-MM-DD.log`
  - Das Datum verwendet die lokale Zeitzone des Gateway-Hosts.
- Der Pfad und das Level der Logdatei können über `~/.openclaw/openclaw.json` konfiguriert werden:
  - `logging.file`
  - `logging.level`

Das Dateiformat ist ein JSON-Objekt pro Zeile.

Der Reiter „Logs“ der Control UI verfolgt diese Datei über das Gateway (`logs.tail`).
Die CLI kann dasselbe tun:

```bash
openclaw logs --follow
```

**Verbose vs. Log-Level**

- **Dateilogs** werden ausschließlich durch `logging.level` gesteuert.
- `--verbose` beeinflusst nur die **Konsolen-Verbosity** (und den WS-Log-Stil); es erhöht **nicht**
  das Dateilog-Level.
- Um ausschließlich-verbose Details in Dateilogs zu erfassen, setzen Sie `logging.level` auf `debug` oder
  `trace`.

## Konsolen-Erfassung

Die CLI erfasst `console.log/info/warn/error/debug/trace` und schreibt sie in die Dateilogs,
während sie weiterhin nach stdout/stderr ausgibt.

Sie können die Konsolen-Verbosity unabhängig einstellen über:

- `logging.consoleLevel` (Standard `info`)
- `logging.consoleStyle` (`pretty` | `compact` | `json`)

## Schwärzung von Tool-Zusammenfassungen

Ausführliche Tool-Zusammenfassungen (z. B. `🛠️ Exec: ...`) können sensible Tokens maskieren, bevor sie den
Konsolenstrom erreichen. Dies gilt **nur für Tools** und verändert keine Dateilogs.

- `logging.redactSensitive`: `off` | `tools` (Standard: `tools`)
- `logging.redactPatterns`: Array von Regex-Strings (überschreibt Standardwerte)
  - Verwenden Sie rohe Regex-Strings (automatisch `gi`), oder `/pattern/flags`, wenn Sie benutzerdefinierte Flags benötigen.
  - Treffer werden maskiert, indem die ersten 6 + die letzten 4 Zeichen beibehalten werden (Länge >= 18), andernfalls `***`.
  - Die Standardwerte decken gängige Schlüsselzuweisungen, CLI-Flags, JSON-Felder, Bearer-Header, PEM-Blöcke und verbreitete Token-Präfixe ab.

## Gateway-WebSocket-Logs

Das Gateway gibt WebSocket-Protokolllogs in zwei Modi aus:

- **Normalmodus (kein `--verbose`)**: es werden nur „interessante“ RPC-Ergebnisse ausgegeben:
  - Fehler (`ok=false`)
  - langsame Aufrufe (Standard-Schwellenwert: `>= 50ms`)
  - Parse-Fehler
- **Verbose-Modus (`--verbose`)**: gibt den gesamten WS-Anfrage/Antwort-Verkehr aus.

### WS-Log-Stil

`openclaw gateway` unterstützt einen Gateway-spezifischen Stilwechsel:

- `--ws-log auto` (Standard): Normalmodus ist optimiert; Verbose-Modus verwendet kompakte Ausgabe
- `--ws-log compact`: kompakte Ausgabe (gepaarte Anfrage/Antwort) bei Verbose
- `--ws-log full`: vollständige Ausgabe pro Frame bei Verbose
- `--compact`: Alias für `--ws-log compact`

Beispiele:

```bash
# optimized (only errors/slow)
openclaw gateway

# show all WS traffic (paired)
openclaw gateway --verbose --ws-log compact

# show all WS traffic (full meta)
openclaw gateway --verbose --ws-log full
```

## Konsolenformatierung (Subsystem-Logging)

Der Konsolen-Formatter ist **TTY-bewusst** und gibt konsistente, präfixierte Zeilen aus.
Subsystem-Logger halten die Ausgabe gruppiert und gut scannbar.

Verhalten:

- **Subsystem-Präfixe** in jeder Zeile (z. B. `[gateway]`, `[canvas]`, `[tailscale]`)
- **Subsystem-Farben** (stabil pro Subsystem) plus Level-Färbung
- **Farbe, wenn die Ausgabe ein TTY ist oder die Umgebung wie ein reichhaltiges Terminal wirkt** (`TERM`/`COLORTERM`/`TERM_PROGRAM`), berücksichtigt `NO_COLOR`
- **Verkürzte Subsystem-Präfixe**: entfernt führende `gateway/` + `channels/`, behält die letzten 2 Segmente (z. B. `whatsapp/outbound`)
- **Sub-Logger nach Subsystem** (automatisches Präfix + strukturiertes Feld `{ subsystem }`)
- **`logRaw()`** für QR/UX-Ausgabe (kein Präfix, keine Formatierung)
- **Konsolenstile** (z. B. `pretty | compact | json`)
- **Konsolen-Log-Level** getrennt vom Dateilog-Level (Datei behält volle Details, wenn `logging.level` auf `debug`/`trace` gesetzt ist)
- **WhatsApp-Nachrichteninhalte** werden auf `debug` geloggt (verwenden Sie `--verbose`, um sie zu sehen)

Dies hält bestehende Dateilogs stabil und macht interaktive Ausgaben gut scannbar.
