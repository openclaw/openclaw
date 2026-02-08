---
summary: "CLI-referens för `openclaw channels` (konton, status, inloggning/utloggning, loggar)"
read_when:
  - Du vill lägga till/ta bort kanalkonton (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage)
  - Du vill kontrollera kanalstatus eller följa kanalloggar
title: "kanaler"
x-i18n:
  source_path: cli/channels.md
  source_hash: 16ab1642f247bfa9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:33Z
---

# `openclaw channels`

Hantera chattkanalkonton och deras körningsstatus på Gateway.

Relaterad dokumentation:

- Kanalguider: [Channels](/channels/index)
- Gateway-konfiguration: [Configuration](/gateway/configuration)

## Vanliga kommandon

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## Lägg till / ta bort konton

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

Tips: `openclaw channels add --help` visar kanalvisa flaggor (token, app-token, signal-cli-sökvägar osv.).

## Inloggning / utloggning (interaktiv)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## Felsökning

- Kör `openclaw status --deep` för en bred kontroll.
- Använd `openclaw doctor` för guidade åtgärder.
- `openclaw channels list` skriver ut `Claude: HTTP 403 ... user:profile` → användningsöversikten kräver `user:profile`-omfånget. Använd `--no-usage`, eller tillhandahåll en claude.ai-sessionsnyckel (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`), eller autentisera på nytt via Claude Code CLI.

## Förmågekontroll

Hämta leverantörsspecifika förmågehintar (intents/omfång där tillgängligt) samt statiskt funktionsstöd:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

Noteringar:

- `--channel` är valfri; utelämna den för att lista alla kanaler (inklusive tillägg).
- `--target` accepterar `channel:<id>` eller ett rått numeriskt kanal-id och gäller endast Discord.
- Kontrollerna är leverantörsspecifika: Discord-intents + valfria kanalbehörigheter; Slack-bot- och användaromfång; Telegram-botflaggor + webhook; Signal-daemonversion; MS Teams app-token + Graph-roller/omfång (annoterade där känt). Kanaler utan kontroller rapporterar `Probe: unavailable`.

## Lös namn till ID:n

Lös kanal-/användarnamn till ID:n med leverantörskatalogen:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

Noteringar:

- Använd `--kind user|group|auto` för att tvinga måltyp.
- Upplösning föredrar aktiva träffar när flera poster delar samma namn.
