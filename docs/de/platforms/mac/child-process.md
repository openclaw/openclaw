---
summary: "„Gateway-Lebenszyklus unter macOS (launchd)“"
read_when:
  - Integration der macOS-App in den Gateway-Lebenszyklus
title: "Gateway-Lebenszyklus"
---

# Gateway-Lebenszyklus unter macOS

Die macOS-App **verwaltet das Gateway standardmäßig über launchd** und startet
das Gateway nicht als Child-Process. Zunächst versucht sie, sich mit einem bereits
laufenden Gateway auf dem konfigurierten Port zu verbinden; ist keines erreichbar,
aktiviert sie den launchd-Dienst über die externe `openclaw` CLI (keine
eingebettete Runtime). Dadurch erhalten Sie einen zuverlässigen automatischen
Start bei der Anmeldung sowie einen Neustart nach Abstürzen.

Der Child-Process-Modus (Gateway wird direkt von der App gestartet) ist derzeit
**nicht in Verwendung**.
Wenn Sie eine engere Kopplung an die UI benötigen,
starten Sie das Gateway manuell in einem Terminal.

## Standardverhalten (launchd)

- Die App installiert einen benutzerspezifischen LaunchAgent mit dem Label
  `bot.molt.gateway`
  (oder `bot.molt.<profile>` bei Verwendung von `--profile`/`OPENCLAW_PROFILE`;
  das Legacy-Label `com.openclaw.*` wird unterstützt).
- Wenn der lokale Modus aktiviert ist, stellt die App sicher, dass der LaunchAgent
  geladen ist, und startet das Gateway bei Bedarf.
- Protokolle werden in den launchd-Gateway-Logpfad geschrieben
  (sichtbar in den Debug-Einstellungen).

Häufige Befehle:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Ersetzen Sie das Label durch `bot.molt.<profile>`, wenn Sie ein benanntes Profil
ausführen.

## Unsigned Dev-Builds

`scripts/restart-mac.sh --no-sign` ist für schnelle lokale Builds gedacht, wenn Sie keine
Signaturschlüssel haben. Um zu verhindern, dass launchd auf ein unsigniertes
Relay-Binary verweist, wird:

- `~/.openclaw/disable-launchagent` geschrieben.

Signierte Ausführungen von `scripts/restart-mac.sh` entfernen diese Übersteuerung, falls
der Marker vorhanden ist. Zum manuellen Zurücksetzen:

```bash
rm ~/.openclaw/disable-launchagent
```

## Attach-only-Modus

Um die macOS-App dazu zu zwingen, **launchd niemals zu installieren oder zu
verwalten**, starten Sie sie mit `--attach-only` (oder `--no-launchd`). Dadurch
wird `~/.openclaw/disable-launchagent` gesetzt, sodass sich die App nur mit einem bereits laufenden
Gateway verbindet. Dasselbe Verhalten können Sie in den Debug-Einstellungen
umschalten.

## Remote-Modus

Der Remote-Modus startet niemals ein lokales Gateway. Die App verwendet einen
SSH-Tunnel zum Remote-Host und verbindet sich über diesen Tunnel.

## Warum wir launchd bevorzugen

- Automatischer Start bei der Anmeldung.
- Integrierte Neustart- und KeepAlive-Semantik.
- Vorhersehbare Protokolle und Überwachung.

Falls jemals wieder ein echter Child-Process-Modus benötigt wird, sollte dieser
als separater, expliziter, nur für Entwickler gedachter Modus dokumentiert
werden.
