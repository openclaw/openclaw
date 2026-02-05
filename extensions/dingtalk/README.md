# DingTalk (plugin)

Official DingTalk (钉钉) channel plugin for OpenClaw, using the DingTalk Stream API.

Docs: https://docs.openclaw.ai/channels/dingtalk

## Install

```bash
openclaw plugins install @openclaw/dingtalk
```

Local checkout (when working from source):

```bash
openclaw plugins install ./extensions/dingtalk
```

## Configure

Edit `~/.openclaw/openclaw.json`:

```json5
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "clientId": "ding***",
      "clientSecret": "***"
    }
  }
}
```

Then start the gateway:

```bash
openclaw gateway
```
