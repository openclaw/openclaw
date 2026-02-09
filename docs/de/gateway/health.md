---
summary: "Schritte zur Zustandsprüfung der Kanalkonnektivität"
read_when:
  - Diagnose des Zustands des WhatsApp-Kanals
title: "Health Checks"
---

# Zustandsprüfungen (CLI)

Kurze Anleitung zur Überprüfung der Kanalkonnektivität ohne Rätselraten.

## Schnellprüfungen

- `openclaw status` — lokale Zusammenfassung: Gateway-Erreichbarkeit/-Modus, Update-Hinweis, Alter der verknüpften Kanal-Authentifizierung, Sitzungen + aktuelle Aktivität.
- `openclaw status --all` — vollständige lokale Diagnose (nur lesend, farbig, sicher zum Einfügen für Debugging).
- `openclaw status --deep` — prüft zusätzlich das laufende Gateway (kanalspezifische Probes, sofern unterstützt).
- `openclaw health --json` — fordert vom laufenden Gateway einen vollständigen Zustands-Snapshot an (nur WS; kein direkter Baileys-Socket).
- Senden Sie `/status` als eigenständige Nachricht in WhatsApp/WebChat, um eine Statusantwort zu erhalten, ohne den Agent auszulösen.
- Logs: tail `/tmp/openclaw/openclaw-*.log` und filtern nach `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`.

## Tiefgehende Diagnose

- Anmeldedaten auf dem Datenträger: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime sollte aktuell sein).
- Sitzungsspeicher: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (Pfad kann in der Konfiguration überschrieben werden). Anzahl und aktuelle Empfänger werden über `status` angezeigt.
- Neuverknüpfungsablauf: `openclaw channels logout && openclaw channels login --verbose` bei Statuscodes 409–515 oder wenn `loggedOut` in den Logs erscheint. (Hinweis: Der QR-Login-Flow startet bei Status 515 nach dem Pairing einmal automatisch neu.)

## Wenn etwas fehlschlägt

- `logged out` oder Status 409–515 → neu verknüpfen mit `openclaw channels logout` und anschließend `openclaw channels login`.
- Gateway nicht erreichbar → starten Sie es: `openclaw gateway --port 18789` (verwenden Sie `--force`, wenn der Port belegt ist).
- Keine eingehenden Nachrichten → bestätigen Sie, dass das verknüpfte Telefon online ist und der Absender erlaubt ist (`channels.whatsapp.allowFrom`); bei Gruppenchats stellen Sie sicher, dass Allowlist- und Erwähnungsregeln übereinstimmen (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## Dedizierter „health“-Befehl

`openclaw health --json` fordert vom laufenden Gateway dessen Zustands-Snapshot an (keine direkten Kanal-Sockets aus der CLI). Er meldet verknüpfte Anmeldedaten/Authentifizierungsalter, sofern verfügbar, Zusammenfassungen der kanalspezifischen Probes, eine Zusammenfassung des Sitzungsspeichers sowie die Dauer der Probe. Der Befehl beendet sich mit einem Nicht-Null-Exit-Code, wenn das Gateway nicht erreichbar ist oder die Probe fehlschlägt/timeoutet. Verwenden Sie `--timeout <ms>`, um den Standardwert von 10 s zu überschreiben.
