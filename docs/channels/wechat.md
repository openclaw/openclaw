---
summary: "WeChat (微信) channel via Proxy API — install, configuration, and usage"
read_when:
  - Working on WeChat channel or proxy API
title: "WeChat (微信)"
---

# WeChat (微信)

Status: community plugin. Connects OpenClaw to your personal WeChat via a proxy API (私聊、群聊、文本与图片消息，二维码登录).

## Plugin required

WeChat ships as a plugin and is not bundled with the core install.

- Install via CLI: `openclaw plugins install @canghe/openclaw-wechat`
- Or select **WeChat** during onboarding and confirm the install prompt
- Source: [freestylefly/openclaw-wechat](https://github.com/freestylefly/openclaw-wechat)

## Quick setup

1. **Install the plugin**
   - From npm: `openclaw plugins install @canghe/openclaw-wechat`
   - From workspace: `openclaw plugins install ./extensions/wechat`
2. **Get an API Key** (required; obtain from the plugin provider / customer service).
3. **Configure** (minimal):

```json5
{
  channels: {
    wechat: {
      enabled: true,
      apiKey: "wc_live_xxxxxxxxxxxxxxxx",
      proxyUrl: "http://your-proxy-server:3000",
      webhookHost: "your-server-ip",   // required for cloud deployment
    },
  },
}
```

4. **Start the gateway** and scan the QR code with WeChat to log in:

```bash
openclaw gateway start
```

## Configuration options

| Option | Required | Description |
|--------|----------|-------------|
| `channels.wechat.apiKey` | Yes | API Key (e.g. `wc_live_...`) from provider |
| `channels.wechat.proxyUrl` | Yes | Proxy service URL (e.g. `http://your-proxy:3000`) |
| `channels.wechat.webhookHost` | Cloud only | Server public IP or domain for webhooks |
| `channels.wechat.webhookPort` | No | Default: 18790 |
| `channels.wechat.webhookPath` | No | Default: `/webhook/wechat` |
| `channels.wechat.deviceType` | No | `"ipad"` or `"mac"`, default: `"ipad"` |

CLI examples:

```bash
openclaw config set channels.wechat.apiKey "wc_live_xxxxxxxxxxxxxxxx"
openclaw config set channels.wechat.proxyUrl "http://your-proxy:3000"
openclaw config set channels.wechat.webhookHost "your-server-ip"
openclaw config set channels.wechat.enabled true
```

## First-time login

When you start the gateway for the first time, a QR code is displayed. Scan it with WeChat to log in.

## Multi-account

```json5
{
  channels: {
    wechat: {
      accounts: {
        work: {
          apiKey: "wc_live_work_xxx",
          webhookHost: "1.2.3.4",
        },
        personal: {
          apiKey: "wc_live_personal_xxx",
          webhookHost: "1.2.3.4",
        },
      },
    },
  },
}
```

## FAQ

**Bot cannot receive messages**

1. Ensure `webhookHost` is set to your server’s public IP (or domain).
2. Ensure `webhookPort` is reachable from the internet.
3. Check gateway is running: `openclaw gateway status`.

## Upgrade

```bash
openclaw plugins update wechat
```

## Disclaimer

This plugin is for learning and research only. Do not use for illegal purposes.

## See also

- [Pairing](/channels/pairing) — DM access control
- [Gateway configuration](/gateway/configuration) — Ports and bind
- [Plugins](/tools/plugin) — Install and manage plugins
