---
summary: "Directe `openclaw agent` CLI-uitvoeringen (met optionele aflevering)"
read_when:
  - Toevoegen of wijzigen van het agent-CLI-entrypoint
title: "Agent verzenden"
---

# `openclaw agent` (directe agent-uitvoeringen)

`openclaw agent` voert één agentbeurt uit zonder dat een inkomend chatbericht nodig is.
Standaard gaat dit **via de Gateway**; voeg `--local` toe om de ingebedde
runtime op de huidige machine te forceren.

## Gedrag

- Vereist: `--message <text>`
- Sessieselectie:
  - `--to <dest>` leidt de sessiesleutel af (groep-/kanaaldoelen behouden isolatie; directe chats vallen samen tot `main`), **of**
  - `--session-id <id>` hergebruikt een bestaande sessie op id, **of**
  - `--agent <id>` richt zich rechtstreeks op een geconfigureerde agent (gebruikt de `main`-sessiesleutel van die agent)
- Voert dezelfde ingebedde agent-runtime uit als normale inkomende antwoorden.
- Denk-/verbose-vlaggen blijven bewaard in de sessie-opslag.
- Uitvoer:
  - standaard: print antwoordtekst (plus `MEDIA:<url>`-regels)
  - `--json`: print gestructureerde payload + metadata
- Optionele aflevering terug naar een kanaal met `--deliver` + `--channel` (doelformaten komen overeen met `openclaw message --target`).
- Gebruik `--reply-channel`/`--reply-to`/`--reply-account` om de aflevering te overschrijven zonder de sessie te wijzigen.

Als de Gateway onbereikbaar is, **valt** de CLI **terug** op de ingebedde lokale uitvoering.

## Voorbeelden

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## Vlaggen

- `--local`: lokaal uitvoeren (vereist API-sleutels van de modelprovider in je shell)
- `--deliver`: het antwoord naar het gekozen kanaal sturen
- `--channel`: afleveringskanaal (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, standaard: `whatsapp`)
- `--reply-to`: override van het afleveringsdoel
- `--reply-channel`: override van het afleveringskanaal
- `--reply-account`: override van de afleveringsaccount-id
- `--thinking <off|minimal|low|medium|high|xhigh>`: denkniveau persistent maken (alleen GPT-5.2 + Codex-modellen)
- `--verbose <on|full|off>`: verbose-niveau persistent maken
- `--timeout <seconds>`: agent-time-out overschrijven
- `--json`: gestructureerde JSON-uitvoer
