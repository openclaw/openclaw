---
summary: "CLI-referens för `openclaw channels` (konton, status, inloggning/utloggning, loggar)"
read_when:
  - Du vill lägga till/ta bort kanalkonton (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage)
  - Du vill kontrollera kanalstatus eller följa kanalloggar
title: "kanaler"
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
- `openclaw channellist` skriver ut `Claude: HTTP 403 ... user:profile` → användnings ögonblicksbild behöver `user:profile` omfattning. Använd `--no-usage`, eller ge en claude.ai sessionsnyckel (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`), eller re-auth via Claude Code CLI.

## Förmågekontroll

Hämta leverantörsspecifika förmågehintar (intents/omfång där tillgängligt) samt statiskt funktionsstöd:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

Noteringar:

- `--channel` är valfri; utelämna den för att lista alla kanaler (inklusive tillägg).
- `--target` accepterar `channel:<id>` eller ett rått numeriskt kanal-id och gäller endast Discord.
- Probes är leverantörsspecifikt: Discord-intentioner + valfria kanaltillstånd; Slack bot + användaromfång; Telegram bot flaggor + webhook; Signal daemon version; MS Teams app token + Graph roller/scope (kommenterad där känd). Kanaler utan sonder rapporterar `Probe: otillgängliga`.

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
