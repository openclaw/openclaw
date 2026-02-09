---
summary: "Stappen voor gezondheidscontroles voor kanaalconnectiviteit"
read_when:
  - Diagnose van de gezondheid van het WhatsApp-kanaal
title: "Gezondheidscontroles"
---

# Gezondheidscontroles (CLI)

Korte handleiding om kanaalconnectiviteit te verifiëren zonder te hoeven gokken.

## Snelle controles

- `openclaw status` — lokale samenvatting: bereikbaarheid/modus van de Gateway, updatehint, leeftijd van gekoppelde kanaalauthenticatie, sessies + recente activiteit.
- `openclaw status --all` — volledige lokale diagnose (alleen-lezen, kleur, veilig om te plakken voor debugging).
- `openclaw status --deep` — test ook de draaiende Gateway (per-kanaal probes wanneer ondersteund).
- `openclaw health --json` — vraagt de draaiende Gateway om een volledige gezondheidsmomentopname (alleen WS; geen directe Baileys-socket).
- Stuur `/status` als een losstaand bericht in WhatsApp/WebChat om een statusantwoord te krijgen zonder de agent aan te roepen.
- Logs: tail `/tmp/openclaw/openclaw-*.log` en filter op `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`.

## Diepgaande diagnostiek

- Referenties op schijf: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime moet recent zijn).
- Sessiestore: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (pad kan worden overschreven in de config). Aantal en recente ontvangers worden zichtbaar gemaakt via `status`.
- Herkoppelingsflow: `openclaw channels logout && openclaw channels login --verbose` wanneer statuscodes 409–515 of `loggedOut` in logs verschijnen. (Let op: de QR-loginflow start één keer automatisch opnieuw bij status 515 na koppelen.)

## Wanneer iets mislukt

- `logged out` of status 409–515 → opnieuw koppelen met `openclaw channels logout` en daarna `openclaw channels login`.
- Gateway onbereikbaar → start deze: `openclaw gateway --port 18789` (gebruik `--force` als de poort bezet is).
- Geen inkomende berichten → bevestig dat de gekoppelde telefoon online is en dat de afzender is toegestaan (`channels.whatsapp.allowFrom`); voor groepschats: zorg dat toegestane lijst + mentionregels overeenkomen (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## Speciale "health"-opdracht

`openclaw health --json` vraagt de draaiende Gateway om zijn gezondheidsmomentopname (geen directe kanaalsockets vanuit de CLI). Het rapporteert gekoppelde referenties/auth-leeftijd wanneer beschikbaar, per-kanaal probe-samenvattingen, een samenvatting van de sessiestore en een probe-duur. Het eindigt met een niet-nul exitcode als de Gateway onbereikbaar is of als de probe faalt/time-outs heeft. Gebruik `--timeout <ms>` om de standaardwaarde van 10s te overschrijven.
