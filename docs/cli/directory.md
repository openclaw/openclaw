---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI reference for `openclaw directory` (self, peers, groups)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to look up contacts/groups/self ids for a channel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are developing a channel directory adapter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "directory"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw directory`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Directory lookups for channels that support it (contacts/peers, groups, and “me”).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common flags（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--channel <name>`: channel id/alias (required when multiple channels are configured; auto when only one is configured)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--account <id>`: account id (default: channel default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`: output JSON（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `directory` is meant to help you find IDs you can paste into other commands (especially `openclaw message send --target ...`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For many channels, results are config-backed (allowlists / configured groups) rather than a live provider directory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default output is `id` (and sometimes `name`) separated by a tab; use `--json` for scripting.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Using results with `message send`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw directory peers list --channel slack --query "U0"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## ID formats (by channel)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (group)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: `@username` or numeric chat id; groups are numeric ids（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack: `user:U…` and `channel:C…`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: `user:<id>` and `channel:<id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Matrix (plugin): `user:@user:server`, `room:!roomId:server`, or `#alias:server`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Microsoft Teams (plugin): `user:<id>` and `conversation:<id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Zalo (plugin): user id (Bot API)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Zalo Personal / `zalouser` (plugin): thread id (DM/group) from `zca` (`me`, `friend list`, `group list`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Self (“me”)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw directory self --channel zalouser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Peers (contacts/users)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw directory peers list --channel zalouser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw directory peers list --channel zalouser --query "name"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw directory peers list --channel zalouser --limit 50（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Groups（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw directory groups list --channel zalouser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw directory groups list --channel zalouser --query "work"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw directory groups members --channel zalouser --group-id <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
