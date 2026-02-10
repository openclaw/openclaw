---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Fast channel level troubleshooting with per channel failure signatures and fixes"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Channel transport says connected but replies fail（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need channel specific checks before deep provider docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Channel Troubleshooting"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Channel troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use this page when a channel connects but behavior is wrong.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Command ladder（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run these in order first:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels status --probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Healthy baseline:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Runtime: running`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `RPC probe: ok`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel probe shows connected/ready（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## WhatsApp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### WhatsApp failure signatures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Symptom                         | Fastest check                                       | Fix                                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------------- | --------------------------------------------------- | ------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Connected but no DM replies     | `openclaw pairing list whatsapp`                    | Approve sender or switch DM policy/allowlist.           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Group messages ignored          | Check `requireMention` + mention patterns in config | Mention the bot or relax mention policy for that group. |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Random disconnect/relogin loops | `openclaw channels status --probe` + logs           | Re-login and verify credentials directory is healthy.   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full troubleshooting: [/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Telegram（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Telegram failure signatures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Symptom                           | Fastest check                                   | Fix                                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------------------------------- | ----------------------------------------------- | --------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `/start` but no usable reply flow | `openclaw pairing list telegram`                | Approve pairing or change DM policy.                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Bot online but group stays silent | Verify mention requirement and bot privacy mode | Disable privacy mode for group visibility or mention bot. |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Send failures with network errors | Inspect logs for Telegram API call failures     | Fix DNS/IPv6/proxy routing to `api.telegram.org`.         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full troubleshooting: [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Discord（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Discord failure signatures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Symptom                         | Fastest check                       | Fix                                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------------- | ----------------------------------- | --------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Bot online but no guild replies | `openclaw channels status --probe`  | Allow guild/channel and verify message content intent.    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Group messages ignored          | Check logs for mention gating drops | Mention bot or set guild/channel `requireMention: false`. |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| DM replies missing              | `openclaw pairing list discord`     | Approve DM pairing or adjust DM policy.                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full troubleshooting: [/channels/discord#troubleshooting](/channels/discord#troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Slack（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Slack failure signatures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Symptom                                | Fastest check                             | Fix                                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------------------------------------- | ----------------------------------------- | ------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Socket mode connected but no responses | `openclaw channels status --probe`        | Verify app token + bot token and required scopes. |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| DMs blocked                            | `openclaw pairing list slack`             | Approve pairing or relax DM policy.               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Channel message ignored                | Check `groupPolicy` and channel allowlist | Allow the channel or switch policy to `open`.     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full troubleshooting: [/channels/slack#troubleshooting](/channels/slack#troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## iMessage and BlueBubbles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### iMessage and BlueBubbles failure signatures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Symptom                          | Fastest check                                                           | Fix                                                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| No inbound events                | Verify webhook/server reachability and app permissions                  | Fix webhook URL or BlueBubbles server state.          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Can send but no receive on macOS | Check macOS privacy permissions for Messages automation                 | Re-grant TCC permissions and restart channel process. |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| DM sender blocked                | `openclaw pairing list imessage` or `openclaw pairing list bluebubbles` | Approve pairing or update allowlist.                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full troubleshooting:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/channels/bluebubbles#troubleshooting](/channels/bluebubbles#troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Signal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Signal failure signatures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Symptom                         | Fastest check                              | Fix                                                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------------- | ------------------------------------------ | -------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Daemon reachable but bot silent | `openclaw channels status --probe`         | Verify `signal-cli` daemon URL/account and receive mode. |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| DM blocked                      | `openclaw pairing list signal`             | Approve sender or adjust DM policy.                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Group replies do not trigger    | Check group allowlist and mention patterns | Add sender/group or loosen gating.                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full troubleshooting: [/channels/signal#troubleshooting](/channels/signal#troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Matrix（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Matrix failure signatures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Symptom                             | Fastest check                                | Fix                                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------------------- | -------------------------------------------- | ----------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Logged in but ignores room messages | `openclaw channels status --probe`           | Check `groupPolicy` and room allowlist.         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| DMs do not process                  | `openclaw pairing list matrix`               | Approve sender or adjust DM policy.             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Encrypted rooms fail                | Verify crypto module and encryption settings | Enable encryption support and rejoin/sync room. |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full troubleshooting: [/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
