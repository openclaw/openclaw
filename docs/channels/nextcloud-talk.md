---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Nextcloud Talk support status, capabilities, and configuration"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Working on Nextcloud Talk channel features（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Nextcloud Talk"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Nextcloud Talk (plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Status: supported via plugin (webhook bot). Direct messages, rooms, reactions, and markdown messages are supported.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Plugin required（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Nextcloud Talk ships as a plugin and is not bundled with the core install.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install via CLI (npm registry):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install @openclaw/nextcloud-talk（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Local checkout (when running from a git repo):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install ./extensions/nextcloud-talk（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you choose Nextcloud Talk during configure/onboarding and a git checkout is detected,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw will offer the local install path automatically.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Details: [Plugins](/tools/plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick setup (beginner)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Install the Nextcloud Talk plugin.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. On your Nextcloud server, create a bot:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Enable the bot in the target room settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Configure OpenClaw:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Config: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Or env: `NEXTCLOUD_TALK_BOT_SECRET` (default account only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Restart the gateway (or finish onboarding).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Minimal config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "nextcloud-talk": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      baseUrl: "https://cloud.example.com",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      botSecret: "shared-secret",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dmPolicy: "pairing",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bots cannot initiate DMs. The user must message the bot first.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Webhook URL must be reachable by the Gateway; set `webhookPublicUrl` if behind a proxy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media uploads are not supported by the bot API; media is sent as URLs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The webhook payload does not distinguish DMs vs rooms; set `apiUser` + `apiPassword` to enable room-type lookups (otherwise DMs are treated as rooms).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Access control (DMs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: `channels.nextcloud-talk.dmPolicy = "pairing"`. Unknown senders get a pairing code.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Approve via:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw pairing list nextcloud-talk`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw pairing approve nextcloud-talk <CODE>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Public DMs: `channels.nextcloud-talk.dmPolicy="open"` plus `channels.nextcloud-talk.allowFrom=["*"]`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowFrom` matches Nextcloud user IDs only; display names are ignored.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Rooms (groups)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: `channels.nextcloud-talk.groupPolicy = "allowlist"` (mention-gated).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Allowlist rooms with `channels.nextcloud-talk.rooms`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "nextcloud-talk": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      rooms: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "room-token": { requireMention: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- To allow no rooms, keep the allowlist empty or set `channels.nextcloud-talk.groupPolicy="disabled"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Capabilities（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Feature         | Status        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------------- | ------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Direct messages | Supported     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Rooms           | Supported     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Threads         | Not supported |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Media           | URL-only      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Reactions       | Supported     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Native commands | Not supported |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration reference (Nextcloud Talk)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full configuration: [Configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Provider options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.enabled`: enable/disable channel startup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.baseUrl`: Nextcloud instance URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.botSecret`: bot shared secret.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.botSecretFile`: secret file path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.apiUser`: API user for room lookups (DM detection).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.apiPassword`: API/app password for room lookups.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.apiPasswordFile`: API password file path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.webhookPort`: webhook listener port (default: 8788).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.webhookHost`: webhook host (default: 0.0.0.0).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.webhookPath`: webhook path (default: /nextcloud-talk-webhook).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.webhookPublicUrl`: externally reachable webhook URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.allowFrom`: DM allowlist (user IDs). `open` requires `"*"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.groupAllowFrom`: group allowlist (user IDs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.rooms`: per-room settings and allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.historyLimit`: group history limit (0 disables).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.dmHistoryLimit`: DM history limit (0 disables).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.dms`: per-DM overrides (historyLimit).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.textChunkLimit`: outbound text chunk size (chars).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.chunkMode`: `length` (default) or `newline` to split on blank lines (paragraph boundaries) before length chunking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.blockStreaming`: disable block streaming for this channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.blockStreamingCoalesce`: block streaming coalesce tuning.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.nextcloud-talk.mediaMaxMb`: inbound media cap (MB).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
