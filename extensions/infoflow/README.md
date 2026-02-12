# @openclaw/infoflow

Baidu Infoflow (如流) channel plugin for OpenClaw.

## Install (local checkout)

```bash
openclaw plugins install ./extensions/infoflow
```

## Install (npm)

```bash
openclaw plugins install @openclaw/infoflow
```

## Config

```json5
{
  channels: {
    infoflow: {
      enabled: true,
      apiHost: "https://api.infoflow.baidu.com",
      check_token: "your-check-token",
      encodingAESKey: "your-encoding-aes-key",
      appKey: "your-app-key",
      appSecret: "your-app-secret",
      dmPolicy: "open", // "open" | "pairing" | "allowlist"
      groupPolicy: "open", // "open" | "allowlist" | "disabled"
      requireMention: true, // Bot only responds when @mentioned in groups
      robotName: "YourBotName", // Required for @mention detection
    },
  },
}
```

## Multi-account support

```json5
{
  channels: {
    infoflow: {
      enabled: true,
      accounts: {
        work: {
          check_token: "token-1",
          encodingAESKey: "key-1",
          appKey: "app-key-1",
          appSecret: "secret-1",
        },
        personal: {
          check_token: "token-2",
          encodingAESKey: "key-2",
          appKey: "app-key-2",
          appSecret: "secret-2",
        },
      },
      defaultAccount: "work",
    },
  },
}
```

## Webhook

Configure your Infoflow bot webhook URL to:
`https://your-domain/webhook/infoflow`

Restart the gateway after config changes.
