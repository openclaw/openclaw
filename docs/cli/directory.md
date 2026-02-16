---
summary: "CLI reference for `smart-agent-neo directory` (self, peers, groups)"
read_when:
  - You want to look up contacts/groups/self ids for a channel
  - You are developing a channel directory adapter
title: "directory"
---

# `smart-agent-neo directory`

Directory lookups for channels that support it (contacts/peers, groups, and “me”).

## Common flags

- `--channel <name>`: channel id/alias (required when multiple channels are configured; auto when only one is configured)
- `--account <id>`: account id (default: channel default)
- `--json`: output JSON

## Notes

- `directory` is meant to help you find IDs you can paste into other commands (especially `smart-agent-neo message send --target ...`).
- For many channels, results are config-backed (allowlists / configured groups) rather than a live provider directory.
- Default output is `id` (and sometimes `name`) separated by a tab; use `--json` for scripting.

## Using results with `message send`

```bash
smart-agent-neo directory peers list --channel slack --query "U0"
smart-agent-neo message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID formats (by channel)

- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (group)
- Telegram: `@username` or numeric chat id; groups are numeric ids
- Slack: `user:U…` and `channel:C…`
- Discord: `user:<id>` and `channel:<id>`
- Matrix (plugin): `user:@user:server`, `room:!roomId:server`, or `#alias:server`
- Microsoft Teams (plugin): `user:<id>` and `conversation:<id>`
- Zalo (plugin): user id (Bot API)
- Zalo Personal / `zalouser` (plugin): thread id (DM/group) from `zca` (`me`, `friend list`, `group list`)

## Self (“me”)

```bash
smart-agent-neo directory self --channel zalouser
```

## Peers (contacts/users)

```bash
smart-agent-neo directory peers list --channel zalouser
smart-agent-neo directory peers list --channel zalouser --query "name"
smart-agent-neo directory peers list --channel zalouser --limit 50
```

## Groups

```bash
smart-agent-neo directory groups list --channel zalouser
smart-agent-neo directory groups list --channel zalouser --query "work"
smart-agent-neo directory groups members --channel zalouser --group-id <id>
```
