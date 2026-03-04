---
summary: "QQ Bot / QQ 频道 — HTTP 回调接收事件，Ed25519 签名验证，频道消息回复"
read_when:
  - Setting up QQ Bot with OpenClaw
title: "QQ"
---

# QQ

Status: **supported (plugin)**. The QQ channel receives events via HTTP callback (事件订阅与通知) and replies in 文字子频道 using the send message API. Signature verification uses Ed25519 (derived from clientSecret).

## Plugin required

```bash
openclaw plugins install ./extensions/qq
```

## Prerequisites

1. **QQ 开放平台** — Create a bot application at [q.qq.com](https://q.qq.com/), get **AppID** and **ClientSecret** (Bot Secret).
2. Configure **回调地址** (callback URL) to your Gateway, e.g. `https://your-gateway-host/webhook/qq` (HTTPS, ports 80/443/8080/8443).
3. The platform will send **op=13** for verification (return `plain_token` + Ed25519 **signature**). Then **op=0** for event push (verify using `X-Signature-Ed25519` and `X-Signature-Timestamp`).

## Configuration

```json5
{
  channels: {
    qq: {
      enabled: true,
      appId: "your-app-id",
      clientSecret: "your-client-secret",
      webhookPath: "/webhook/qq",
      dmPolicy: "allowlist",
      allowFrom: ["openid1", "openid2"],
      rateLimitPerMinute: 30,
    },
  },
}
```

| Option                           | Required       | Description                                              |
| -------------------------------- | -------------- | -------------------------------------------------------- |
| `channels.qq.appId`              | Yes            | Bot AppID.                                               |
| `channels.qq.clientSecret`       | Yes            | Bot Secret; used for token and Ed25519 sign/verify.      |
| `channels.qq.webhookPath`        | No             | Default `/webhook/qq`.                                   |
| `channels.qq.dmPolicy`           | No             | `open` \| `allowlist` \| `pairing`. Default `allowlist`. |
| `channels.qq.allowFrom`          | When allowlist | Allowed sender openids.                                  |
| `channels.qq.rateLimitPerMinute` | No             | Default `30`.                                            |

## Environment variables

- `QQ_APP_ID` — appId
- `QQ_CLIENT_SECRET` — clientSecret
- `QQ_ALLOW_FROM` — comma-separated openids

## Current behavior

- **Inbound**: Platform POSTs to `webhookPath`. op=13: return verification signature. op=0: verify Ed25519, parse event (e.g. AT_MESSAGE_CREATE), run agent, send reply via `POST /channels/{channel_id}/messages`.
- **Outbound**: Replying in 文字子频道 works. `openclaw message send --channel qq` is **not implemented**.

## References

- [事件订阅与通知](https://bot.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)
- [安全和授权 (Ed25519)](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html)
- [发送消息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html)
