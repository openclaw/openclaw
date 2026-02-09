---
summary: "CLI-referentie voor `openclaw channels` (accounts, status, inloggen/uitloggen, logs)"
read_when:
  - Je wilt kanaalaccounts toevoegen/verwijderen (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage)
  - Je wilt de kanaalstatus controleren of kanaallogs volgen
title: "kanalen"
---

# `openclaw channels`

Beheer chatkanaalaccounts en hun runtime-status op de Gateway.

Gerelateerde documentatie:

- Kanaalgidsen: [Channels](/channels/index)
- Gateway-configuratie: [Configuration](/gateway/configuration)

## Veelgebruikte opdrachten

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## Accounts toevoegen / verwijderen

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

Tip: `openclaw channels add --help` toont flags per kanaal (token, app-token, signal-cli-paden, enz.).

## Inloggen / uitloggen (interactief)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## Problemen oplossen

- Voer `openclaw status --deep` uit voor een brede controle.
- Gebruik `openclaw doctor` voor begeleide oplossingen.
- `openclaw channels list` print `Claude: HTTP 403 ... user:profile` → de gebruikssnapshot vereist de scope `user:profile`. Gebruik `--no-usage`, of geef een claude.ai-sessiesleutel op (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`), of authenticeer opnieuw via de Claude Code CLI.

## Capabilities-probe

Haal hints op over provider-capabilities (intents/scopes waar beschikbaar) plus statische feature-ondersteuning:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

Notities:

- `--channel` is optioneel; laat het weg om elk kanaal te tonen (inclusief extensies).
- `--target` accepteert `channel:<id>` of een ruwe numerieke kanaal-id en is alleen van toepassing op Discord.
- Probes zijn providerspecifiek: Discord-intents + optionele kanaalrechten; Slack bot- + user-scopes; Telegram bot-flags + webhook; Signal daemon-versie; Microsoft Teams app-token + Graph-rollen/scopes (geannoteerd waar bekend). Kanalen zonder probes rapporteren `Probe: unavailable`.

## Namen omzetten naar ID’s

Zet kanaal-/gebruikersnamen om naar ID’s via de provider-directory:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

Notities:

- Gebruik `--kind user|group|auto` om het doeltype af te dwingen.
- Resolutie geeft de voorkeur aan actieve matches wanneer meerdere vermeldingen dezelfde naam delen.
