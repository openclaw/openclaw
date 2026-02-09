---
summary: "Direkte `openclaw agent`-CLI-kørsler (med valgfri levering)"
read_when:
  - Tilføjelse eller ændring af agentens CLI-entrypoint
title: "Agent-afsendelse"
---

# `openclaw agent` (direkte agentkørsler)

`openclaw agent` kører en enkelt agent dreje uden at behøve en indgående chat besked.
Som standard går det **gennem Gateway**; tilføj `-- local` for at tvinge den indlejrede
runtime på den aktuelle maskine.

## Adfærd

- Påkrævet: `--message <text>`
- Sessionsvalg:
  - `--to <dest>` udleder sessionsnøglen (gruppe-/kanalmål bevarer isolation; direkte chats kollapser til `main`), **eller**
  - `--session-id <id>` genbruger en eksisterende session efter id, **eller**
  - `--agent <id>` målretter en konfigureret agent direkte (bruger den agents `main`-sessionsnøgle)
- Kører den samme indlejrede agent-runtime som normale indgående svar.
- Tænke-/verbose-flag bevares i sessionslageret.
- Output:
  - standard: udskriver svartekst (plus `MEDIA:<url>`-linjer)
  - `--json`: udskriver struktureret payload + metadata
- Valgfri levering tilbage til en kanal med `--deliver` + `--channel` (målformater matcher `openclaw message --target`).
- Brug `--reply-channel`/`--reply-to`/`--reply-account` til at tilsidesætte levering uden at ændre sessionen.

Hvis Gateway ikke kan nås, **falder CLI tilbage** til den indlejrede lokale kørsel.

## Eksempler

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## Flag

- `--local`: kør lokalt (kræver modeludbyderens API-nøgler i din shell)
- `--deliver`: send svaret til den valgte kanal
- `--channel`: leveringskanal (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, standard: `whatsapp`)
- `--reply-to`: tilsidesættelse af leveringsmål
- `--reply-channel`: tilsidesættelse af leveringskanal
- `--reply-account`: tilsidesættelse af leveringskonto-id
- `--thinking <off|minimal|low|medium|high|xhigh>`: bevar tænkeniveau (kun GPT-5.2- og Codex-modeller)
- `--verbose <on|full|off>`: bevar verbose-niveau
- `--timeout <seconds>`: tilsidesæt agent-timeout
- `--json`: output struktureret JSON
