---
summary: "Fast channel level troubleshooting with per channel failure signatures and fixes"
read_when:
  - Channel transport says connected but replies fail
  - You need channel specific checks before deep provider docs
title: "Channel Troubleshooting"
---

# Channel troubleshooting

Use this page when a channel connects but behavior is wrong.

## Command ladder

Run these in order first:

```bash
mullusi status
mullusi gateway status
mullusi logs --follow
mullusi doctor
mullusi channels status --probe
```

Healthy baseline:

- `Runtime: running`
- `RPC probe: ok`
- Channel probe shows transport connected and, where supported, `works` or `audit ok`

## WhatsApp

### WhatsApp failure signatures

| Symptom                         | Fastest check                                       | Fix                                                     |
| ------------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| Connected but no DM replies     | `mullusi pairing list whatsapp`                    | Approve sender or switch DM policy/allowlist.           |
| Group messages ignored          | Check `requireMention` + mention patterns in config | Mention the bot or relax mention policy for that group. |
| Random disconnect/relogin loops | `mullusi channels status --probe` + logs           | Re-login and verify credentials directory is healthy.   |

Full troubleshooting: [/channels/whatsapp#troubleshooting](/channels/whatsapp#troubleshooting)

## Telegram

### Telegram failure signatures

| Symptom                             | Fastest check                                   | Fix                                                                         |
| ----------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------- |
| `/start` but no usable reply flow   | `mullusi pairing list telegram`                | Approve pairing or change DM policy.                                        |
| Bot online but group stays silent   | Verify mention requirement and bot privacy mode | Disable privacy mode for group visibility or mention bot.                   |
| Send failures with network errors   | Inspect logs for Telegram API call failures     | Fix DNS/IPv6/proxy routing to `api.telegram.org`.                           |
| `setMyCommands` rejected at startup | Inspect logs for `BOT_COMMANDS_TOO_MUCH`        | Reduce plugin/skill/custom Telegram commands or disable native menus.       |
| Upgraded and allowlist blocks you   | `mullusi security audit` and config allowlists | Run `mullusi doctor --fix` or replace `@username` with numeric sender IDs. |

Full troubleshooting: [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Discord failure signatures

| Symptom                         | Fastest check                       | Fix                                                       |
| ------------------------------- | ----------------------------------- | --------------------------------------------------------- |
| Bot online but no guild replies | `mullusi channels status --probe`  | Allow guild/channel and verify message content intent.    |
| Group messages ignored          | Check logs for mention gating drops | Mention bot or set guild/channel `requireMention: false`. |
| DM replies missing              | `mullusi pairing list discord`     | Approve DM pairing or adjust DM policy.                   |

Full troubleshooting: [/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Slack failure signatures

| Symptom                                | Fastest check                             | Fix                                                                                                                                                  |
| -------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Socket mode connected but no responses | `mullusi channels status --probe`        | Verify app token + bot token and required scopes; watch for `botTokenStatus` / `appTokenStatus = configured_unavailable` on SecretRef-backed setups. |
| DMs blocked                            | `mullusi pairing list slack`             | Approve pairing or relax DM policy.                                                                                                                  |
| Channel message ignored                | Check `groupPolicy` and channel allowlist | Allow the channel or switch policy to `open`.                                                                                                        |

Full troubleshooting: [/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessage and BlueBubbles

### iMessage and BlueBubbles failure signatures

| Symptom                          | Fastest check                                                           | Fix                                                   |
| -------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| No inbound events                | Verify webhook/server reachability and app permissions                  | Fix webhook URL or BlueBubbles server state.          |
| Can send but no receive on macOS | Check macOS privacy permissions for Messages automation                 | Re-grant TCC permissions and restart channel process. |
| DM sender blocked                | `mullusi pairing list imessage` or `mullusi pairing list bluebubbles` | Approve pairing or update allowlist.                  |

Full troubleshooting:

- [/channels/imessage#troubleshooting](/channels/imessage#troubleshooting)
- [/channels/bluebubbles#troubleshooting](/channels/bluebubbles#troubleshooting)

## Signal

### Signal failure signatures

| Symptom                         | Fastest check                              | Fix                                                      |
| ------------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| Daemon reachable but bot silent | `mullusi channels status --probe`         | Verify `signal-cli` daemon URL/account and receive mode. |
| DM blocked                      | `mullusi pairing list signal`             | Approve sender or adjust DM policy.                      |
| Group replies do not trigger    | Check group allowlist and mention patterns | Add sender/group or loosen gating.                       |

Full troubleshooting: [/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## QQ Bot

### QQ Bot failure signatures

| Symptom                         | Fastest check                               | Fix                                                             |
| ------------------------------- | ------------------------------------------- | --------------------------------------------------------------- |
| Bot replies "gone to Mars"      | Verify `appId` and `clientSecret` in config | Set credentials or restart the gateway.                         |
| No inbound messages             | `mullusi channels status --probe`          | Verify credentials on the QQ Open Platform.                     |
| Voice not transcribed           | Check STT provider config                   | Configure `channels.qqbot.stt` or `tools.media.audio`.          |
| Proactive messages not arriving | Check QQ platform interaction requirements  | QQ may block bot-initiated messages without recent interaction. |

Full troubleshooting: [/channels/qqbot#troubleshooting](/channels/qqbot#troubleshooting)

## Matrix

### Matrix failure signatures

| Symptom                             | Fastest check                          | Fix                                                                       |
| ----------------------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| Logged in but ignores room messages | `mullusi channels status --probe`     | Check `groupPolicy`, room allowlist, and mention gating.                  |
| DMs do not process                  | `mullusi pairing list matrix`         | Approve sender or adjust DM policy.                                       |
| Encrypted rooms fail                | `mullusi matrix verify status`        | Re-verify the device, then check `mullusi matrix verify backup status`.  |
| Backup restore is pending/broken    | `mullusi matrix verify backup status` | Run `mullusi matrix verify backup restore` or rerun with a recovery key. |
| Cross-signing/bootstrap looks wrong | `mullusi matrix verify bootstrap`     | Repair secret storage, cross-signing, and backup state in one pass.       |

Full setup and config: [Matrix](/channels/matrix)
