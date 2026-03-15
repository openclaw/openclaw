---
summary: "NapCat OneBot11 plugin setup, config, and QQ usage"
read_when:
  - You want to connect OpenClaw to QQ via NapCat
  - You need HTTP or WebSocket inbound setup for OneBot11
title: "NapCat"
---

# NapCat (QQ plugin)

NapCat connects OpenClaw to QQ through the OneBot11 protocol.

Status: supported via plugin. Direct messages, group messages, and media are supported.
Threads, reactions, and native commands are not supported.

## Plugin required

Install the plugin:

```bash
openclaw plugins install @openclaw/napcat
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./extensions/napcat
```

Details: [Plugins](/tools/plugin)

## Setup

1. Install the plugin.
2. In NapCat, enable OneBot11 and set a shared access token.
3. Configure OpenClaw with the same token and your NapCat HTTP API base URL.
4. Choose one or both inbound modes:
   - HTTP webhook mode: NapCat calls OpenClaw.
   - WebSocket client mode: OpenClaw dials NapCat.

Recommended minimal config (HTTP inbound only):

```json5
{
  channels: {
    napcat: {
      enabled: true,
      token: "your_shared_token",
      apiBaseUrl: "http://127.0.0.1:3000",
      dm: { policy: "pairing" },
      transport: {
        http: {
          enabled: true,
          host: "127.0.0.1",
          port: 5715,
          path: "/onebot",
        },
        ws: {
          enabled: false,
        },
      },
    },
  },
}
```

WebSocket inbound example:

```json5
{
  channels: {
    napcat: {
      transport: {
        http: { enabled: false },
        ws: {
          enabled: true,
          url: "ws://127.0.0.1:3001",
          reconnectMs: 3000,
        },
      },
    },
  },
}
```

## Access control

DM policy defaults to pairing.
Unknown QQ users receive a pairing challenge and are blocked until approval.

```bash
openclaw pairing list napcat
openclaw pairing approve napcat <CODE>
```

Relevant keys:

- `channels.napcat.dm.policy`: `pairing | allowlist | open | disabled`
- `channels.napcat.dm.allowFrom`: QQ user id allowlist. Use `"*"` only when policy is `open`.

## Groups

Group behavior is controlled by `groupPolicy` and allowlists.

- `channels.napcat.groupPolicy`: `allowlist | open | disabled`
- `channels.napcat.groupAllowFrom`: sender allowlist for groups
- `channels.napcat.groups.<groupId>.allow`: per-group allow toggle
- `channels.napcat.groups.<groupId>.requireMention`: require `@bot` mention (default true)
- `channels.napcat.groups.<groupId>.allowFrom`: per-group sender allowlist

If `requireMention` is true, the bot responds only when the event includes `@self` or `@all`.

## Target format

Use explicit QQ targets:

- user: `user:<qqUserId>`
- group: `group:<qqGroupId>`

Example:

```bash
openclaw message send --channel napcat --target user:123456789 --message "hello"
```

## Capabilities

| Feature         | Status         |
| --------------- | -------------- |
| Direct messages | ✅ Supported   |
| Groups          | ✅ Supported   |
| Media           | ✅ Supported   |
| Reactions       | ❌ Not supported |
| Threads         | ❌ Not supported |
| Native commands | ❌ Not supported |

## Troubleshooting

- `NapCat token is missing`: set `channels.napcat.token` (or `NAPCAT_TOKEN` for default account).
- `NapCat apiBaseUrl is missing`: set `channels.napcat.apiBaseUrl` (or `NAPCAT_API_BASE_URL`).
- No inbound events:
  - verify HTTP/WS transport is enabled in `channels.napcat.transport`
  - verify host, port, path, and token match NapCat settings
- Group messages ignored:
  - check `groupPolicy` and `groups` allowlist
  - check `requireMention`

Useful checks:

```bash
openclaw channels status --probe
openclaw logs --follow
```

## Configuration reference (NapCat)

Full configuration: [Configuration](/gateway/configuration)

- `channels.napcat.enabled`: enable or disable channel startup.
- `channels.napcat.name`: optional account display name.
- `channels.napcat.token`: OneBot shared token.
- `channels.napcat.apiBaseUrl`: NapCat OneBot HTTP API base URL.
- `channels.napcat.defaultTo`: default outbound target.
- `channels.napcat.dm.policy`: `pairing | allowlist | open | disabled`.
- `channels.napcat.dm.allowFrom`: DM allowlist.
- `channels.napcat.groupPolicy`: `allowlist | open | disabled`.
- `channels.napcat.groupAllowFrom`: sender allowlist for groups.
- `channels.napcat.groups`: per-group policy map.
- `channels.napcat.transport.http.enabled`: enable HTTP webhook inbound.
- `channels.napcat.transport.http.host`: webhook bind host.
- `channels.napcat.transport.http.port`: webhook bind port.
- `channels.napcat.transport.http.path`: webhook path.
- `channels.napcat.transport.http.bodyMaxBytes`: max HTTP payload bytes.
- `channels.napcat.transport.ws.enabled`: enable WebSocket inbound.
- `channels.napcat.transport.ws.url`: WebSocket endpoint.
- `channels.napcat.transport.ws.reconnectMs`: reconnect interval.
- `channels.napcat.replyToMode`: `off | first | all`.
- `channels.napcat.blockStreaming`: override block streaming behavior.
- `channels.napcat.mediaMaxMb`: media size limit.
