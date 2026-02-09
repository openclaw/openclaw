---
summary: "CLI-reference til `openclaw directory` (self, peers, grupper)"
read_when:
  - Du vil slå kontakt-/gruppe-/self-id’er op for en kanal
  - Du udvikler en kanal-directory-adapter
title: "directory"
---

# `openclaw directory`

Directory-opslag for kanaler, der understøtter det (kontakter/peers, grupper og “me”).

## Common flags

- `--channel <name>`: kanal-id/alias (påkrævet når flere kanaler er konfigureret; automatisk når kun én er konfigureret)
- `--account <id>`: konto-id (standard: kanalens standard)
- `--json`: output JSON

## Noter

- `directory` er beregnet til at hjælpe dig med at finde id’er, som du kan indsætte i andre kommandoer (især `openclaw message send --target ...`).
- For mange kanaler er resultater konfigurationsbaserede (tilladelseslister / konfigurerede grupper) snarere end et live udbyder-directory.
- Standardoutput er `id` (og nogle gange `name`) adskilt af en tabulator; brug `--json` til scripting.

## Brug af resultater med `message send`

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID-formater (pr. kanal)

- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (gruppe)
- Telegram: `@username` eller numerisk chat-id; grupper er numeriske id’er
- Slack: `user:U…` og `channel:C…`
- Discord: `user:<id>` og `channel:<id>`
- Matrix (plugin): `user:@user:server`, `room:!roomId:server` eller `#alias:server`
- Microsoft Teams (plugin): `user:<id>` og `conversation:<id>`
- Zalo (plugin): bruger-id (Bot API)
- Zalo Personal / `zalouser` (plugin): tråd-id (DM/gruppe) fra `zca` (`me`, `friend list`, `group list`)

## Self (“me”)

```bash
openclaw directory self --channel zalouser
```

## Peers (kontakter/brugere)

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
