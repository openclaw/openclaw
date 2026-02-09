---
summary: "Reference ng CLI para sa `openclaw directory` (sarili, peers, mga grupo)"
read_when:
  - Gusto mong hanapin ang mga id ng contact/grupo/sarili para sa isang channel
  - Nagde-develop ka ng adapter ng directory ng channel
title: "directory"
---

# `openclaw directory`

Mga lookup ng directory para sa mga channel na may suportang ganito (mga contact/peers, mga grupo, at “me”).

## Common flags

- `--channel <name>`: channel id/alias (kinakailangan kapag maraming channel ang naka-configure; awtomatiko kapag iisa lang ang naka-configure)
- `--account <id>`: account id (default: default ng channel)
- `--json`: output na JSON

## Mga tala

- Ang `directory` ay nilalayong tumulong sa paghahanap ng mga ID na maaari mong i-paste sa iba pang mga command (lalo na ang `openclaw message send --target ...`).
- Para sa maraming channel, ang mga resulta ay naka-back sa config (mga allowlist / mga naka-configure na grupo) sa halip na isang live na directory ng provider.
- Ang default na output ay `id` (at minsan `name`) na pinaghiwalay ng tab; gamitin ang `--json` para sa scripting.

## Paggamit ng mga resulta kasama ang `message send`

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## Mga format ng ID (ayon sa channel)

- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (grupo)
- Telegram: `@username` o numerong chat id; ang mga grupo ay mga numerong id
- Slack: `user:U…` at `channel:C…`
- Discord: `user:<id>` at `channel:<id>`
- Matrix (plugin): `user:@user:server`, `room:!roomId:server`, o `#alias:server`
- Microsoft Teams (plugin): `user:<id>` at `conversation:<id>`
- Zalo (plugin): user id (Bot API)
- Zalo Personal / `zalouser` (plugin): thread id (DM/grupo) mula sa `zca` (`me`, `friend list`, `group list`)

## Sarili (“me”)

```bash
openclaw directory self --channel zalouser
```

## Peers (mga contact/user)

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## Mga grupo

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
