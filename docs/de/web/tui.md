---
summary: "„Terminal-UI (TUI): Verbindung zum Gateway von jedem Rechner aus“"
read_when:
  - Sie möchten eine einsteigerfreundliche Einführung in die TUI
  - Sie benötigen die vollständige Liste der TUI-Funktionen, -Befehle und -Tastenkürzel
title: "„TUI“"
---

# TUI (Terminal-UI)

## Schnellstart

1. Starten Sie das Gateway.

```bash
openclaw gateway
```

2. Öffnen Sie die TUI.

```bash
openclaw tui
```

3. Geben Sie eine Nachricht ein und drücken Sie Enter.

Remote-Gateway:

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

Verwenden Sie `--password`, wenn Ihr Gateway Passwortauthentifizierung nutzt.

## Was Sie sehen

- Kopfzeile: Verbindungs-URL, aktueller Agent, aktuelle Sitzung.
- Chatprotokoll: Benutzernachrichten, Assistentenantworten, Systemhinweise, Werkzeugkarten.
- Statuszeile: Verbindungs-/Ausführungsstatus (connecting, running, streaming, idle, error).
- Fußzeile: Verbindungsstatus + Agent + Sitzung + Modell + think/verbose/reasoning + Token-Zähler + deliver.
- Eingabe: Texteditor mit Autovervollständigung.

## Mentales Modell: Agents + Sitzungen

- Agents sind eindeutige Slugs (z. B. `main`, `research`). Das Gateway stellt die Liste bereit.
- Sitzungen gehören zum aktuellen Agent.
- Sitzungsschlüssel werden als `agent:<agentId>:<sessionKey>` gespeichert.
  - Wenn Sie `/session main` eingeben, erweitert die TUI dies zu `agent:<currentAgent>:main`.
  - Wenn Sie `/session agent:other:main` eingeben, wechseln Sie explizit zu dieser Agent-Sitzung.
- Sitzungsbereich:
  - `per-sender` (Standard): Jeder Agent hat viele Sitzungen.
  - `global`: Die TUI verwendet immer die Sitzung `global` (der Picker kann leer sein).
- Der aktuelle Agent + die aktuelle Sitzung sind stets in der Fußzeile sichtbar.

## Senden + Zustellung

- Nachrichten werden an das Gateway gesendet; die Zustellung an Anbieter ist standardmäßig deaktiviert.
- Lieferung abschalten am:
  - `/deliver on`
  - oder über das Einstellungs-Panel
  - oder starten Sie mit `openclaw tui --deliver`

## Picker + Overlays

- Modell-Picker: Verfügbare Modelle auflisten und Sitzungs-Override setzen.
- Agent-Picker: Einen anderen Agent auswählen.
- Sitzungs-Picker: Zeigt nur Sitzungen für den aktuellen Agent.
- Einstellungen: Zustellung, Erweiterung der Werkzeugausgabe und Sichtbarkeit des Denkens umschalten.

## Tastenkürzel

- Enter: Nachricht senden
- Esc: Aktiven Lauf abbrechen
- Ctrl+C: Eingabe leeren (zweimal drücken zum Beenden)
- Strg+D: Beenden
- Ctrl+L: Modell-Picker
- Ctrl+G: Agent-Picker
- Ctrl+P: Sitzungs-Picker
- Ctrl+O: Erweiterung der Werkzeugausgabe umschalten
- Ctrl+T: Sichtbarkeit des Denkens umschalten (lädt den Verlauf neu)

## tools/slash-commands.md

Kern:

- `/help`
- `/status`
- `/agent <id>` (oder `/agents`)
- `/session <key>` (oder `/sessions`)
- `/model <provider/model>` (oder `/models`)

Sitzungssteuerung:

- `/think <off|minimal|low|medium|high>`
- `/verbose <on|full|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full>`
- `/elevated <on|off|ask|full>` (Alias: `/elev`)
- `/activation <mention|always>`
- `/deliver <on|off>`

Sitzungslebenszyklus:

