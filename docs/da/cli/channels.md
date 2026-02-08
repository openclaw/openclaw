---
summary: "CLI-reference for `openclaw channels` (konti, status, login/logout, logs)"
read_when:
  - Du vil tilføje/fjerne kanalkonti (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage)
  - Du vil tjekke kanalstatus eller følge kanallogs
title: "kanaler"
x-i18n:
  source_path: cli/channels.md
  source_hash: 16ab1642f247bfa9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:00Z
---

# `openclaw channels`

Administrér chatkanalkonti og deres runtime-status på Gateway.

Relaterede docs:

- Kanalvejledninger: [Channels](/channels/index)
- Gateway-konfiguration: [Configuration](/gateway/configuration)

## Almindelige kommandoer

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## Tilføj / fjern konti

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

Tip: `openclaw channels add --help` viser kanal-specifikke flags (token, app-token, signal-cli-stier osv.).

## Login / logout (interaktiv)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## Fejlfinding

- Kør `openclaw status --deep` for en bred probe.
- Brug `openclaw doctor` til guidede rettelser.
- `openclaw channels list` udskriver `Claude: HTTP 403 ... user:profile` → brugssnapshot kræver `user:profile`-scope. Brug `--no-usage`, eller angiv en claude.ai sessionsnøgle (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`), eller re-autentificér via Claude Code CLI.

## Kapabilitetsprobe

Hent udbyder-specifikke kapabilitetstip (intents/scopes hvor tilgængeligt) samt statisk funktionsunderstøttelse:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

Noter:

- `--channel` er valgfri; udelad den for at liste alle kanaler (inklusive udvidelser).
- `--target` accepterer `channel:<id>` eller et råt numerisk kanal-id og gælder kun for Discord.
- Prober er udbyderspecifikke: Discord intents + valgfrie kanaltilladelser; Slack bot- + user-scopes; Telegram bot-flags + webhook; Signal daemon-version; MS Teams app-token + Graph-roller/scopes (annoteret hvor kendt). Kanaler uden prober rapporterer `Probe: unavailable`.

## Opløs navne til ID’er

Opløs kanal-/brugernavne til ID’er via udbyderens katalog:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

Noter:

- Brug `--kind user|group|auto` for at tvinge måltypen.
- Opløsning foretrækker aktive match, når flere poster deler samme navn.
