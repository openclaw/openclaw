---
summary: "Choose the right setup flow for every OpenClaw chat channel"
read_when:
  - You want the minimum working config for a channel
  - You are deciding between token, webhook, QR, and external client channels
title: "Channel Configuration Guides"
---

# Channel Configuration Guides

<Note>
These are discovery pages. The canonical configuration docs live on the channel pages in [Chat Channels](/channels).
</Note>

OpenClaw channels live under `channels.<provider>` in `~/.openclaw/openclaw.json`.
The fastest way to configure them is to pick the setup model that matches the channel you want.

<CardGroup cols={2}>
  <Card title="Bot tokens and QR login" icon="key" href="/gateway/channel-configuration-bot-tokens-and-qr">
    WhatsApp, Telegram, Discord, Slack, Mattermost, Twitch, Zalo, and Zalo Personal.
  </Card>
  <Card title="Webhooks and app credentials" icon="globe" href="/gateway/channel-configuration-webhooks-and-apps">
    BlueBubbles, Google Chat, LINE, Feishu, Microsoft Teams, Nextcloud Talk, and Synology Chat.
  </Card>
  <Card title="Account logins and self hosted channels" icon="user-circle" href="/gateway/channel-configuration-account-logins">
    Matrix, Nostr, and Tlon.
  </Card>
  <Card title="External clients and legacy integrations" icon="terminal" href="/gateway/channel-configuration-external-clients">
    Signal, iMessage, and IRC.
  </Card>
</CardGroup>

## Shared access policy pattern

Most channels use the same DM and group policy shape even when the credential fields differ.

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",        // pairing | allowlist | open | disabled
      allowFrom: ["123456789"],    // sender IDs, handles, or phone numbers by channel
      groupPolicy: "allowlist",    // open | allowlist | disabled
      groupAllowFrom: ["123456789"],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
}
```

Use the channel specific guide below to fill in the credential keys and setup steps.

## Channel matrix

| Channel | Config path | Setup model | Plugin | Guide | Details |
| --- | --- | --- | --- | --- | --- |
| BlueBubbles | `channels.bluebubbles` | webhook + app server | bundled plugin | [Webhooks and app credentials](/gateway/channel-configuration-webhooks-and-apps#bluebubbles) | [BlueBubbles](/channels/bluebubbles) |
| Discord | `channels.discord` | bot token | built in | [Bot tokens and QR login](/gateway/channel-configuration-bot-tokens-and-qr#discord) | [Discord](/channels/discord) |
| Feishu | `channels.feishu` | app credentials | plugin | [Webhooks and app credentials](/gateway/channel-configuration-webhooks-and-apps#feishu) | [Feishu](/channels/feishu) |
| Google Chat | `channels.googlechat` | service account + webhook | built in | [Webhooks and app credentials](/gateway/channel-configuration-webhooks-and-apps#google-chat) | [Google Chat](/channels/googlechat) |
| iMessage | `channels.imessage` | external client | built in legacy | [External clients and legacy integrations](/gateway/channel-configuration-external-clients#imessage) | [iMessage](/channels/imessage) |
| IRC | `channels.irc` | external client | plugin | [External clients and legacy integrations](/gateway/channel-configuration-external-clients#irc) | [IRC](/channels/irc) |
| LINE | `channels.line` | webhook + app credentials | plugin | [Webhooks and app credentials](/gateway/channel-configuration-webhooks-and-apps#line) | [LINE](/channels/line) |
| Matrix | `channels.matrix` | account login | plugin | [Account logins and self hosted channels](/gateway/channel-configuration-account-logins#matrix) | [Matrix](/channels/matrix) |
| Mattermost | `channels.mattermost` | bot token | plugin | [Bot tokens and QR login](/gateway/channel-configuration-bot-tokens-and-qr#mattermost) | [Mattermost](/channels/mattermost) |
| Microsoft Teams | `channels.msteams` | app credentials + webhook | plugin | [Webhooks and app credentials](/gateway/channel-configuration-webhooks-and-apps#microsoft-teams) | [Microsoft Teams](/channels/msteams) |
| Nextcloud Talk | `channels.nextcloud-talk` | webhook + bot secret | plugin | [Webhooks and app credentials](/gateway/channel-configuration-webhooks-and-apps#nextcloud-talk) | [Nextcloud Talk](/channels/nextcloud-talk) |
| Nostr | `channels.nostr` | account login | plugin | [Account logins and self hosted channels](/gateway/channel-configuration-account-logins#nostr) | [Nostr](/channels/nostr) |
| Signal | `channels.signal` | external client | built in | [External clients and legacy integrations](/gateway/channel-configuration-external-clients#signal) | [Signal](/channels/signal) |
| Slack | `channels.slack` | bot token | built in | [Bot tokens and QR login](/gateway/channel-configuration-bot-tokens-and-qr#slack) | [Slack](/channels/slack) |
| Synology Chat | `channels.synology-chat` | webhook + incoming URL | plugin | [Webhooks and app credentials](/gateway/channel-configuration-webhooks-and-apps#synology-chat) | [Synology Chat](/channels/synology-chat) |
| Telegram | `channels.telegram` | bot token | built in | [Bot tokens and QR login](/gateway/channel-configuration-bot-tokens-and-qr#telegram) | [Telegram](/channels/telegram) |
| Tlon | `channels.tlon` | account login | plugin | [Account logins and self hosted channels](/gateway/channel-configuration-account-logins#tlon) | [Tlon](/channels/tlon) |
| Twitch | `channels.twitch` | bot token | plugin | [Bot tokens and QR login](/gateway/channel-configuration-bot-tokens-and-qr#twitch) | [Twitch](/channels/twitch) |
| WhatsApp | `channels.whatsapp` | QR login | built in | [Bot tokens and QR login](/gateway/channel-configuration-bot-tokens-and-qr#whatsapp) | [WhatsApp](/channels/whatsapp) |
| Zalo | `channels.zalo` | bot token | plugin | [Bot tokens and QR login](/gateway/channel-configuration-bot-tokens-and-qr#zalo) | [Zalo](/channels/zalo) |
| Zalo Personal | `channels.zalouser` | QR login | plugin | [Bot tokens and QR login](/gateway/channel-configuration-bot-tokens-and-qr#zalo-personal) | [Zalo Personal](/channels/zalouser) |

## Next step

- Need a copy paste starter for a specific channel: open the matching guide above.
- Need the full operational behavior for one channel: jump to the linked channel page in [Chat Channels](/channels).
- Need every config field: use the [Configuration reference](/gateway/configuration-reference).