# Telegram

Talk to OpenClaw through a Telegram bot in direct messages, groups, channels, and
topics. The plugin supports media, voice notes, reactions, polls, and native
commands.

## Get started

Create a bot with **@BotFather**, then add Telegram using `openclaw channels add`
and provide the bot token. Verify the connection with
`openclaw channels status --probe`.

Send your bot a message, then approve the resulting pairing request. Group
access uses separate allowlists and mention settings; configure these before
using the bot in a group.

Follow the [Telegram setup guide](https://docs.openclaw.ai/channels/telegram/setup)
for bot creation, pairing, and group permissions.

## Upgrade legacy ingress state

Update-time Doctor and startup migration import remaining
`telegram/ingress-spool-<account>/*.json` and `.json.processing` files into SQLite
ingress. Pending updates retain their payload and receipt timestamp; old process
claims return to pending replay. `.json.failed` files remain failed tombstones
with their original failure time and are never automatically replayed.

Doctor backs up exact source bytes as `.migrated` files before normalization.
Import receipts prevent duplicate replay after an interrupted cleanup, including
after the corresponding queue rows have been consumed or pruned. Conflicting or
malformed sources remain intact with a diagnostic; resolve the reported conflict
and run `openclaw doctor --fix`. Keep the backups for recovery.
Verified cleanup-only failures warn without blocking an upgrade.

Plugin developers can follow the
[Doctor ingress migration contract](https://docs.openclaw.ai/plugins/sdk-migration/how-to-migrate#migrate-durable-ingress-files-through-doctor).
