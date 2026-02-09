---
summary: "CLI-referens för `openclaw directory` (själv, peers, grupper)"
read_when:
  - Du vill slå upp kontakt-/grupp-/själv-ID:n för en kanal
  - Du utvecklar en kanaladapter för katalog
title: "directory"
---

# `openclaw directory`

Kataloguppslagningar för kanaler som stöder detta (kontakter/peers, grupper och ”jag”).

## Vanliga flaggor

- `--channel <name>`: kanal-ID/alias (krävs när flera kanaler är konfigurerade; automatiskt när endast en är konfigurerad)
- `--account <id>`: konto-ID (standard: kanalens standard)
- `--json`: JSON-utdata

## Noteringar

- `directory` är avsett att hjälpa dig hitta ID:n som du kan klistra in i andra kommandon (särskilt `openclaw message send --target ...`).
- För många kanaler är resultaten konfigurationsbaserade (tillåtelselistor / konfigurerade grupper) snarare än en live-katalog från leverantören.
- Standardutdata är `id` (och ibland `name`) separerade med tab; använd `--json` för skriptning.

## Använda resultat med `message send`

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID-format (per kanal)

- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (grupp)
- Telegram: `@username` eller numeriskt chatt-ID; grupper är numeriska ID:n
- Slack: `user:U…` och `channel:C…`
- Discord: `user:<id>` och `channel:<id>`
- Matrix (plugin): `user:@user:server`, `room:!roomId:server` eller `#alias:server`
- Microsoft Teams (plugin): `user:<id>` och `conversation:<id>`
- Zalo (plugin): användar-ID (Bot API)
- Zalo Personal / `zalouser` (plugin): tråd-ID (DM/grupp) från `zca` (`me`, `friend list`, `group list`)

## Själv (”jag”)

```bash
openclaw directory self --channel zalouser
```

## Peers (kontakter/användare)

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## Grupper

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
