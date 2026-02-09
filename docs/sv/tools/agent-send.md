---
summary: "Direkta körningar av `openclaw agent` via CLI (med valfri leverans)"
read_when:
  - När du lägger till eller ändrar agentens CLI-ingångspunkt
title: "Skicka agent"
---

# `openclaw agent` (direkta agentkörningar)

`openclaw agent` kör en enda agent tur utan att behöva ett inkommande chattmeddelande.
Som standard går det **genom Gateway**; lägg till `--local` för att tvinga den inbäddade
runtime på den aktuella maskinen.

## Beteende

- Krävs: `--message <text>`
- Sessionsval:
  - `--to <dest>` härleder sessionsnyckeln (grupp-/kanalmål bevarar isolering; direktchattar kollapsar till `main`), **eller**
  - `--session-id <id>` återanvänder en befintlig session via id, **eller**
  - `--agent <id>` riktar in sig direkt på en konfigurerad agent (använder den agentens `main`-sessionsnyckel)
- Kör samma inbäddade agentkörning som normala inkommande svar.
- Tänkande-/verbose-flaggor sparas i sessionslagret.
- Utdata:
  - standard: skriver ut svarstext (plus `MEDIA:<url>`-rader)
  - `--json`: skriver ut strukturerad payload + metadata
- Valfri leverans tillbaka till en kanal med `--deliver` + `--channel` (målformat matchar `openclaw message --target`).
- Använd `--reply-channel`/`--reply-to`/`--reply-account` för att åsidosätta leverans utan att ändra sessionen.

Om Gateway inte går att nå **faller** CLI tillbaka till den inbäddade lokala körningen.

## Exempel

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## Flaggor

- `--local`: kör lokalt (kräver API-nycklar för modellleverantör i ditt skal)
- `--deliver`: skicka svaret till vald kanal
- `--channel`: leveranskanal (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, standard: `whatsapp`)
- `--reply-to`: åsidosätt leveransmål
- `--reply-channel`: åsidosätt leveranskanal
- `--reply-account`: åsidosätt leveransens konto-id
- `--thinking <off|minimal|low|medium|high|xhigh>`: spara nivå för tänkande (endast GPT-5.2- och Codex-modeller)
- `--verbose <on|full|off>`: spara verbose-nivå
- `--timeout <seconds>`: åsidosätt agentens timeout
- `--json`: mata ut strukturerad JSON
