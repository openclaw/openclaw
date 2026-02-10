---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI reference for `openclaw channels` (accounts, status, login/logout, logs)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to add/remove channel accounts (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to check channel status or tail channel logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "channels"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw channels`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manage chat channel accounts and their runtime status on the Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related docs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel guides: [Channels](/channels/index)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway configuration: [Configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels capabilities（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels capabilities --channel discord --target channel:123（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels resolve --channel slack "#general" "@jane"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels logs --channel all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Add / remove accounts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels add --channel telegram --token <bot-token>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels remove --channel telegram --delete（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: `openclaw channels add --help` shows per-channel flags (token, app token, signal-cli paths, etc).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Login / logout (interactive)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels login --channel whatsapp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels logout --channel whatsapp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run `openclaw status --deep` for a broad probe.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `openclaw doctor` for guided fixes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw channels list` prints `Claude: HTTP 403 ... user:profile` → usage snapshot needs the `user:profile` scope. Use `--no-usage`, or provide a claude.ai session key (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`), or re-auth via Claude Code CLI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Capabilities probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fetch provider capability hints (intents/scopes where available) plus static feature support:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels capabilities（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels capabilities --channel discord --target channel:123（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--channel` is optional; omit it to list every channel (including extensions).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--target` accepts `channel:<id>` or a raw numeric channel id and only applies to Discord.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Probes are provider-specific: Discord intents + optional channel permissions; Slack bot + user scopes; Telegram bot flags + webhook; Signal daemon version; MS Teams app token + Graph roles/scopes (annotated where known). Channels without probes report `Probe: unavailable`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Resolve names to IDs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Resolve channel/user names to IDs using the provider directory:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels resolve --channel slack "#general" "@jane"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels resolve --channel discord "My Server/#support" "@someone"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels resolve --channel matrix "Project Room"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `--kind user|group|auto` to force the target type.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Resolution prefers active matches when multiple entries share the same name.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
