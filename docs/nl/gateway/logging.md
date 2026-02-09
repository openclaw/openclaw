---
summary: "Logging-oppervlakken, bestandslogs, WS-logstijlen en console-opmaak"
read_when:
  - Wijzigen van logging-uitvoer of -formaten
  - Debuggen van CLI- of gateway-uitvoer
title: "Logging"
---

# Logging

Voor een gebruikersgericht overzicht (CLI + Control UI + config), zie [/logging](/logging).

OpenClaw heeft twee logging-‘oppervlakken’:

- **Console-uitvoer** (wat je ziet in de terminal / Debug UI).
- **Bestandslogs** (JSON-regels) die door de Gateway-logger worden geschreven.

## Bestandsgebaseerde logger

- Standaard roterend logbestand staat onder `/tmp/openclaw/` (één bestand per dag): `openclaw-YYYY-MM-DD.log`
  - De datum gebruikt de lokale tijdzone van de Gateway-host.
- Het pad en het niveau van het logbestand kunnen worden geconfigureerd via `~/.openclaw/openclaw.json`:
  - `logging.file`
  - `logging.level`

Het bestandsformaat is één JSON-object per regel.

Het tabblad Logs in de Control UI volgt dit bestand via de Gateway (`logs.tail`).
De CLI kan hetzelfde doen:

```bash
openclaw logs --follow
```

**Verbose vs. logniveaus**

- **Bestandslogs** worden uitsluitend aangestuurd door `logging.level`.
- `--verbose` beïnvloedt alleen **console-verbosity** (en WS-logstijl); het
  verhoogt **niet** het bestandslogniveau.
- Om details die alleen in verbose-modus verschijnen vast te leggen in bestandslogs, stel `logging.level` in op `debug` of
  `trace`.

## Console-capture

De CLI capteert `console.log/info/warn/error/debug/trace` en schrijft deze naar bestandslogs,
terwijl ze nog steeds naar stdout/stderr worden afgedrukt.

Je kunt de console-verbosity onafhankelijk afstemmen via:

- `logging.consoleLevel` (standaard `info`)
- `logging.consoleStyle` (`pretty` | `compact` | `json`)

## Redactie van tool-samenvattingen

Uitgebreide tool-samenvattingen (bijv. `🛠️ Exec: ...`) kunnen gevoelige tokens maskeren voordat ze de
consolestream bereiken. Dit geldt **alleen voor tools** en wijzigt de bestandslogs niet.

- `logging.redactSensitive`: `off` | `tools` (standaard: `tools`)
- `logging.redactPatterns`: array van regex-strings (overschrijft standaardwaarden)
  - Gebruik ruwe regex-strings (automatische `gi`), of `/pattern/flags` als je aangepaste flags nodig hebt.
  - Overeenkomsten worden gemaskeerd door de eerste 6 + laatste 4 tekens te behouden (lengte >= 18), anders `***`.
  - Standaardwaarden dekken veelvoorkomende sleuteltoewijzingen, CLI-flags, JSON-velden, bearer-headers, PEM-blokken en populaire token-prefixen.

## Gateway WebSocket-logs

De Gateway print WebSocket-protocollogs in twee modi:

- **Normale modus (geen `--verbose`)**: alleen ‘interessante’ RPC-resultaten worden afgedrukt:
  - fouten (`ok=false`)
  - trage aanroepen (standaarddrempel: `>= 50ms`)
  - parsefouten
- **Verbose-modus (`--verbose`)**: print al het WS request/response-verkeer.

### WS-logstijl

`openclaw gateway` ondersteunt een per-Gateway stijlkeuze:

- `--ws-log auto` (standaard): normale modus is geoptimaliseerd; verbose-modus gebruikt compacte uitvoer
- `--ws-log compact`: compacte uitvoer (gekoppelde request/response) bij verbose
- `--ws-log full`: volledige per-frame-uitvoer bij verbose
- `--compact`: alias voor `--ws-log compact`

Voorbeelden:

```bash
# optimized (only errors/slow)
openclaw gateway

# show all WS traffic (paired)
openclaw gateway --verbose --ws-log compact

# show all WS traffic (full meta)
openclaw gateway --verbose --ws-log full
```

## Console-opmaak (subsystem logging)

De console-formatter is **TTY-bewust** en print consistente, geprefixte regels.
Subsystem-loggers houden de uitvoer gegroepeerd en goed scanbaar.

Gedrag:

- **Subsystem-prefixen** op elke regel (bijv. `[gateway]`, `[canvas]`, `[tailscale]`)
- **Subsystem-kleuren** (stabiel per subsystem) plus niveaukleuring
- **Kleur wanneer de uitvoer een TTY is of de omgeving lijkt op een rijke terminal** (`TERM`/`COLORTERM`/`TERM_PROGRAM`), respecteert `NO_COLOR`
- **Ingekorte subsystem-prefixen**: laat de leidende `gateway/` + `channels/` weg, behoudt de laatste 2 segmenten (bijv. `whatsapp/outbound`)
- **Sub-loggers per subsystem** (automatisch prefix + gestructureerd veld `{ subsystem }`)
- **`logRaw()`** voor QR/UX-uitvoer (geen prefix, geen opmaak)
- **Console-stijlen** (bijv. `pretty | compact | json`)
- **Console-logniveau** los van het bestandslogniveau (bestand behoudt volledige details wanneer `logging.level` is ingesteld op `debug`/`trace`)
- **WhatsApp-berichtinhoud** wordt gelogd op `debug` (gebruik `--verbose` om ze te zien)

Dit houdt bestaande bestandslogs stabiel terwijl interactieve uitvoer beter scanbaar wordt.
