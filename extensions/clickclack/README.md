# ClickClack OpenClaw channel

Official OpenClaw channel plugin for ClickClack.

## Install

```sh
openclaw plugins install @openclaw/clickclack
```

## Command menus

ClickClack command menus are enabled by default. At gateway startup, the
extension publishes OpenClaw's native commands for composer autocomplete,
labeled with the bot's handle. The bot token must include `commands:write`;
current `bot:write` and `bot:admin` bundles include it.

Set `commandMenu: false` on an account to disable menu sync. Sync failures do
not prevent the gateway from starting, so older tokens and ClickClack servers
continue to work without a menu.

## Docs

See `docs/channels/clickclack.md` in the OpenClaw repository, or the published docs at `https://docs.openclaw.ai/channels/clickclack`.
