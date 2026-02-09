---
summary: "Gateway-levenscyclus op macOS (launchd)"
read_when:
  - Integratie van de mac-app met de Gateway-levenscyclus
title: "Gateway-levenscyclus"
---

# Gateway-levenscyclus op macOS

De macOS-app **beheert de Gateway standaard via launchd** en start
de Gateway niet als een child process. De app probeert eerst verbinding te maken
met een al draaiende Gateway op de geconfigureerde poort; als er geen bereikbaar
exemplaar is, schakelt zij de launchd-service in via de externe `openclaw` CLI
(geen embedded runtime). Dit zorgt voor betrouwbare automatische start bij inloggen
en herstart na crashes.

Child-process-modus (Gateway rechtstreeks door de app gestart) is **momenteel niet in gebruik**.
Als je een strakkere koppeling met de UI nodig hebt, start de Gateway dan handmatig
in een terminal.

## Standaardgedrag (launchd)

- De app installeert een per-gebruiker LaunchAgent met label `bot.molt.gateway`
  (of `bot.molt.<profile>` bij gebruik van `--profile`/`OPENCLAW_PROFILE`; legacy `com.openclaw.*` wordt ondersteund).
- Wanneer de lokale modus is ingeschakeld, zorgt de app ervoor dat de LaunchAgent
  geladen is en start zij de Gateway indien nodig.
- Logs worden geschreven naar het launchd Gateway-logpad (zichtbaar in Debug Settings).

Veelgebruikte opdrachten:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Vervang het label door `bot.molt.<profile>` bij het uitvoeren van een benoemd profiel.

## Ongesigneerde dev-builds

`scripts/restart-mac.sh --no-sign` is bedoeld voor snelle lokale builds wanneer je geen
ondertekeningssleutels hebt. Om te voorkomen dat launchd naar een ongesigneerde
relay-binary verwijst, doet het volgende:

- Schrijft `~/.openclaw/disable-launchagent`.

Gesigneerde runs van `scripts/restart-mac.sh` verwijderen deze override als de marker
aanwezig is. Handmatig resetten:

```bash
rm ~/.openclaw/disable-launchagent
```

## Alleen-koppelen-modus

Om de macOS-app te dwingen **nooit launchd te installeren of te beheren**, start je
haar met `--attach-only` (of `--no-launchd`). Dit zet `~/.openclaw/disable-launchagent`,
waardoor de app alleen koppelt aan een al draaiende Gateway. Je kunt hetzelfde
gedrag ook omschakelen in Debug Settings.

## Remote-modus

Remote-modus start nooit een lokale Gateway. De app gebruikt een SSH-tunnel naar
de externe host en verbindt via die tunnel.

## Waarom we launchd verkiezen

- Automatische start bij inloggen.
- Ingebouwde herstart-/KeepAlive-semantiek.
- Voorspelbare logs en supervisie.

Als een echte child-process-modus ooit weer nodig is, moet die worden gedocumenteerd
als een aparte, expliciete dev-only modus.
