---
summary: "CLI-referentie voor `openclaw directory` (zelf, peers, groepen)"
read_when:
  - Je wilt contact-/groep-/zelf-id’s opzoeken voor een kanaal
  - Je ontwikkelt een kanaaldirectory-adapter
title: "directory"
---

# `openclaw directory`

Directory-opzoekingen voor kanalen die dit ondersteunen (contacten/peers, groepen en “ik”).

## Veelgebruikte flags

- `--channel <name>`: kanaal-id/alias (vereist wanneer meerdere kanalen zijn geconfigureerd; automatisch wanneer er slechts één is geconfigureerd)
- `--account <id>`: account-id (standaard: kanaalstandaard)
- `--json`: JSON-uitvoer

## Notities

- `directory` is bedoeld om je te helpen id’s te vinden die je in andere opdrachten kunt plakken (vooral `openclaw message send --target ...`).
- Voor veel kanalen zijn resultaten config-gedreven (toegestane lijsten / geconfigureerde groepen) in plaats van een live provider-directory.
- Standaarduitvoer is `id` (en soms `name`) gescheiden door een tab; gebruik `--json` voor scripting.

## Resultaten gebruiken met `message send`

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID-formaten (per kanaal)

- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (groep)
- Telegram: `@username` of numerieke chat-id; groepen zijn numerieke id’s
- Slack: `user:U…` en `channel:C…`
- Discord: `user:<id>` en `channel:<id>`
- Matrix (plugin): `user:@user:server`, `room:!roomId:server` of `#alias:server`
- Microsoft Teams (plugin): `user:<id>` en `conversation:<id>`
- Zalo (plugin): gebruikers-id (Bot API)
- Zalo Personal / `zalouser` (plugin): thread-id (DM/groep) van `zca` (`me`, `friend list`, `group list`)

## Zelf (“ik”)

```bash
openclaw directory self --channel zalouser
```

## Peers (contacten/gebruikers)

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## Groepen

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
