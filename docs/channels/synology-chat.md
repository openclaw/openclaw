---
summary: "Synology Chat integration via incoming/outgoing webhooks"
read_when:
  - Working on Synology Chat features or webhooks
title: "Synology Chat"
---

# Synology Chat (Webhook Integration)

Status: ready for daily use with incoming and outgoing webhooks. Uses webhook-based integration for sending and receiving messages.

## Quick setup (beginner)

1. It's recommended to enable 2-factor authentication on your NAS for enhanced mobile app security.
2. Install Synology Chat Server on your Synology NAS and start Synology Chat.
3. Open the Integration feature from the personal icon in the top-right corner of Synology Chat.
4. Add an incoming webhook and a bot in the Integration feature.
5. Configure Synology Chat in OpenClaw.
6. Restart OpenClaw after configuration.

OpenClaw.json minimal configuration example:

```json5
{
  channels: {
    "synology-chat": {
      enabled: true,
      nasIncomingWebhookUrl: "https://your-nas:5000/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=YOUR_TOKEN",
      botName: "openclaw",
      botToken: "your_bot_token",
      incomingWebhookToken: "your_incoming_webhook_token",
      incomingWebhookVerifySsl: true,
      incomingWebhookPath: "/synology-chat",
      port: "9000",
    },
  },
}
```

Where:

- botToken: the bot token from Synology Chat for incoming webhook authentication
- incomingWebhookToken: token for NAS outgoing webhook messages (alternative to botToken mode)
- incomingWebhookVerifySsl: whether to verify SSL certificates for NAS webhooks (set to `false` for self-signed certificates), default is `true`
- incomingWebhookPath: must correspond to the outgoing webhook URL setting on the NAS bot. For example, if the NAS outgoing URL is set to `http://openclaw-ip:9000/synology-chat`, then `incomingWebhookPath` should be set to `/synology-chat`
- port: the listen port for incomingWebhookPath, default value is 9000 when not specified

## Webhook Modes

Two webhook modes are supported:

1. **botToken mode (default)**: Uses `botToken` for authentication. Replies are sent directly via HTTP response.
2. **incomingWebhookToken mode**: Uses `incomingWebhookToken` for NAS outgoing webhook authentication. Replies are sent back to `nasIncomingWebhookUrl`. This mode supports `trigger_word` handling and is useful when the NAS initiates the webhook call.

## Ubuntu Installation Adjustments

When installing the Synology Chat desktop client on Ubuntu 24.04 LTS, you may encounter issues due to spaces in the directory name causing command execution failures. If this occurs, follow these adjustment steps:

1. Rename the installation directory: Change `/opt/Synology Chat` to `/opt/SynologyChat`

2. Update command symlinks:
   - Remove existing symlink: `sudo rm /etc/alternatives/synochat`
   - Create new symlink: `sudo ln -s /opt/SynologyChat/synochat /etc/alternatives/synochat`

3. Fix desktop shortcut (optional, for launching from application menu):
   - Edit `/usr/share/applications/synochat.desktop`
   - Change `Exec=/opt/Synology Chat/synochat` to `Exec=/opt/SynologyChat/synochat`

After completing these adjustments, you can use the `synochat` command to start the application normally, or launch it from the application menu.
