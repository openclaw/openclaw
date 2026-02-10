---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "LINE Messaging API plugin setup, config, and usage"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to connect OpenClaw to LINE（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need LINE webhook + credential setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want LINE-specific message options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: LINE（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# LINE (plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
LINE connects to OpenClaw via the LINE Messaging API. The plugin runs as a webhook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
receiver on the gateway and uses your channel access token + channel secret for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
authentication.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Status: supported via plugin. Direct messages, group chats, media, locations, Flex（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
messages, template messages, and quick replies are supported. Reactions and threads（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
are not supported.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Plugin required（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install the LINE plugin:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install @openclaw/line（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Local checkout (when running from a git repo):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install ./extensions/line（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create a LINE Developers account and open the Console:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [https://developers.line.biz/console/](https://developers.line.biz/console/)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Create (or pick) a Provider and add a **Messaging API** channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Copy the **Channel access token** and **Channel secret** from the channel settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Enable **Use webhook** in the Messaging API settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Set the webhook URL to your gateway endpoint (HTTPS required):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
https://gateway-host/line/webhook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The gateway responds to LINE’s webhook verification (GET) and inbound events (POST).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you need a custom path, set `channels.line.webhookPath` or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`channels.line.accounts.<id>.webhookPath` and update the URL accordingly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Minimal config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    line: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      channelSecret: "LINE_CHANNEL_SECRET",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dmPolicy: "pairing",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Env vars (default account only):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `LINE_CHANNEL_ACCESS_TOKEN`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `LINE_CHANNEL_SECRET`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Token/secret files:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    line: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      tokenFile: "/path/to/line-token.txt",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      secretFile: "/path/to/line-secret.txt",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multiple accounts:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    line: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accounts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        marketing: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          channelAccessToken: "...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          channelSecret: "...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          webhookPath: "/line/marketing",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Access control（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Direct messages default to pairing. Unknown senders get a pairing code and their（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
messages are ignored until approved.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw pairing list line（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw pairing approve line <CODE>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Allowlists and policies:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.line.allowFrom`: allowlisted LINE user IDs for DMs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.line.groupPolicy`: `allowlist | open | disabled`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.line.groupAllowFrom`: allowlisted LINE user IDs for groups（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Per-group overrides: `channels.line.groups.<groupId>.allowFrom`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
LINE IDs are case-sensitive. Valid IDs look like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- User: `U` + 32 hex chars（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group: `C` + 32 hex chars（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Room: `R` + 32 hex chars（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Message behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Text is chunked at 5000 characters.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Markdown formatting is stripped; code blocks and tables are converted into Flex（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  cards when possible.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Streaming responses are buffered; LINE receives full chunks with a loading（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  animation while the agent works.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media downloads are capped by `channels.line.mediaMaxMb` (default 10).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Channel data (rich messages)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `channelData.line` to send quick replies, locations, Flex cards, or template（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  text: "Here you go",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channelData: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    line: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      quickReplies: ["Status", "Help"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      location: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        title: "Office",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        address: "123 Main St",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        latitude: 35.681236,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        longitude: 139.767125,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      flexMessage: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        altText: "Status card",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        contents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          /* Flex payload */（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      templateMessage: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        type: "confirm",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        text: "Proceed?",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        confirmLabel: "Yes",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        confirmData: "yes",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        cancelLabel: "No",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        cancelData: "no",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The LINE plugin also ships a `/card` command for Flex message presets:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/card info "Welcome" "Thanks for joining!"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Webhook verification fails:** ensure the webhook URL is HTTPS and the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `channelSecret` matches the LINE console.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **No inbound events:** confirm the webhook path matches `channels.line.webhookPath`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  and that the gateway is reachable from LINE.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Media download errors:** raise `channels.line.mediaMaxMb` if media exceeds the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  default limit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
