---
summary: "WeCom plugin overview, features, and configuration"
read_when:
  - You want to connect WeCom
  - You are configuring the WeCom channel
title: WeCom
---

# WeCom

Status: production-ready, with dual-mode support for Bot and Agent.

---

## Plugin required

Install the WeCom plugin:

```bash
openclaw plugins install @openclaw/wecom
openclaw plugins enable wecom
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./extensions/wecom
openclaw plugins enable wecom
```

---

## Quickstart

There are two ways to add the WeCom channel:

### Method 1: onboarding wizard (recommended)

```bash
openclaw channels add
```

### Method 2: CLI setup

```bash
openclaw config set channels.wecom.enabled true
```

---

## WeCom integration guide

Before starting, sign in to WeCom Admin Console:

![WeCom admin console login](https://yosuai.oss-cn-beijing.aliyuncs.com/openclaw/register.png)

### Bot mode (AI bot)

1. Open [WeCom Admin Console](https://work.weixin.qq.com/wework_admin/frame#/manageTools)
2. Go to Security and Management -> Management Tools -> AI Bot
3. Create a bot in API mode
4. Set callback URL: `https://your-domain.com/wecom/bot`
5. Save `token` and `encodingAESKey`

![Bot entry in Management Tools](https://yosuai.oss-cn-beijing.aliyuncs.com/openclaw/01.bot-add.png)

![Bot callback configuration](https://yosuai.oss-cn-beijing.aliyuncs.com/openclaw/01.bot-setp2.png)

### Agent mode (custom app, recommended)

1. Open [WeCom Admin Console](https://work.weixin.qq.com/wework_admin/frame#/apps)
2. Create a custom app and collect `corpId`, `corpSecret`, and `agentId`
3. Set callback URL: `https://your-domain.com/wecom/agent`
4. Save callback `token` and `encodingAESKey`
5. Add your gateway egress IP to Trusted IPs

![Create custom app for Agent mode](https://yosuai.oss-cn-beijing.aliyuncs.com/openclaw/02.agent.add.png)

![Open API callback settings for Agent mode](https://yosuai.oss-cn-beijing.aliyuncs.com/openclaw/02.agent.api-set.png)

### Dynamic IP and egress proxy

If your gateway runs behind dynamic IP or tunneling, you may hit `60020 not allow to access from your ip`.
Use a fixed egress proxy:

```bash
openclaw config set channels.wecom.network.egressProxyUrl "http://proxy.company.local:3128"
```

### Verify after setup

```bash
openclaw gateway restart
openclaw channels status
openclaw logs --follow
```

---

## Configure OpenClaw

### Minimal Bot config

```json5
{
  channels: {
    wecom: {
      enabled: true,
      bot: {
        token: "YOUR_BOT_TOKEN",
        encodingAESKey: "YOUR_BOT_AES_KEY",
      },
    },
  },
}
```

### Bot + Agent dual-mode config (recommended)

```json5
{
  channels: {
    wecom: {
      enabled: true,
      bot: {
        token: "YOUR_BOT_TOKEN",
        encodingAESKey: "YOUR_BOT_AES_KEY",
        receiveId: "",
        streamPlaceholderContent: "Thinking...",
        welcomeText: "Hello, I am your AI assistant",
        dm: { policy: "open", allowFrom: ["*"] },
      },
      agent: {
        corpId: "YOUR_CORP_ID",
        corpSecret: "YOUR_CORP_SECRET",
        agentId: 1000001,
        token: "YOUR_CALLBACK_TOKEN",
        encodingAESKey: "YOUR_CALLBACK_AES_KEY",
        welcomeText: "Welcome to your assistant",
        dm: { policy: "open", allowFrom: ["*"] },
      },
      network: {
        egressProxyUrl: "http://proxy.company.local:3128",
      },
    },
  },
}
```

### DM policy

- `pairing`: default. WeCom does not support `openclaw pairing` approval workflow, so command gating behaves like allowlist.
- `allowlist`: only users in `dm.allowFrom` can run restricted commands.
- `open`: allow everyone (equivalent to `allowFrom=["*"]`).
- `disabled`: disable DM commands.

---

## Channel behavior

### Webhook paths

- Bot: `/wecom` and `/wecom/bot`
- Agent: `/wecom/agent`

### Bot first with Agent fallback

- Group replies default to Bot for text/image/markdown.
- If output contains non-image files, it falls back to Agent DM and posts a notice in group.
- Long tasks near the 6-minute window switch to Agent DM for final delivery.

### A2UI interactive cards

- If Agent outputs `{"template_card": ...}`, it attempts real template card delivery in DM.
- `template_card_event` callbacks are handled with deduplication.
- In group chats or without `response_url`, cards degrade to text.

---

## Cron and proactive delivery

### Recommended usage

Use `openclaw cron` to schedule WeCom notifications:

```bash
openclaw cron add \
  --name "wecom-morning-brief" \
  --cron "0 9 * * 1-5" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --message "Good morning, here is your daily brief" \
  --announce \
  --channel wecom \
  --to "party:1"
```

### Target formats

- `user:zhangsan`: user
- `party:1`: department
- `tag:Ops`: tag
- `group:wrxxxx`: group chat ID (subject to proactive delivery limits)

### Current proactive delivery limit

WeCom Agent proactive delivery blocks normal group `chatid` targets by default.
Prefer user/party/tag targets, or use Bot for in-group delivery.

---

## Supported message types

### Receive

- Bot: text, image, voice, file, quoted mixed content
- Agent: text, image, voice, video, location, link (file callback has official platform limits)

### Send

- Bot: text, image, markdown (passive streaming)
- Agent: text, image, voice, video, file (proactive delivery)

---

## Common commands

| Command  | Description           |
| -------- | --------------------- |
| `/new`   | Start a new session   |
| `/reset` | Reset current session |

---

## Advanced configuration

### Dynamic Agent routing

```json5
{
  channels: {
    wecom: {
      dynamicAgents: {
        enabled: true,
        dmCreateAgent: true,
        groupEnabled: true,
        adminUsers: ["zhangsan"],
      },
    },
  },
}
```

### Media size limit

```bash
openclaw config set channels.wecom.media.maxBytes 52428800
```

---

## Troubleshooting

### Bot does not receive callbacks

1. Check gateway status: `openclaw gateway status`
2. Verify callback URL and path
3. Verify Token and EncodingAESKey
4. Inspect logs: `openclaw logs --follow`

### Error 60020

1. Verify Trusted IP contains your gateway egress IP
2. Use `channels.wecom.network.egressProxyUrl` for dynamic IP environments

### File fallback did not deliver in group scenario

1. Confirm Agent mode is configured
2. Confirm sender `userid` is present
3. Check fallback/media errors in logs

---

## Configuration reference

| Config key                                    | Description                    | Default    |
| --------------------------------------------- | ------------------------------ | ---------- |
| `channels.wecom.enabled`                      | Enable or disable WeCom        | `true`     |
| `channels.wecom.bot.token`                    | Bot callback token             | -          |
| `channels.wecom.bot.encodingAESKey`           | Bot callback AES key           | -          |
| `channels.wecom.bot.receiveId`                | Bot receiver ID                | `""`       |
| `channels.wecom.bot.streamPlaceholderContent` | Streaming placeholder          | -          |
| `channels.wecom.bot.welcomeText`              | Bot welcome text               | -          |
| `channels.wecom.bot.dm.policy`                | Bot DM policy                  | `pairing`  |
| `channels.wecom.bot.dm.allowFrom`             | Bot DM allowlist               | -          |
| `channels.wecom.agent.corpId`                 | Corp ID                        | -          |
| `channels.wecom.agent.corpSecret`             | App secret                     | -          |
| `channels.wecom.agent.agentId`                | Agent ID                       | -          |
| `channels.wecom.agent.token`                  | Agent callback token           | -          |
| `channels.wecom.agent.encodingAESKey`         | Agent callback AES key         | -          |
| `channels.wecom.agent.welcomeText`            | Agent welcome text             | -          |
| `channels.wecom.agent.dm.policy`              | Agent DM policy                | `pairing`  |
| `channels.wecom.agent.dm.allowFrom`           | Agent DM allowlist             | -          |
| `channels.wecom.network.egressProxyUrl`       | Egress proxy URL               | -          |
| `channels.wecom.media.maxBytes`               | Media download limit (bytes)   | `83886080` |
| `channels.wecom.dynamicAgents.enabled`        | Enable dynamic agent routing   | `false`    |
| `channels.wecom.dynamicAgents.dmCreateAgent`  | Auto-create agent for DM       | `true`     |
| `channels.wecom.dynamicAgents.groupEnabled`   | Enable dynamic agent in groups | `true`     |
| `channels.wecom.dynamicAgents.adminUsers`     | Admin bypass list              | `[]`       |
