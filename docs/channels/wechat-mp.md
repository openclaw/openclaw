---
summary: "WeChat Official Account (微信公众号) — 服务器配置 GET 验证，POST 接收消息，客服消息回复"
read_when:
  - Setting up WeChat MP with OpenClaw
title: "WeChat Official Account (微信公众号)"
---

# WeChat Official Account (微信公众号)

Status: **supported (plugin)**. The WeChat MP channel uses the official 服务器配置 (server config): GET for URL verification, POST for receiving user messages (XML). Replies are sent via the 客服消息 (customer message) API within the 48-hour window.

## Plugin required

```bash
openclaw plugins install ./extensions/wechat-mp
```

## Prerequisites

1. **微信公众平台** — Create or use an existing 公众号, get **AppID** and **AppSecret**.
2. In 开发 → 基本配置, set **服务器配置**:
   - URL: `https://your-gateway-host/webhook/wechat-mp` (or your `webhookPath`)
   - Token: a string you choose (must match `channels.wechat-mp.token`)
   - Encoding: 明文 or 兼容模式 (plugin parses plain XML)
3. Enable 接收消息.

## Configuration

```json5
{
  channels: {
    "wechat-mp": {
      enabled: true,
      appId: "your-appid",
      appSecret: "your-appsecret",
      token: "your-verification-token",
      webhookPath: "/webhook/wechat-mp",
      dmPolicy: "allowlist",
      allowFrom: ["openid1", "openid2"],
      rateLimitPerMinute: 30,
    },
  },
}
```

| Option                           | Required        | Description                                              |
| -------------------------------- | --------------- | -------------------------------------------------------- |
| `channels.wechat-mp.appId`       | Yes (for reply) | AppID.                                                   |
| `channels.wechat-mp.appSecret`   | Yes (for reply) | AppSecret (access_token).                                |
| `channels.wechat-mp.token`       | Yes (for GET)   | Must match the token in 服务器配置.                      |
| `channels.wechat-mp.webhookPath` | No              | Default `/webhook/wechat-mp`.                            |
| `channels.wechat-mp.dmPolicy`    | No              | `open` \| `allowlist` \| `pairing`. Default `allowlist`. |
| `channels.wechat-mp.allowFrom`   | When allowlist  | Allowed openids.                                         |

## Environment variables

- `WECHAT_MP_APP_ID` — appId
- `WECHAT_MP_APP_SECRET` — appSecret
- `WECHAT_MP_TOKEN` — token
- `WECHAT_MP_ALLOW_FROM` — comma-separated openids

## Current behavior

- **GET**: Verifies signature (sha1(token, timestamp, nonce)) and returns `echostr`.
- **POST**: Parses XML (FromUserName, MsgType, Content), runs agent, sends reply via 客服消息 API.
- **Outbound**: `openclaw message send --channel wechat-mp --to <openid>` is supported (customer message).

## 48-hour window

Customer messages can only be sent within **48 hours** after the user’s last message. After that, use template messages or other flows (not implemented in this plugin).

## References

- [接收消息和事件](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Receiving_standard_messages.html)
- [客服消息](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Service_Center_messages.html)
