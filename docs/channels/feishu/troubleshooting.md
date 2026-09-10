---
summary: "Silent Feishu bots, missing events, QR setup failures, and leaked App Secrets"
read_when:
  - The Feishu bot does not answer in a group or a DM
  - Meeting invite auto-join is not working
  - Rotating a leaked App Secret
title: "Feishu troubleshooting"
sidebarTitle: "Troubleshooting"
---

Diagnostics for a Feishu bot that does not respond, does not receive events, or needs its credentials rotated.

## Troubleshooting

### Bot does not respond in group chats

1. Ensure the bot is added to the group
2. Ensure you @mention the bot (required by default)
3. Verify `groupPolicy` is not `"disabled"`
4. Check logs: `openclaw logs --follow`

### Bot does not receive messages

1. Ensure the bot is published and approved in Feishu Open Platform / Lark Developer
2. Ensure event subscription includes `im.message.receive_v1`
3. For meeting invite auto-join, also subscribe to `vc.bot.meeting_invited_v1`
4. Ensure **persistent connection** (WebSocket) is selected
5. Ensure all required permission scopes are granted
6. Ensure the gateway is running: `openclaw gateway status`
7. Check logs: `openclaw logs --follow`

Subscribing to `vc.bot.meeting_invited_v1` only delivers the event. Automatic joins are
default-off. To enable them globally:

```json5
{
  channels: {
    feishu: {
      vcAutoJoin: true,
    },
  },
}
```

To enable only one account, omit the top-level switch and set the account override:

```json5
{
  channels: {
    feishu: {
      accounts: {
        meetings: { vcAutoJoin: true },
      },
    },
  },
}
```

Inviters still pass through the normal Feishu DM policy, allowlist/pairing, session, and reply
routing before the agent receives a join turn. Joining also requires an available Feishu VC join
tool configured for app identity with the
`vc:meeting.bot.join:write` scope. For example, the official
[`lark-cli` VC agent skill](https://github.com/larksuite/cli/tree/main/skills/lark-vc-agent)
provides `vc +meeting-join`.

<Warning>
The official `lark-cli` VC agent skill currently marks meeting-bot actions as a limited beta. If the tool returns `ErrNotInGray` or error code `20017`, the app or tenant has not been enabled for that beta; use the early-access guidance in the linked skill before troubleshooting ordinary scope grants.
</Warning>

### QR setup does not react in the Feishu mobile app

1. Rerun setup: `openclaw channels login --channel feishu`
2. Choose manual setup
3. In Feishu Open Platform, create a self-built app and copy its App ID and App Secret
4. Paste those credentials into the setup wizard

### App Secret leaked

1. Reset the App Secret in Feishu Open Platform / Lark Developer
2. Update the value in your config
3. Restart the gateway: `openclaw gateway restart`