- `/new` oder `/reset` (setzt die Sitzung zurück)
- `/abort` (bricht den aktiven Lauf ab)
- `/settings`
- `/exit`

Andere Gateway-Slash-Befehle (z. B. `/context`) werden an das Gateway weitergeleitet und als Systemausgabe angezeigt. Siehe [Slash-Befehle](/tools/slash-commands).

## Lokale Shell-Befehle

- Stellen Sie einer Zeile `!` voran, um einen lokalen Shell-Befehl auf dem TUI-Host auszuführen.
- Die TUI fragt pro Sitzung einmal nach der Erlaubnis zur lokalen Ausführung; bei Ablehnung bleibt `!` für die Sitzung deaktiviert.
- Befehle laufen in einer frischen, nicht-interaktiven Shell im Arbeitsverzeichnis der TUI (keine persistente `cd`/env).
- Ein einzelnes `!` wird als normale Nachricht gesendet; führende Leerzeichen lösen keine lokale Ausführung aus.

## Werkzeugausgabe

- Werkzeugaufrufe erscheinen als Karten mit Argumenten + Ergebnissen.
- Ctrl+O schaltet zwischen eingeklappter/ausgeklappter Ansicht um.
- Während Werkzeuge laufen, werden Teilaktualisierungen in dieselbe Karte gestreamt.

## Verlauf + Streaming

- Beim Verbinden lädt die TUI den neuesten Verlauf (standardmäßig 200 Nachrichten).
- Streaming-Antworten werden bis zur Finalisierung an Ort und Stelle aktualisiert.
- Die TUI lauscht außerdem auf Agent-Werkzeugereignisse für reichhaltigere Werkzeugkarten.

## Verbindungsdetails

- Die TUI registriert sich beim Gateway als `mode: "tui"`.
- Wiederverbindungen zeigen eine Systemmeldung; Ereignislücken werden im Protokoll angezeigt.

## Optionen

- `--url <url>`: Gateway-WebSocket-URL (Standard aus der Konfiguration oder `ws://127.0.0.1:<port>`)
- `--token <token>`: Gateway-Token (falls erforderlich)
- `--password <password>`: Gateway-Passwort (falls erforderlich)
- `--session <key>`: Sitzungsschlüssel (Standard: `main` oder `global`, wenn der Bereich global ist)
- `--deliver`: Zustellung der Assistentenantworten an den Anbieter (standardmäßig aus)
- `--thinking <level>`: Denkstufe für das Senden überschreiben
- `--timeout-ms <ms>`: Agent-Timeout in ms (Standard: `agents.defaults.timeoutSeconds`)

Hinweis: Wenn Sie `--url` setzen, greift die TUI nicht auf Konfiguration oder Umgebungsanmeldeinformationen zurück.
Übergeben Sie `--token` oder `--password` explizit. Fehlende explizite Anmeldeinformationen sind ein Fehler.

## Fehlerbehebung

Keine Ausgabe nach dem Senden einer Nachricht:

- Führen Sie `/status` in der TUI aus, um zu bestätigen, dass das Gateway verbunden und im Leerlauf/beschäftigt ist.
- Prüfen Sie die Gateway-Logs: `openclaw logs --follow`.
- Bestätigen Sie, dass der Agent laufen kann: `openclaw status` und `openclaw models status`.
- Wenn Sie Nachrichten in einem Chat-Kanal erwarten, aktivieren Sie die Zustellung (`/deliver on` oder `--deliver`).
- `--history-limit <n>`: Zu ladende Verlaufseinträge (Standard: 200)

## Verbindungs-Fehlerbehebung

- `disconnected`: Stellen Sie sicher, dass das Gateway läuft und Ihre `--url/--token/--password` korrekt sind.
- Keine Agents im Picker: Prüfen Sie `openclaw agents list` und Ihre Routing-Konfiguration.
- Leerer Sitzungs-Picker: Möglicherweise befinden Sie sich im globalen Bereich oder haben noch keine Sitzungen.
